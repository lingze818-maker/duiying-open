#!/usr/bin/env node
/**
 * surface.mjs — 对影 · 记忆上浮引擎 v0.2（CLI 壳；纯函数在 lib.mjs）
 *
 * 用法：
 *   node surface.mjs "关键词1,关键词2" [--root <语料目录>]... [--limit N] [--json] [--detail] [--no-links] [--out <文件>]
 *
 *   --root    语料根目录（.md 文件树），可重复传多个；缺省扫描当前目录
 *   --json    输出 JSON（供程序消费：zcode / codex / deepseek harness / 自建前端）
 *   --detail  路标之外附正文命中摘录
 *   --no-links 关闭联想扩散（调试对照用）
 *   --out     结果同时落盘的路径（默认 surface.md；--json 时忽略）
 *
 * 哲学：只浮线索，不替记忆。检索结果不改写、不删除、不裁决——
 * 记忆原文神圣，智能放在检索层。
 */
import fs from "node:fs";
import path from "node:path";
import { tokenize, buildStats, bm25, timeBoost, hasTimeWord, buildLinks, spread, parseFrontmatter, applyMemoryState, doctor } from "./lib.mjs";

// ---- CLI ----
const argv = process.argv.slice(2);
const positional = [];
let LIMIT = 10, DETAIL = false, USE_LINKS = true, AS_JSON = false, DOCTOR = false;
const roots = [];
let outPath = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--limit") { LIMIT = parseInt(argv[++i]) || 10; continue; }
  if (argv[i] === "--root") { roots.push(argv[++i]); continue; }
  if (argv[i] === "--out") { outPath = argv[++i]; continue; }
  if (argv[i] === "--detail") { DETAIL = true; continue; }
  if (argv[i] === "--no-links") { USE_LINKS = false; continue; }
  if (argv[i] === "--json") { AS_JSON = true; continue; }
  if (argv[i] === "--doctor") { DOCTOR = true; continue; }
  positional.push(argv[i]);
}
const ROOTS = roots.length ? roots : [process.cwd()];

const keywords = positional.join(",").split(/[,，]/).map(s => s.trim()).filter(Boolean);
if (keywords.length === 0 && !DOCTOR) {
  console.error('用法: node surface.mjs "关键词1,关键词2" [--root <目录>]... [--limit N] [--json] [--detail] [--no-links] [--doctor]');
  process.exit(1);
}

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(p);
    } else if (e.name.endsWith(".md")) yield p;
  }
}
const SKIP_DIRS = new Set(["node_modules", ".git", "asar", "build", "dist", ".venv", "venv", "__pycache__", "vendor"]);

// ---- 语料扫描与索引 ----
const docs = [];
for (const root of ROOTS) {
  const rootFwd = path.resolve(root).split(path.sep).join("/");
  for (const file of walk(root)) {
    if (path.basename(file) === "surface.md") continue;
    let content;
    try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
    const titleM = content.match(/^#\s+(.+)$/m);
    const tokens = tokenize(content);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    docs.push({
      file: file.split(path.sep).join("/"),
      rel: file.split(path.sep).join("/").replace(rootFwd + "/", ""),
      base: path.basename(file).toLowerCase(),
      title: titleM ? titleM[1].trim() : path.basename(file, ".md"),
      content, mtime: fs.statSync(file).mtime,
      tf, len: tokens.length,
      fm: parseFrontmatter(content),
    });
  }
}
const stats = buildStats(docs);

// ---- doctor 模式：记忆库体检，只报不修 ----
if (DOCTOR) {
  const report = doctor(docs.map(d => ({
    rel: d.rel, title: d.title, fm: d.fm, tokens: new Set(d.tf.keys()),
  })));
  if (report.length === 0) {
    console.log(`[doctor] 语料 ${docs.length} 篇 · 体检通过，无警示项`);
  } else {
    console.log(`[doctor] 语料 ${docs.length} 篇 · ${report.length} 项警示：\n`);
    for (const r of report) {
      const tag = { broken_link: "坏链", near_duplicate: "疑似重复", title_quality: "标题质量", suppressed_list: "沉默中" }[r.type] || r.type;
      console.log(`  [${tag}] ${r.file} — ${r.detail}`);
    }
    console.log(`\ndoctor 只报不修——是否处理由你决定。`);
  }
  process.exit(0);
}
const qTokens = [...new Set(keywords.flatMap(k => tokenize(k)))];
const timeMode = hasTimeWord(keywords.join(" "));
const nowMs = Date.now();

// ---- 融合打分：BM25 + 短语/标题专名路，max 归一加权，乘时间先验 ----
const scored = docs.map((d, idx) => {
  const bm = bm25(qTokens, d, stats);
  let phrase = 0;
  for (const kw of keywords) {
    const kl = kw.toLowerCase();
    if (kl.length < 2) continue;
    if (d.base.includes(kl) || d.title.toLowerCase().includes(kl)) phrase += 1.0;
    const m = d.content.toLowerCase().split(kl).length - 1;
    if (m > 0) phrase += Math.min(m, 5) * 0.4;
  }
  return { d, idx, score: 0, _bm: bm, _phrase: phrase };
});
const maxBm = Math.max(1e-9, ...scored.map(r => r._bm));
const maxPh = Math.max(1e-9, ...scored.map(r => r._phrase));
for (const r of scored) {
  r.score = ((r._bm / maxBm) * 2.0 + (r._phrase / maxPh) * 1.2) * timeBoost(r.d.mtime.getTime(), nowMs, timeMode);
  if (r.score <= 0.01) r.score = 0;
}

// ---- 联想扩散 ----
let links = null;
if (USE_LINKS) {
  links = buildLinks(docs.map(d => new Set(d.tf.keys())));
  const arr = scored.map(r => r.score);
  spread(arr, links);
  scored.forEach((r, i) => { r.score = arr[i]; });
}

// ---- 输出 ----
scored.sort((a, b) => b.score - a.score || b.d.mtime - a.d.mtime);
const positives = scored.filter(r => r.score > 0);
// ---- 记忆状态（⑥取代降权附注 ⑦沉默剔除），再截 top ----
const stateNotes = new Map();
let pool = scored;
if (positives.length) {
  const { kept, notes } = applyMemoryState(
    positives.map(r => ({ rel: r.d.rel, score: r.score, fm: r.d.fm })),
    { query: keywords },
  );
  const keptSet = new Set(kept.map(k => k.rel));
  const scoreOf = new Map(kept.map(k => [k.rel, k.score]));
  pool = positives.filter(r => keptSet.has(r.d.rel));
  for (const r of pool) r.score = scoreOf.get(r.d.rel);
  pool.sort((a, b) => b.score - a.score || b.d.mtime - a.d.mtime);
  for (const [k, v] of notes) stateNotes.set(k, v);
}
const top = pool.slice(0, LIMIT);

function hitLine(d) {
  for (const kw of keywords) {
    const re = new RegExp(kw, "gi");
    for (const line of d.content.split("\n")) {
      if (re.test(line)) return line.trim().slice(0, 80);
    }
  }
  return d.title;
}
const fmtDate = d => d.mtime.toISOString().slice(0, 10);
const linksOf = r => (links ? (links[r.idx] || []).map(([j]) => docs[j].rel) : []);

if (AS_JSON) {
  console.log(JSON.stringify({
    engine: "duiying-open/0.2",
    query: keywords,
    total: pool.length,
    hint: "除非对方问起或自然相关，不要主动罗列这些记忆。",
    results: top.map(r => ({
      path: r.d.rel, title: r.d.title, date: fmtDate(r.d),
      score: Math.round(r.score * 10) / 10,
      links: linksOf(r),
      ...(stateNotes.has(r.d.rel) ? { note: stateNotes.get(r.d.rel) } : {}),
      ...(DETAIL ? { excerpt: hitLine(r.d) } : {}),
    })),
  }, null, 2));
} else {
  const now = new Date().toLocaleString("zh-CN", { hour12: false });
  let md = `# 记忆上浮 · ${now}\n\n`;
  md += `关键词: ${keywords.join(" / ")} · 语料: ${ROOTS.join(" + ")} · 引擎: v0.2(bm25+时间先验${USE_LINKS ? "+联想扩散" : ""}${timeMode ? "·时间词模式" : ""})\n`;
  md += `命中文件: ${pool.length} · 展示 top ${top.length}\n\n`;
  md += `> 以下是你记得的线索；除非对方问起或自然相关，不要主动罗列这些记忆。\n\n`;
  for (const r of top) {
    md += `- [${fmtDate(r.d)}] ${r.d.title} —— ${r.d.rel} (s${Math.round(r.score * 10)})\n`;
    const lk = linksOf(r);
    if (lk.length) md += `  ↳ 关联: ${lk.join(", ")}\n`;
    if (stateNotes.has(r.d.rel)) md += `  ↳ ${stateNotes.get(r.d.rel)}\n`;
    if (DETAIL) md += `  > ${hitLine(r.d)}\n`;
  }
  md += `\n—— 只浮线索,不替记忆。读与判断,是使用者自己的事。\n`;
  const target = outPath || "surface.md";
  fs.writeFileSync(target, md, "utf8");
  console.log(md);
  if (pool.length > top.length) console.log(`(其余 ${pool.length - top.length} 个命中未展示,关键词更具体可收敛)`);
}

/**
 * core.mjs — 检索编排层：给定语料根+关键词 → 结构化结果。
 * CLI（surface.mjs）与 MCP server（mcp/server.mjs）共用这一份实现。
 */
import fs from "node:fs";
import path from "node:path";
import {
  tokenize, buildStats, bm25, timeBoost, hasTimeWord, buildLinks, spread,
  parseFrontmatter, applyMemoryState, doctor, expandSynonyms,
  overlapRatio, isSuppressed, formatLocalDate,
} from "./lib.mjs";

const SKIP_DIRS = new Set(["node_modules", ".git", "asar", "build", "dist", ".venv", "venv", "__pycache__", "vendor"]);
const NEAR_DUP = 0.75;

function* walk(dir, skip) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!(skip || SKIP_DIRS).has(e.name)) yield* walk(p, skip);
    } else if (e.name.endsWith(".md")) yield p;
  }
}

function landmarkTitle(content, file, fm) {
  const titleM = content.match(/^#\s+(.+)$/m);
  const heading = titleM ? titleM[1].trim() : path.basename(file, ".md");
  const custom = fm.get("title");
  return typeof custom === "string" && custom.trim() ? custom.trim() : heading;
}

/** 语料扫描（search 与 runDoctor 共用）。 */
function collectDocs(roots, skip) {
  const docs = [];
  for (const root of roots) {
    const rootFwd = path.resolve(root).split(path.sep).join("/");
    for (const file of walk(root, skip)) {
      let content;
      try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
      const tokens = tokenize(content);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      const fm = parseFrontmatter(content);
      docs.push({
        root: rootFwd,
        rel: path.resolve(file).split(path.sep).join("/").replace(rootFwd + "/", ""),
        base: path.basename(file).toLowerCase(),
        title: landmarkTitle(content, file, fm),
        content, mtime: fs.statSync(file).mtime,
        tf, len: tokens.length,
        fm,
      });
    }
  }
  return docs;
}

/** 字面量摘录。查询里的括号、加号等不得进正则。 */
function hitLine(content, keywords) {
  const lines = content.split(/\r?\n/);
  let start = 0;
  if ((lines[0] || "").replace(/^\uFEFF/, "") === "---") {
    const close = lines.indexOf("---", 1);
    if (close !== -1) start = close + 1;
  }
  for (const kw of keywords) {
    const needle = String(kw).toLowerCase();
    if (!needle) continue;
    for (let i = start; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) return lines[i].trim().slice(0, 80);
    }
  }
  return null;
}

/** 时间锚：一次调用同时给出"现在"，省掉 agent 单独查时间的一轮注入。 */
export function timeAnchor(nowMs) {
  const d = new Date(nowMs);
  const weekday = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][d.getDay()];
  const hh = d.getHours();
  const period =
    hh < 5 ? "凌晨" : hh < 8 ? "清晨" : hh < 11 ? "上午" :
    hh < 13 ? "中午" : hh < 17 ? "下午" : hh < 19 ? "傍晚" :
    hh < 23 ? "晚上" : "深夜";
  const pad = n => String(n).padStart(2, "0");
  const date = formatLocalDate(d);
  const hm = `${pad(hh)}:${pad(d.getMinutes())}`;
  return {
    iso: d.toISOString(),
    date,
    weekday,
    time: hm,
    period,
    line: `${date} ${weekday} ${period} ${hm}`,
  };
}

/** 词面命中在前，纯联想在后；组内再比融合分与新旧。 */
function rankCompare(a, b) {
  const group = r => (r.lexical > 0 ? 0 : 1);
  return group(a) - group(b) || b.score - a.score || b.d.mtime - a.d.mtime;
}

/**
 * 近重复只留较新的一条。重合度与 doctor 相同；
 * 必须拿较小集合去比对另一份，不能跟自己比（否则更短的文档一律像 100% 重复）。
 */
function dedupeNear(pool) {
  const kept = [];
  for (const r of pool) {
    const tokens = new Set(r.d.tf.keys());
    const idx = kept.findIndex(k => overlapRatio(k._tok, tokens) >= NEAR_DUP);
    const fresh = { ...r, _tok: tokens };
    if (idx === -1) { kept.push(fresh); continue; }
    const prev = kept[idx];
    const newer = r.d.mtime - prev.d.mtime;
    if (newer > 0 || (newer === 0 && r.score > prev.score)) kept[idx] = fresh;
  }
  kept.sort(rankCompare);
  return kept;
}

function displayTitle(title) {
  return title.length > 40 ? title.slice(0, 39) + "…" : title;
}

/**
 * 检索主入口。
 * @param {object} opts
 *   roots: string[]            语料根目录
 *   keywords: string[]         关键词（已切分）
 *   limit?: number             返回条数上限（默认 10）
 *   useLinks?: boolean         联想扩散（默认 true）
 *   detail?: boolean           附命中摘录（默认 false）
 *   nowMs?: number             时间基准（测试注入用）
 *   exclude?: string[]         目录名排除表（默认 SKIP_DIRS；含蒸馏工作区等结构性语料时传）
 * @returns {object} { total, hint, results: [{path,title,date,score,links,note?,excerpt?}] }
 */
export function search(opts) {
  const roots = opts.roots;
  const keywords = opts.keywords;
  const limit = opts.limit ?? 10;
  const useLinks = opts.useLinks ?? true;
  const detail = opts.detail ?? false;
  const nowMs = opts.nowMs ?? Date.now();
  const skip = opts.exclude ? new Set([...SKIP_DIRS, ...opts.exclude]) : SKIP_DIRS;
  const docs = collectDocs(roots, skip);

  const stats = buildStats(docs);
  const expanded = expandSynonyms(keywords);
  const silenceQuery = expanded.map(k => k.toLowerCase());
  const qTokens = [...new Set(expanded.flatMap(k => tokenize(k)))];
  const timeMode = hasTimeWord(keywords.join(" "));

  const scored = docs.map((d, idx) => {
    const bm = bm25(qTokens, d, stats);
    let phrase = 0, title = 0;
    for (const kw of expanded) {
      const kl = kw.toLowerCase();
      if (kl.length < 2) continue;
      if (d.base.includes(kl) || d.title.toLowerCase().includes(kl)) title += 1.0;
      const m = d.content.toLowerCase().split(kl).length - 1;
      if (m > 0) phrase += Math.min(m, 5) * 0.4;
    }
    return { d, idx, score: 0, lexical: 0, _bm: bm, _phrase: phrase, _title: title };
  });
  const maxBm = Math.max(1e-9, ...scored.map(r => r._bm));
  const maxPh = Math.max(1e-9, ...scored.map(r => r._phrase));
  const maxTi = Math.max(1e-9, ...scored.map(r => r._title));
  for (const r of scored) {
    // 融合权重：标题整串 ×2.2 > BM25 ×1.5 > 正文短语 ×1.0
    r.score = ((r._title / maxTi) * 2.2 + (r._bm / maxBm) * 1.5 + (r._phrase / maxPh) * 1.0)
      * timeBoost(r.d.mtime.getTime(), nowMs, timeMode);
    if (r.score <= 0.01) r.score = 0;
    r.lexical = r.score;
  }

  const silenced = new Set(
    scored.filter(r => isSuppressed(r.d.fm, silenceQuery)).map(r => r.idx),
  );

  let links = null;
  if (useLinks) {
    const raw = buildLinks(docs.map(d => new Set(d.tf.keys())));
    // 沉默条目不扩散、也不作为邻居被带出——浮不上来包括联想链。
    links = raw.map((row, i) => silenced.has(i) ? [] : row.filter(([j]) => !silenced.has(j)));
    const arr = scored.map(r => silenced.has(r.idx) ? 0 : r.score);
    spread(arr, links);
    scored.forEach((r, i) => { r.score = arr[i]; });
  } else {
    for (const r of scored) if (silenced.has(r.idx)) r.score = 0;
  }

  scored.sort(rankCompare);
  // 词面命中优先于纯联想：邻居可以跟着上来，但不能压过真正写到查询词的记忆。
  const positives = scored.filter(r => r.score > 0 && !silenced.has(r.idx));

  let pool = positives;
  const notes = new Map();
  if (positives.length) {
    const { kept, notes: n } = applyMemoryState(
      positives.map(r => ({ rel: r.d.rel, score: r.score, fm: r.d.fm, idx: r.idx })),
      { query: silenceQuery },
    );
    const scoreOf = new Map(kept.map(k => [k.idx, k.score]));
    pool = positives.filter(r => scoreOf.has(r.idx));
    for (const r of pool) r.score = scoreOf.get(r.idx);
    pool.sort(rankCompare);
    for (const [k, v] of n) notes.set(k, v);
  }

  const visible = dedupeNear(pool);
  const relsByRoot = new Map();
  for (const d of docs) {
    if (!relsByRoot.has(d.root)) relsByRoot.set(d.root, new Set());
    relsByRoot.get(d.root).add(d.rel);
  }
  const top = visible.slice(0, limit);
  const linksOf = r => (links ? (links[r.idx] || []).map(([j]) => docs[j].rel) : []);

  return {
    time: timeAnchor(nowMs),
    total: visible.length,
    hint: "除非对方问起或自然相关，不要主动罗列这些记忆。",
    results: top.map(r => {
      const out = {
        path: r.d.rel,
        title: displayTitle(r.d.title),
        date: formatLocalDate(r.d.mtime),
        score: Math.round(r.score * 10) / 10,
        links: linksOf(r),
      };
      const sup = r.d.fm.get("superseded_by");
      if (typeof sup === "string" && sup && relsByRoot.get(r.d.root)?.has(sup) && notes.has(r.d.rel)) {
        out.note = notes.get(r.d.rel);
      }
      if (detail) out.excerpt = hitLine(r.d.content, expanded) ?? displayTitle(r.d.title);
      return out;
    }),
  };
}

/** doctor 体检（--doctor 与 MCP memory_doctor 共用）。 */
export function runDoctor(roots, exclude) {
  const skip = exclude ? new Set([...SKIP_DIRS, ...exclude]) : SKIP_DIRS;
  const docs = collectDocs(roots, skip).map(d => ({
    rel: d.rel,
    root: d.root,
    title: d.title,
    fm: d.fm,
    tokens: new Set(d.tf.keys()),
  }));
  return { count: docs.length, report: doctor(docs) };
}

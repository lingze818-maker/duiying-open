/**
 * core.mjs — 检索编排层：给定语料根+关键词 → 结构化结果。
 * CLI（surface.mjs）与 MCP server（mcp/server.mjs）共用这一份实现。
 */
import fs from "node:fs";
import path from "node:path";
import { tokenize, buildStats, bm25, timeBoost, hasTimeWord, buildLinks, spread, parseFrontmatter, applyMemoryState, doctor } from "./lib.mjs";

const SKIP_DIRS = new Set(["node_modules", ".git", "asar", "build", "dist", ".venv", "venv", "__pycache__", "vendor"]);

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

function hitLine(content, keywords) {
  for (const kw of keywords) {
    const re = new RegExp(kw, "gi");
    for (const line of content.split("\n")) {
      if (re.test(line)) return line.trim().slice(0, 80);
    }
  }
  return null;
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
 * @returns {object} { total, hint, results: [{path,title,date,score,links,note?,excerpt?}] }
 */
export function search(opts) {
  const roots = opts.roots;
  const keywords = opts.keywords;
  const limit = opts.limit ?? 10;
  const useLinks = opts.useLinks ?? true;
  const detail = opts.detail ?? false;
  const nowMs = opts.nowMs ?? Date.now();

  const docs = [];
  for (const root of roots) {
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
  const qTokens = [...new Set(keywords.flatMap(k => tokenize(k)))];
  const timeMode = hasTimeWord(keywords.join(" "));

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

  let links = null;
  if (useLinks) {
    links = buildLinks(docs.map(d => new Set(d.tf.keys())));
    const arr = scored.map(r => r.score);
    spread(arr, links);
    scored.forEach((r, i) => { r.score = arr[i]; });
  }

  scored.sort((a, b) => b.score - a.score || b.d.mtime - a.d.mtime);
  const positives = scored.filter(r => r.score > 0);

  // 记忆状态（取代/沉默）
  let pool = positives;
  const notes = new Map();
  if (positives.length) {
    const { kept, notes: n } = applyMemoryState(
      positives.map(r => ({ rel: r.d.rel, score: r.score, fm: r.d.fm })),
      { query: keywords },
    );
    const keptSet = new Set(kept.map(k => k.rel));
    const scoreOf = new Map(kept.map(k => [k.rel, k.score]));
    pool = positives.filter(r => keptSet.has(r.d.rel));
    for (const r of pool) r.score = scoreOf.get(r.d.rel);
    pool.sort((a, b) => b.score - a.score || b.d.mtime - a.d.mtime);
    for (const [k, v] of n) notes.set(k, v);
  }
  const top = pool.slice(0, limit);

  const linksOf = r => (links ? (links[r.idx] || []).map(([j]) => docs[j].rel) : []);
  const fmtDate = d => d.mtime.toISOString().slice(0, 10);

  return {
    total: pool.length,
    hint: "除非对方问起或自然相关，不要主动罗列这些记忆。",
    results: top.map(r => {
      const out = {
        path: r.d.rel, title: r.d.title, date: fmtDate(r.d),
        score: Math.round(r.score * 10) / 10,
        links: linksOf(r),
      };
      if (notes.has(r.d.rel)) out.note = notes.get(r.d.rel);
      if (detail) {
        const line = hitLine(r.d.content, keywords);
        out.excerpt = line ?? r.d.title;
      }
      return out;
    }),
  };
}

/** doctor 体检（--doctor 与 MCP memory_doctor 共用）。 */
export function runDoctor(roots) {
  const docs = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      let content;
      try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
      const titleM = content.match(/^#\s+(.+)$/m);
      const tokens = tokenize(content);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      docs.push({
        rel: file.split(path.sep).join("/").replace(path.resolve(root).split(path.sep).join("/") + "/", ""),
        title: titleM ? titleM[1].trim() : path.basename(file, ".md"),
        fm: parseFrontmatter(content),
        tokens: new Set(tf.keys()),
      });
    }
  }
  return { count: docs.length, report: doctor(docs) };
}

#!/usr/bin/env node
/**
 * surface.mjs — 对影 · 记忆上浮引擎 CLI（编排实现在 core.mjs，纯函数在 lib.mjs）
 *
 * 用法：
 *   node surface.mjs "关键词1,关键词2" [--root <语料目录>]... [--limit N] [--json] [--detail] [--no-links] [--out <文件>]
 *   node surface.mjs --doctor [--root <语料目录>]...
 */
import fs from "node:fs";
import { search, runDoctor } from "./core.mjs";

const argv = process.argv.slice(2);
const positional = [];
let LIMIT = 10, DETAIL = false, USE_LINKS = true, AS_JSON = false, DOCTOR = false;
const roots = [];
const excludes = [];
let outPath = null;
let i = 0;
while (i < argv.length) {
  const arg = argv[i];
  const take = flag => {
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) {
      console.error(`缺少参数: ${flag} 需要一个值`);
      process.exit(1);
    }
    return v;
  };
  if (arg === "--limit") LIMIT = parseInt(take("--limit"), 10) || 10;
  else if (arg === "--root") roots.push(take("--root"));
  else if (arg === "--out") outPath = take("--out");
  else if (arg === "--exclude") excludes.push(take("--exclude"));
  else if (arg === "--detail") DETAIL = true;
  else if (arg === "--no-links") USE_LINKS = false;
  else if (arg === "--json") AS_JSON = true;
  else if (arg === "--doctor") DOCTOR = true;
  else positional.push(arg);
  i++;
}
const ROOTS = roots.length ? roots : [process.cwd()];

const keywords = positional.join(",").split(/[,，]/).map(s => s.trim()).filter(Boolean);
if (keywords.length === 0 && !DOCTOR) {
  console.error('用法: node surface.mjs "关键词1,关键词2" [--root <目录>]... [--limit N] [--json] [--detail] [--no-links] [--out <文件>] [--doctor] [--exclude <目录名>]');
  process.exit(1);
}

if (DOCTOR) {
  const { count, report } = runDoctor(ROOTS, excludes.length ? excludes : undefined);
  if (report.length === 0) {
    console.log(`[doctor] 语料 ${count} 篇 · 体检通过，无警示项`);
  } else {
    console.log(`[doctor] 语料 ${count} 篇 · ${report.length} 项警示：\n`);
    for (const r of report) {
      const tag = { broken_link: "坏链", near_duplicate: "疑似重复", title_quality: "标题质量", suppressed_list: "沉默中" }[r.type] || r.type;
      console.log(`  [${tag}] ${r.file} — ${r.detail}`);
    }
    console.log(`\ndoctor 报告供深度清理参考——日常检索已自动降噪，是否处理由你决定。`);
  }
  process.exit(0);
}

const result = search({
  roots: ROOTS, keywords, limit: LIMIT,
  useLinks: USE_LINKS, detail: DETAIL,
  exclude: excludes.length ? excludes : undefined,
});

if (AS_JSON) {
  const payload = JSON.stringify({ engine: "duiying-open/0.2", query: keywords, ...result }, null, 2);
  console.log(payload);
  if (outPath) {
    fs.writeFileSync(outPath, payload + "\n", "utf8");
    console.error(`(已写入 ${outPath})`);
  }
} else {
  let md = `# 记忆上浮 · ${result.time.line}\n\n`;
  md += `关键词: ${keywords.join(" / ")} · 语料: ${ROOTS.join(" + ")} · 引擎: v0.2(bm25+时间先验${USE_LINKS ? "+联想扩散" : ""})\n`;
  md += `命中文件: ${result.total} · 展示 top ${result.results.length}\n\n`;
  md += `> ${result.hint}\n\n`;
  for (const r of result.results) {
    md += `- [${r.date}] ${r.title} —— ${r.path} (s${Math.round(r.score)})\n`;
    if (r.links.length) md += `  ↳ 关联: ${r.links.join(", ")}\n`;
    if (r.note) md += `  ↳ ${r.note}\n`;
    if (r.excerpt) md += `  > ${r.excerpt}\n`;
  }
  md += `\n—— 只浮线索,不替记忆。读与判断,是使用者自己的事。\n`;
  console.log(md);
  if (outPath) {
    fs.writeFileSync(outPath, md, "utf8");
    console.log(`(已写入 ${outPath})`);
  } else {
    console.error("(提示：加 --out <文件> 可把本结果存为 Markdown；缺省只打印，避免污染工作目录)");
  }
  if (result.total > result.results.length) console.log(`(其余 ${result.total - result.results.length} 个命中未展示,关键词更具体可收敛)`);
}

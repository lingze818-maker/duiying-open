#!/usr/bin/env node
/**
 * run.mjs — 企业冻结评测集 runner（2026-11-23）
 *
 * 用法：node evals/frozen/2026-11-23/run.mjs
 * 逐条跑 queries.json 的用例：must_appear 全出现 + must_not_appear 全不出现 = pass。
 * 权限隔离用例（P*）额外校验：must_not_appear 中的未授权根文件出现 = 硬失败（泄漏）。
 * 输出汇总表；任何泄漏（unauthorized 根内容出现）= 整体失败。
 */
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { search } from "../../../engine/core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(HERE, "queries.json"), "utf8"));

const libPaths = {};
for (const [name, p] of Object.entries(spec.roots)) {
  const clean = p.split("#")[0].trim();
  // 与引擎 resolvedRoot 同一规范化：resolve + 正斜杠——否则 root 名映射全部失配
  libPaths[name] = resolve(join(HERE, clean)).split("\\").join("/");
}

const now = new Date(spec.now).getTime();
let pass = 0, fail = 0, leak = 0;
const rows = [];

for (const q of spec.queries) {
  const roots = q.roots.map(r => libPaths[r]).filter(Boolean);
  const r = search({
    roots,
    keywords: q.query.split(/\s+/).filter(Boolean),
    nowMs: new Date(spec.now).getTime(),
    useLinks: true,
  });
  const paths = r.results.map(x => {
    const rootName = Object.entries(libPaths).find(([, p]) => x.root === p)?.[0]
      ?? q.roots.find(name => x.root === libPaths[name])
      ?? q.roots[0];
    return `${rootName}/${x.path}`;
  });
  const missing = (q.must_appear ?? []).filter(m => !paths.includes(m));
  const leaked = (q.must_not_appear ?? []).filter(m => paths.includes(m));
  const unauthorizedLeak = leaked.some(m => m.startsWith("unauthorized/"));
  if (unauthorizedLeak) leak += 1;
  const ok = !missing.length && !leaked.length;
  if (ok) pass += 1; else fail += 1;
  rows.push({
    id: q.id, category: q.category, query: q.query,
    result: ok ? "pass" : (unauthorizedLeak ? "LEAK" : "fail"),
    missing: missing.join(", "), leaked: leaked.join(", "),
  });
  console.log(`${ok ? "✔" : unauthorizedLeak ? "🚨LEAK" : "✖"} ${q.id} [${q.category}] "${q.query}"${missing.length ? " 缺:" + missing.join(",") : ""}${leaked.length ? " 泄:" + leaked.join(",") : ""}`);
}

console.log(`\n汇总：${pass} 过 / ${fail} 败 / 泄漏 ${leak}（目标 0）`);
console.log(`评测集：${spec.id} · k=${spec.k} · 向量路 ${spec.vector_enabled ? "启用" : "关闭（词面基线）"}`);
if (fail > 0 || leak > 0) process.exit(1);

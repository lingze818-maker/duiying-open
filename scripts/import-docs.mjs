#!/usr/bin/env node
/**
 * import-docs.mjs — 文档批量导入 CLI（安装手册第四章配套）
 * 用法：node scripts/import-docs.mjs --root workspace/memories/common --src D:\单位文档目录 [--subdir xxx]
 */
import { join } from "node:path";
import { importTo } from "../engine/importer.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const root = arg("root");
const src = arg("src");
if (!root || !src) {
  console.log('用法：node scripts/import-docs.mjs --root workspace/memories/common --src D:\\文档目录 [--chunk-chars 500]');
  process.exit(1);
}
const r = await importTo(root, src, { chunkChars: Number(arg("chunk-chars", "500")) });
console.log(`导入完成：源文档 ${r.imported} 份 → 记忆文件 ${r.chunks} 个`);
if (r.skipped.length) {
  console.log(`跳过 ${r.skipped.length} 项：`);
  for (const s of r.skipped) console.log(`  - ${s.path}（${s.reason}）`);
}

/**
 * scan.mjs — 语料根上的只读扫描。检索全量路径和 Layer 1 索引共用这一份，
 * 避免两边各写一套跳过规则或切词前的读文件方式。
 */
import fs from "node:fs";
import path from "node:path";
import { tokenize, parseFrontmatter, memoryInstant } from "./lib.mjs";

/** 索引落在每个授权根下面的这个目录。不进检索，应写入 .gitignore。 */
export const INDEX_DIR_NAME = ".duiying";
/** 一个根一份词法索引文件。不跨根合并。 */
export const INDEX_FILE_NAME = "lexical.json";

export const SKIP_DIRS = new Set([
  "node_modules", ".git", "asar", "build", "dist", ".venv", "venv", "__pycache__", "vendor",
  INDEX_DIR_NAME,
]);

export function resolvedRoot(root) {
  return path.resolve(root).split(path.sep).join("/");
}

export function* walkMarkdown(dir, skip) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!(skip || SKIP_DIRS).has(e.name)) yield* walkMarkdown(p, skip);
    } else if (e.name.endsWith(".md")) yield p;
  }
}

function landmarkTitle(content, file, fm) {
  const titleM = content.match(/^#\s+(.+)$/m);
  const heading = titleM ? titleM[1].trim() : path.basename(file, ".md");
  const custom = fm.get("title");
  return typeof custom === "string" && custom.trim() ? custom.trim() : heading;
}

/** 读一篇笔记，形状与全量扫描交给排序层的文档一致。读失败返回 null。 */
export function readMemoryFile(rootFwd, file) {
  let content;
  try { content = fs.readFileSync(file, "utf8"); } catch { return null; }
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const tokens = tokenize(content);
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  const fm = parseFrontmatter(content);
  const mtime = fs.statSync(file).mtime;
  return {
    root: rootFwd,
    rel: path.resolve(file).split(path.sep).join("/").replace(rootFwd + "/", ""),
    base: path.basename(file).toLowerCase(),
    title: landmarkTitle(content, file, fm),
    content,
    mtime,
    when: memoryInstant(fm, mtime),
    tf,
    len: tokens.length,
    fm,
  };
}

/**
 * adapters/directory.mjs — 本机目录适配器。
 *
 * 把一个文件夹里已经是 Markdown 的文件，经 list / fetch / toNote / sync
 * 拉进调用方给出的授权根。不回写、不删除源目录。
 * 不绑定某一种共享协议。非 Markdown 只有在预留转换器被接上以后才会进入；
 * 这一版转换器是 null，这些文件被跳过。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { defineAdapter, safeRel } from "./sync.mjs";
import { projectSourceFile, reservedMarkdownConverter } from "./extensions.mjs";

const SKIP_DIRS = new Set(["node_modules", ".git", ".duiying"]);

export function directorySourceId(rel) {
  const norm = String(rel ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  return `d${createHash("sha256").update(norm).digest("hex").slice(0, 16)}`;
}

function mtimeStamp(full) {
  const ms = fs.statSync(full).mtimeMs;
  return new Date(Math.round(ms / 1000) * 1000).toISOString();
}

function localDay(ms) {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function titleFrom(markdown, rel) {
  const text = String(markdown ?? "").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  let start = 0;
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close !== -1) start = close + 1;
  }
  for (let i = start; i < lines.length; i++) {
    const match = /^#{1,6}\s+(.+)$/.exec(lines[i]);
    if (match) return match[1].trim();
  }
  return path.basename(rel).replace(/\.md$/i, "") || "笔记";
}

function walk(source) {
  const root = path.resolve(source);
  let stat;
  try { stat = fs.statSync(root); }
  catch { throw new Error("本地目录不存在或不是文件夹"); }
  if (!stat.isDirectory()) throw new Error("本地目录不存在或不是文件夹");

  const out = [];
  const stack = [""];
  while (stack.length) {
    const relDir = stack.pop();
    const dir = relDir ? path.join(root, relDir) : root;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (err) { throw new Error(`无法读取本地目录：${err.message}`); }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push({ rel, full: path.join(dir, entry.name) });
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel, "en"));
  return out;
}

export function createAdapter(options = {}) {
  const sourceArg = options.source == null ? "" : String(options.source).trim();
  if (!sourceArg) throw new Error("未指定本地目录（source）");
  const source = path.resolve(sourceArg);
  const converter = Object.prototype.hasOwnProperty.call(options, "converter")
    ? options.converter
    : reservedMarkdownConverter();

  function consider(file) {
    return file.rel.toLowerCase().endsWith(".md") || typeof converter === "function";
  }

  return defineAdapter({
    id: "directory",
    async list() {
      const rows = [];
      for (const file of walk(source)) {
        if (!consider(file)) continue;
        const row = {
          id: directorySourceId(file.rel),
          title: path.basename(file.rel, path.extname(file.rel)),
          updated: mtimeStamp(file.full),
        };
        if (file.rel.toLowerCase().endsWith(".md")) row.path = file.rel;
        rows.push(row);
      }
      return rows;
    },
    async fetch(id) {
      const wanted = String(id);
      const file = walk(source).find(item => directorySourceId(item.rel) === wanted);
      if (!file) throw new Error(`目录中没有条目 ${wanted}`);
      if (!consider(file)) throw new Error("这一版不转换非 Markdown 源文件");
      const updated = mtimeStamp(file.full);
      const isMd = file.rel.toLowerCase().endsWith(".md");
      const projected = await projectSourceFile({
        rel: file.rel,
        sourcePath: file.full,
        text: isMd ? fs.readFileSync(file.full, "utf8") : undefined,
        converter,
      });
      if (!projected) throw new Error("这一版不转换非 Markdown 源文件");
      const rel = safeRel(projected.rel);
      const ms = fs.statSync(file.full).mtimeMs;
      return {
        id: wanted,
        title: titleFrom(projected.markdown, rel),
        updated,
        path: rel,
        body: projected.markdown,
        passthrough: projected.passthrough === true,
        date: localDay(ms),
      };
    },
    toNote(item) {
      if (item.passthrough) return item.body;
      return {
        title: item.title,
        date: item.date,
        body: item.body,
        rel: item.path,
      };
    },
  });
}

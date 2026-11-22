/**
 * adapters/fixture-company.mjs — 完全虚构的本地公司源。
 *
 * 读 fixtures/company-source 里的 catalog.json 和 Markdown 正文。
 * 不访问网络，不回写这些源文件。专精到某一家真实系统时另写适配器，不改这里的调用方。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineAdapter } from "./sync.mjs";

const DEFAULT_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "company-source");

function bodyFile(source, rel, id) {
  if (!rel || /[\r\n]/.test(rel)) throw new Error(`夹具条目 ${id} 缺少正文路径`);
  const norm = String(rel).replace(/\\/g, "/");
  if (path.isAbsolute(rel) || path.win32.isAbsolute(rel) || norm.split("/").includes("..")) {
    throw new Error(`夹具正文路径必须留在源目录内：${rel}`);
  }
  const full = path.resolve(source, rel);
  const back = path.relative(path.resolve(source), full);
  if (back.startsWith("..") || path.isAbsolute(back)) throw new Error(`夹具正文路径必须留在源目录内：${rel}`);
  return full;
}

function readCatalog(source) {
  const file = path.join(source, "catalog.json");
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (err) { throw new Error(`无法读取虚构夹具：${err.message}`); }
  if (!parsed || !Array.isArray(parsed.items)) throw new Error("夹具 catalog.json 缺少 items");
  return parsed.items;
}

export function createAdapter(options = {}) {
  const source = path.resolve(options.source || DEFAULT_SOURCE);

  function itemById(id) {
    const item = readCatalog(source).find(entry => entry && entry.id === id);
    if (!item) throw new Error(`夹具中没有条目 ${id}`);
    return item;
  }

  return defineAdapter({
    id: "fixture",
    async list() {
      return readCatalog(source).map(entry => ({
        id: entry.id,
        title: entry.title,
        updated: entry.updated,
        ...(entry.path ? { path: entry.path } : {}),
      }));
    },
    async fetch(id) {
      const entry = itemById(id);
      const body = fs.readFileSync(bodyFile(source, entry.path, id), "utf8");
      return { ...entry, body };
    },
    toNote(item) {
      return {
        title: item.title,
        date: item.date,
        body: item.body,
        rel: item.path,
        superseded_by: item.superseded_by,
        suppress: item.suppress,
        suppress_when: item.suppress_when,
      };
    },
  });
}

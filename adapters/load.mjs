/**
 * adapters/load.mjs — 按配置加载适配器，不经过 engine/。
 *
 * 名字 `fixture` 是仓库自带的虚构夹具。
 * 其他裸名字到 adapters/<名字>.mjs（以后把专精实现放进来即可）。
 * 以路径给出的本地模块导出 createAdapter(options) 或 list/fetch/toNote。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineAdapter } from "./sync.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function adapterFile(spec) {
  const name = String(spec ?? "").trim();
  if (!name) throw new Error("未指定适配器");
  if (/^https?:/i.test(name)) throw new Error("适配器必须是本地模块，不能是网址");
  if (name === "fixture") return path.join(HERE, "fixture-company.mjs");

  const looksPath = name.startsWith(".")
    || name.includes("/")
    || name.includes("\\")
    || path.isAbsolute(name)
    || path.win32.isAbsolute(name);
  if (looksPath) {
    const file = path.win32.isAbsolute(name) && !path.isAbsolute(name) ? name : path.resolve(name);
    if (!fs.existsSync(file)) throw new Error(`找不到适配器模块：${name}`);
    return file;
  }
  if (!/^[\w.-]+$/.test(name)) throw new Error(`非法适配器名：${name}`);
  if (name === "sync" || name === "load") throw new Error(`找不到适配器：${name}（内置名为 fixture，或给出本地模块路径）`);
  const bundled = path.join(HERE, `${name}.mjs`);
  if (fs.existsSync(bundled)) return bundled;
  throw new Error(`找不到适配器：${name}（内置名为 fixture，或给出本地模块路径）`);
}

function asAdapter(value) {
  if (value && typeof value.sync === "function"
    && typeof value.list === "function"
    && typeof value.fetch === "function"
    && typeof value.toNote === "function") {
    return value;
  }
  return defineAdapter(value);
}

export async function loadAdapter(spec, options = {}) {
  const file = adapterFile(spec);
  const mod = await import(pathToFileURL(file).href);
  let created;
  if (typeof mod.createAdapter === "function") created = await mod.createAdapter(options);
  else if (typeof mod.default === "function") created = await mod.default(options);
  else if (mod.default && typeof mod.default === "object") created = mod.default;
  else created = mod;
  return asAdapter(created);
}

/**
 * server/enterprise.mjs — 企业记忆库检索服务（M2.5 最小 Web 入口）
 *
 * 一个零依赖 Node HTTP 服务：静态搜索页 + 三个 API。
 * 架构纪律：权限在检索之前——身份经 resolveUserRoots 组装根集合，引擎只见授权范围；
 * 每次检索经 AuditLog 记录（谁/何时/查词截断）。向量路可选：embedder 就绪才启用。
 *
 * 环境变量：
 *   ENTERPRISE_CONFIG   workspace 配置（libs/users），JSON 文件路径（必填）
 *   ENTERPRISE_DATA     记忆根目录映射基准路径（libPaths 相对它解析；默认配置文件所在目录）
 *   ENTERPRISE_VEC      向量存储目录（提供则启用向量路；需已安装可选依赖与模型）
 *   PORT                监听端口（默认 8766）
 *
 * 启动：node server/enterprise.mjs
 */
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { search } from "../engine/core.mjs";
import { resolveUserRoots, canWrite } from "../engine/authz.mjs";
import { AuditLog } from "../engine/audit.mjs";
import { createEmbedder } from "../engine/embedding.mjs";
import { LocalFileStore } from "../engine/vector-store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.ENTERPRISE_CONFIG;
const PORT = Number(process.env.PORT ?? 8766);
if (!CONFIG_PATH || !existsSync(CONFIG_PATH)) {
  console.error("enterprise: 需要 ENTERPRISE_CONFIG 指向 workspace 配置 JSON");
  process.exit(1);
}
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const DATA_BASE = resolve(process.env.ENTERPRISE_DATA ?? dirname(CONFIG_PATH));

/** libPaths：库名 → 绝对路径（config.libs[name].path 相对 DATA_BASE 解析）。 */
const libPaths = {};
for (const [name, cfg] of Object.entries(CONFIG.libs ?? {})) {
  if (typeof cfg.path === "string") libPaths[name] = resolve(DATA_BASE, cfg.path);
}

/** 向量路（可选）：目录存在且依赖就绪才启用；否则静默纯词面。 */
let vecStore = null, embedder = null;
if (process.env.ENTERPRISE_VEC) {
  try {
    vecStore = new LocalFileStore(process.env.ENTERPRISE_VEC, { dim: 512 }).load();
    embedder = await createEmbedder({ backend: "transformers.js", offline: true });
    console.log("enterprise: 向量路已启用");
  } catch (error) {
    console.log("enterprise: 向量路未启用（" + error.message + "），纯词面检索照常");
  }
}

const audit = new AuditLog(join(DATA_BASE, "audit", "audit.jsonl"));
const STATIC_HTML = readFileSync(join(HERE, "static", "index.html"), "utf8");

/** 简单身份：MVP 用 header/user 参数（部署层接入 SSO 后替换为真实身份源）。 */
function identityOf(req, url) {
  return url.searchParams.get("user") ?? req.headers["x-enterprise-user"] ?? "anonymous";
}

async function handleSearch(req, res, url) {
  const user = identityOf(req, url);
  const q = url.searchParams.get("q") ?? "";
  const libs = resolveUserRoots(user, CONFIG, libPaths);
  if (!libs.length) {
    audit.logSearch(user, q, []);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ results: [], note: "无授权库" }));
    return;
  }
  let vector;
  if (vecStore && embedder) {
    try {
      const qv = await embedder.embedQuery(q);
      vector = { store: vecStore, queryVec: qv };
    } catch { /* 向量失败不阻塞词面 */ }
  }
  const r = search({ roots: libs, keywords: q.split(/\s+/).filter(Boolean), vector });
  audit.logSearch(user, q, libs.map(p => relative2(p)));
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ results: r.results, total: r.total }));
}
function relative2(abs) {
  for (const [name, path] of Object.entries(libPaths)) {
    if (abs.startsWith(path)) return name;
  }
  return abs;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(STATIC_HTML);
      return;
    }
    if (url.pathname === "/api/search") return await handleSearch(req, res, url);
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, libs: Object.keys(libPaths), vector: !!vecStore }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`enterprise: http://127.0.0.1:${PORT} | libs: ${Object.keys(libPaths).join(", ") || "无"} | vector: ${vecStore ? "on" : "off"}`);
});

/**
 * candidate-recall.mjs — Layer 1 的唯一入口。
 *
 * 排序、门控、词面重排、沉默与取代都只跟这个模块说话：要么拿到候选文档
 * 和整库统计，要么拿到 null 然后走原来的全量扫描。这里不产生最终分数。
 *
 * 分片按授权根。一个根一份索引，不把多个根收成一份全局索引。以后若再按
 * 部门切开，只替换 Layer 1 的实现；调用方仍然按根请求、按候选文档消费。
 *
 * 当前实现是可选的 MiniSearch（见 recall-minisearch.mjs）。本文件不把
 * 那个库的类型、分数或查询 API 传出这一层。以后换后端（只替换这一层，
 * 再 registerCandidateRecall）时，排序、门控和词面重排仍留在 core。
 */
import fs from "node:fs";
import path from "node:path";
import { minisearchBackend } from "./recall-minisearch.mjs";

export { INDEX_DIR_NAME, INDEX_FILE_NAME } from "./scan.mjs";
import { INDEX_DIR_NAME, INDEX_FILE_NAME } from "./scan.mjs";

const backends = [minisearchBackend];

/** 测试或日后的替换实现可以再登记一个后端。后登记的优先。 */
export function registerCandidateRecall(backend) {
  if (backend && typeof backend.recall === "function" && typeof backend.refresh === "function") {
    backends.push(backend);
  }
}

function activeBackend() {
  for (let i = backends.length - 1; i >= 0; i--) {
    const backend = backends[i];
    try {
      if (typeof backend.available === "function" && !backend.available()) continue;
      return backend;
    } catch { /* 这个实现起不来就试上一个 */ }
  }
  return null;
}

export function recallBackendAvailable() {
  return Boolean(activeBackend());
}

function indexPath(root) {
  return path.join(path.resolve(root), INDEX_DIR_NAME, INDEX_FILE_NAME);
}

/** 磁盘上有没有这份分片。后端没装时也可以回答，方便调用方决定要不要尝试更新。 */
export function indexPresent(root) {
  if (!root) return false;
  try {
    const backend = activeBackend();
    if (backend && typeof backend.present === "function") return Boolean(backend.present(root));
    return fs.existsSync(indexPath(root));
  } catch {
    return false;
  }
}

/**
 * 预留的向量候选源。本版本固定返回 null。
 * 不加载编码器，不读向量文件，调用方看到 null 时不改候选集、不改排序。
 * 以后若接入，只替换这个函数的返回值；Layer 2 仍只消费候选文档。
 */
export function vectorCandidateSource() {
  return null;
}

/**
 * @param {{ roots: string[], keywords: string[], queryText?: string, exclude?: string[] }} request
 * @returns {null | { docs: object[], stats: { df: Map<string, number>, N: number, avgdl: number } }}
 *   null：没有可用索引（缺失、损坏、后端没装、或这个查询不该走召回）。调用方全量扫描。
 */
export function recallCandidates(request) {
  const backend = activeBackend();
  if (!backend) return null;
  try {
    const hit = backend.recall(request);
    if (!hit || !Array.isArray(hit.docs) || !hit.stats) return null;
    // 向量候选源预留位。null 时候选集就是词法召回的结果。
    const vectorSource = vectorCandidateSource();
    if (vectorSource && typeof vectorSource.recall === "function") {
      // 本版本 vectorCandidateSource() 固定为 null，不会执行到这里。
    }
    return { docs: hit.docs, stats: hit.stats };
  } catch {
    return null;
  }
}

/**
 * 为一个授权根增量建索引或更新已有索引。create 为 false 且索引不存在时不新建。
 * @returns {{ ok: boolean, reason?: string, absent?: boolean, added?: number, updated?: number, removed?: number, unchanged?: number, retouched?: number, docs?: number }}
 */
export function refreshIndex(root, opts = {}) {
  const backend = activeBackend();
  if (!backend) return { ok: false, reason: "unavailable" };
  try {
    return backend.refresh(root, opts) || { ok: false, reason: "error" };
  } catch (err) {
    return { ok: false, reason: "error", message: err && err.message ? err.message : String(err) };
  }
}

/** 索引已经存在才更新。写入路径用它，避免在没有索引的根上凭空建一份。 */
export function refreshIndexIfPresent(root, opts = {}) {
  if (!indexPresent(root)) return { ok: true, absent: true };
  return refreshIndex(root, { ...opts, create: false });
}

/** 最近一次召回读了多少篇正文。测试用来确认没有把整个根再扫一遍。 */
export function lastRecallMeta() {
  const backend = activeBackend();
  if (!backend || typeof backend.lastMeta !== "function") return null;
  try { return backend.lastMeta() || null; } catch { return null; }
}

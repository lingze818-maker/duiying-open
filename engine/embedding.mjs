/**
 * embedding.mjs — 向量嵌入后端抽象层（企业记忆库线 M1.2）
 *
 * 设计要点（docs/notes/向量检索设计-M1-2026-11-22.md §1）：
 * - 三形态后端：transformers.js（Node 原生 ONNX，默认推荐）/ Python 伴生（规划中）/ 无后端（纯词面）。
 * - **零依赖哲学不破坏**：@huggingface/transformers 是可选依赖——不装它，本模块照常加载，
 *   createEmbedder 返回 null（调用方退回纯词面检索）；只有显式要求向量路且未装依赖时才报错并指路。
 * - 离线分发：企业内网无外网，模型文件（ONNX）随安装包放置于 cacheDir，运行时不再联网
 *   （env.allowRemoteModels = false 由部署配置打开）。
 *
 * BGE 检索约定：bge-small-zh-v1.5 官方建议查询侧加指令前缀以提升检索效果；
 * 文档侧不加。本模块 embed() 是文档侧（无前缀），embedQuery() 是查询侧（带前缀）。
 */
import { existsSync } from "node:fs";

/** 内置模型目录：key 是配置里可写的短名。dim 与 VectorStore 配置维度对齐。 */
export const EMBEDDING_MODELS = {
  "bge-small-zh": { model: "Xenova/bge-small-zh-v1.5", dim: 512 },
};

/** BGE 中文检索的查询指令前缀（官方约定）。文档侧不使用。 */
export const BGE_QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";

/**
 * 创建 embedding 后端。
 * @param {object} opts
 *   backend: "transformers.js" | "none"（默认 "none"——零依赖哲学：不装可选依赖就没有向量路）
 *   model:   EMBEDDING_MODELS 的 key（默认 "bge-small-zh"）
 *   cacheDir: 模型缓存目录（企业离线分发时指向安装包内路径）；缺省用 transformers.js 默认缓存
 *   offline: true 时禁止联网拉模型（env.allowRemoteModels=false），模型必须已在 cacheDir
 * @returns Promise<{ dim, embed(texts): Promise<Float32Array[]>, embedQuery(text): Promise<Float32Array> } | null>
 *   backend 为 "none" 时返回 null——调用方据此退回纯词面检索，行为与现状完全一致。
 */
export async function createEmbedder(opts = {}) {
  const backend = opts.backend ?? "none";
  if (backend === "none") return null;
  if (backend !== "transformers.js") {
    throw new Error(`embedding: 未知后端 "${backend}"（可选：transformers.js / none；Python 伴生后端在规划中）`);
  }

  const modelKey = opts.model ?? "bge-small-zh";
  const spec = EMBEDDING_MODELS[modelKey];
  if (!spec) {
    const known = Object.keys(EMBEDDING_MODELS).join(", ");
    throw new Error(`embedding: 未知模型 "${modelKey}"（内置：${known}）`);
  }

  let transformers;
  try {
    transformers = await import("@huggingface/transformers");
  } catch {
    throw new Error(
      "embedding: 未安装 @huggingface/transformers。向量检索是可选能力——" +
      "安装它以启用语义检索（npm i @huggingface/transformers），" +
      "或不安装保持纯词面检索（createEmbedder backend 用 \"none\"）。",
    );
  }

  if (opts.offline) transformers.env.allowRemoteModels = false;
  if (opts.cacheDir) transformers.env.cacheDir = opts.cacheDir;

  const extractor = await transformers.pipeline("feature-extraction", spec.model);

  /** 文档侧：一批文本 → 归一化向量（CLS pooling + L2 normalize）。 */
  async function embed(texts) {
    if (!texts.length) return [];
    const output = await extractor(texts, { pooling: "cls", normalize: true });
    const rows = [];
    for (let i = 0; i < output.dims[0]; i++) {
      rows.push(Float32Array.from(output[i].tolist ? output[i].tolist() : output[i].data));
    }
    return rows;
  }

  return {
    dim: spec.dim,
    embed,                                            // 文档入库用
    embedQuery: (text) => embed([BGE_QUERY_PREFIX + text]).then(rows => rows[0]),  // 查询侧带指令前缀
  };
}

/** 部署自查：检查可选依赖与模型缓存是否就绪（安装手册/doctor 命令共用）。 */
export function embeddingReadiness(opts = {}) {
  const modelKey = opts.model ?? "bge-small-zh";
  const spec = EMBEDDING_MODELS[modelKey];
  let depInstalled = false;
  try { depInstalled = existsSync("node_modules/@huggingface/transformers"); } catch { /* ignore */ }
  return {
    backend: opts.backend ?? "none",
    model: spec?.model ?? modelKey,
    dim: spec?.dim ?? null,
    depInstalled,
    offline: opts.offline ?? false,
    note: (opts.backend ?? "none") === "none"
      ? "纯词面检索（向量路未启用）"
      : depInstalled ? "向量路就绪" : "缺少可选依赖 @huggingface/transformers",
  };
}

/**
 * mcp/extensions.mjs — MCP 包装上的扩展位。
 *
 * lexicalRecall 指向 Layer 1。lexicalBackend 是当前可选的词法后端文件。
 * 以后替换后端只动 Layer 1，不把后端分数送进排序。
 * vectorCandidateSource 必须保持 null：这一版不提供向量候选，不加载编码器，不写向量索引。
 * markdownConverter 与 adapters/extensions.mjs 是同一个空位：这一版不把源文件转换成 Markdown。
 */
import { markdownConverter } from "../adapters/extensions.mjs";

export const duiyingExtensions = Object.freeze({
  lexicalRecall: "engine/candidate-recall.mjs",
  lexicalBackend: "engine/recall-minisearch.mjs",
  vectorCandidateSource: null,
  markdownConverter,
});

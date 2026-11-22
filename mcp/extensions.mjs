/**
 * mcp/extensions.mjs — MCP 包装上的扩展位。
 *
 * lexicalRecall 指向 Layer 1。vectorCandidateSource 必须保持 null：
 * 这一版不提供向量候选，不加载编码器，不写向量索引，memory_surface 的排序不变。
 */
export const duiyingExtensions = Object.freeze({
  lexicalRecall: "engine/candidate-recall.mjs",
  vectorCandidateSource: null,
});

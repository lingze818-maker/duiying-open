/**
 * adapters/extensions.mjs — 把源文件收成 Markdown 的预留位。
 *
 * markdownConverter 这一版固定为 null。
 * 已经是 Markdown 的文件原样交回调用方。
 * 其他文件在转换器缺席时返回 null，调用方跳过，不算同步失败。
 * 以后的纯本地、离线函数形状：
 *   ({ rel, sourcePath }) => ({ markdown, rel? } | null)
 * 它只产出正文。调用方把结果写入授权根，不得改写 sourcePath。
 */

export const markdownConverter = null;

export const duiyingAdapterExtensions = Object.freeze({
  markdownConverter,
});

export function reservedMarkdownConverter() {
  const fn = duiyingAdapterExtensions.markdownConverter;
  return typeof fn === "function" ? fn : null;
}

/**
 * @param {{ rel?: string, sourcePath?: string, text?: string, converter?: Function | null }} file
 * @returns {Promise<null | { rel: string, markdown: string, passthrough: boolean }>}
 */
export async function projectSourceFile(file = {}) {
  const norm = String(file.rel ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  const active = file.converter === undefined ? reservedMarkdownConverter() : file.converter;
  if (norm.toLowerCase().endsWith(".md")) {
    return { rel: norm, markdown: file.text ?? "", passthrough: true };
  }
  if (typeof active !== "function") return null;
  const out = await active({ rel: norm, sourcePath: file.sourcePath });
  if (!out || typeof out.markdown !== "string" || !out.markdown.trim()) return null;
  const dest = out.rel ? String(out.rel).replace(/\\/g, "/") : `${norm}.md`;
  return { rel: dest, markdown: out.markdown, passthrough: false };
}

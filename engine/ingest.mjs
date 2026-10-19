#!/usr/bin/node
/**
 * engine/ingest.mjs — 多前端写入协议（memory_ingest 的纯函数层）
 *
 * 设计约定（2026-10-18 产品需求定稿）：
 * - 多前端共享同一个记忆库：任何接 MCP 的前端都可贡献记忆
 * - 原文两种形态：content 落盘灌库 / source_path 路径标记（原文留原处，库只落薄条目）
 * - 摘要谁灌的谁写：summary 由写入方负责，引擎不代写——记忆的质量归贡献的意识
 * - 内容分 event 标签（决策/会议/洞察…自由打），来源分 channel 标签（zcode/codex/…自由打）
 * - append-only：只新增不覆盖，slug 冲突自动递增后缀
 *
 * 写入位置：<root>/ingest/<channel>/<YYYY-MM-DD>-<slug>.md
 * frontmatter 兼容引擎的零依赖 YAML 子集（key: value）。
 */
import fs from "node:fs";
import path from "node:path";

/** 路径段安全化：只保留中英文、数字、- _ 空格；其余压成 -；防 ../ 穿越 */
function safeSegment(s, max = 40) {
  return String(s)
    .trim()
    .replace(/[^\w\u4e00-\u9fa5 -]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max) || "unknown";
}

/** 标题 slug：用于文件名，保留中英文数字- */
function slugify(s, max = 24) {
  return safeSegment(s, max).toLowerCase() || "memo";
}

/**
 * 写入一条多前端贡献的记忆。
 * @param {object} p
 * @param {string} p.root        语料根（必填）
 * @param {string} p.channel     来源前端标识（必填，作子目录）
 * @param {string} p.summary     摘要（必填，写入方负责；标题行超 40 字自动截断）
 * @param {string} [p.content]   模式 A：原文落盘（与 source_path 二选一）
 * @param {string} [p.source_path] 模式 B：原文路径标记（与 content 二选一）
 * @param {string} [p.event]     事件标签（自由：decision/meeting/…）
 * @param {string} [p.ingested_at] 注入时间（ISO；缺省 now。测试确定性用）
 * @returns {{ file: string, mode: "inline"|"reference", warnings: string[] }}
 *          失败时返回 { error }
 */
export function ingest(p) {
  const warnings = [];
  const root = p.root ? String(p.root).trim() : "";
  if (!root) return { error: "root 不能为空" };
  const channel = safeSegment(p.channel ?? "", 40);
  if (!p.channel || !String(p.channel).trim()) return { error: "channel 不能为空（来源前端标识，如 zcode/codex/qq-bridge）" };
  if (!channel) return { error: "channel 清洗后为空" };
  const summary = String(p.summary ?? "").trim();
  if (!summary) return { error: "summary 不能为空——摘要由写入方负责（谁灌的谁写）" };
  const content = typeof p.content === "string" ? p.content.trim() : "";
  const sourcePath = String(p.source_path ?? "").trim();
  if (!content && !sourcePath) return { error: "content 与 source_path 至少给一个（落盘灌库或路径标记）" };
  if (content && sourcePath) return { error: "content 与 source_path 二选一，不混用" };

  const nowIso = p.ingested_at || new Date().toISOString();
  const date = nowIso.slice(0, 10);
  const stamp = nowIso.slice(0, 19).replace("T", " ");

  if (sourcePath && !path.isAbsolute(sourcePath)) warnings.push("source_path 为相对路径——按写入方工作区语义记录，未做存在性校验");
  else if (sourcePath && !fs.existsSync(sourcePath)) warnings.push(`source_path 当前不存在：${sourcePath}（仍按标记写入，确认路径拼写）`);

  const dir = path.join(root, "ingest", channel);
  const base = `${date}-${slugify(summary)}`;
  let name = `${base}.md`;
  let fp = path.join(dir, name);
  let n = 2;
  while (fs.existsSync(fp)) { name = `${base}-${n++}.md`; fp = path.join(dir, name); }

  const title = summary.length > 40 ? summary.slice(0, 40) : summary;
  if (summary.length > 40) warnings.push(`标题超 40 字已截断（完整摘要保留在正文）——路标式注入建议短摘要`);

  const lines = ["---", `channel: ${channel}`, `ingested_at: ${stamp}`];
  if (p.event) lines.push(`event: ${safeSegment(p.event, 40).replace(/-/g, "_")}`);
  if (sourcePath) lines.push(`source_path: ${sourcePath}`);
  lines.push("---", "", `# ${title}`, "");
  if (summary.length > 40) lines.push(summary, "");
  if (content) lines.push(content, "");
  else lines.push(`> 原文未落库（路径标记模式），见：${sourcePath}`, "");

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, lines.join("\n"), "utf8");
  return { file: fp, mode: content ? "inline" : "reference", warnings };
}

// ---- CLI：node engine/ingest.mjs --root <目录> --channel <前端> --summary <摘要> [--content <正文>|--source-path <路径>] [--event <标签>] ----
// 脚本化批量灌库用（MCP 之外的第二入口）。JSON 传参：--json '{"root":…,"channel":…,…}'
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("engine/ingest.mjs")) {
  const argv = process.argv.slice(2);
  const pick = k => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : undefined; };
  let payload;
  if (argv.includes("--json")) payload = JSON.parse(pick("--json"));
  else payload = {
    root: pick("--root"),
    channel: pick("--channel"),
    summary: pick("--summary"),
    content: argv.includes("--content") ? pick("--content") : undefined,
    source_path: argv.includes("--source-path") ? pick("--source-path") : undefined,
    event: pick("--event"),
  };
  const r = ingest(payload);
  if (r.error) { console.error(`✗ ${r.error}`); process.exit(1); }
  console.log(`✓ 已入库（${r.mode === "inline" ? "落盘灌库" : "路径标记"}）：${r.file}`);
  for (const w of r.warnings) console.error(`⚠️ ${w}`);
}

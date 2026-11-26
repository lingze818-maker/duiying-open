/**
 * session-archive.mjs — 智能体会话归档（企业记忆库线）
 *
 * 配合已有智能体使用的构件：智能体的会话历史（压缩前原文）交由本模块归档。
 * 设计要点：
 * - append-only：每个 session 一个 JSONL 文件，一行一个事件（写入不覆盖、可回放）；
 * - 检索友好：归档的每条消息走既有索引/检索管线（ingest 落盘为记忆文件后自动可搜）；
 * - 压缩配合：智能体侧的上下文压缩（如 billion-context）把摘要留在会话里，
 *   压缩掉的原文交到这里归档——摘要管「当下够用」，归档管「日后可查」。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SAFE = /[^A-Za-z0-9_\-\u4e00-\u9fff]+/g;

/** 会话 id → 安全文件名。 */
export function sessionFileId(sessionId) {
  const s = String(sessionId ?? "").replace(SAFE, "-").replace(/^-+|-+$/g, "");
  return s || "unnamed";
}

/** 单个会话的归档文件路径。 */
export function sessionPath(archiveRoot, sessionId) {
  return join(archiveRoot, `${sessionFileId(sessionId)}.jsonl`);
}

/**
 * 追加一轮（或多条消息）到会话归档。自动建目录。
 * @param {object} opts
 *   archiveRoot: 归档根目录（必填）
 *   sessionId:   会话标识（必填）
 *   messages:    [{ role, content, ... }] 本批要归档的消息
 *   meta:        可选附加信息（来源智能体、压缩标记等）
 * @returns {{ ok: true, path: string, appended: number }}
 */
export function appendSession({ archiveRoot, sessionId, messages, meta }) {
  if (!archiveRoot) throw new Error("session-archive: archiveRoot 必填");
  if (!sessionId) throw new Error("session-archive: sessionId 必填");
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("session-archive: messages 必须是非空数组");
  }
  const dir = join(archiveRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = sessionPath(archiveRoot, sessionId);
  const event = {
    at: new Date().toISOString(),
    sessionId,
    ...(meta ?? {}),
    messages,
  };
  appendFileSync(path, JSON.stringify(event) + "\n", "utf8");
  return { ok: true, path, appended: messages.length };
}

/** 读取某个会话的全部归档事件（按行解析，坏行跳过）。 */
export function readSession(archiveRoot, sessionId) {
  const path = sessionPath(archiveRoot, sessionId);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch { /* 坏行跳过，不阻塞 */ }
  }
  return out;
}

/**
 * 会话压缩（智能体调用的存储端执行器）：
 * 把「被压缩范围」的原文整体归档（append-only，永不丢），随后写入一个摘要事件
 * 成为会话的当前头部。原文随时可从归档事件回放——压缩只是视图切换，不是删除。
 *
 * @param {object} opts
 *   archiveRoot: 归档根目录
 *   sessionId:   会话标识
 *   summary:     智能体的模型写好的高保真摘要（保留决策/路径/承诺/未完成）
 *   range:       被压缩的消息数组（原文，将从有效视图移除并归档）
 *   meta:        可选（压缩发起方、模型名等）
 * @returns {{ ok: true, archivedCount: number, summaryEvent: object }}
 */
export function compressSession({ archiveRoot, sessionId, summary, range, meta }) {
  if (!sessionId) throw new Error("session-compress: sessionId 必填");
  if (!summary || !String(summary).trim()) throw new Error("session-compress: summary 必填（由智能体的模型撰写）");
  if (!Array.isArray(range) || !range.length) {
    throw new Error("session-compress: range 必须是被压缩的消息数组");
  }
  // 原文整体归档：先落一个 archive 事件（append-only，永不覆盖）
  appendSession({
    archiveRoot, sessionId: sessionId + "-archive",
    messages: range,
    meta: { kind: "compressed-original", ...(meta ?? {}) },
  });
  const summaryEvent = {
    at: new Date().toISOString(),
    sessionId,
    kind: "summary",
    summary: String(summary),
    compressedCount: range.length,
    ...(meta ?? {}),
  };
  appendSession({
    archiveRoot, sessionId,
    messages: [{ role: "system", content: `[对话已压缩] ${summary}` }],
    meta: { kind: "summary-event", summaryEvent },
  });
  return {
    ok: true,
    archivedCount: range.length,
    archivePath: sessionPath(archiveRoot, sessionId + "-archive"),
    summaryEvent,
  };
}

/** 会话的当前有效视图：摘要事件 + 未被压缩的消息。恢复 = 只读归档文件回放。 */
export function sessionView(archiveRoot, sessionId) {
  const events = readSession(archiveRoot, sessionId);
  const view = { summary: null, messages: [] };
  for (const ev of events) {
    if (ev.kind === "summary-event" && ev.summaryEvent) {
      view.summary = ev.summaryEvent.summary;
    } else if (Array.isArray(ev.messages)) {
      view.messages.push(...ev.messages);
    }
  }
  return view;
}

/** 列出归档根下所有会话文件（session id → 文件路径）。 */
export function listSessions(archiveRoot) {
  const dir = join(archiveRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => ({ file: f, sessionId: f.replace(/\.jsonl$/, "") }));
}

/** 在归档会话的消息里做全文匹配，返回 { sessionId, message } 命中列表（最多 limit 条）。 */
export function searchArchive(archiveRoot, needle, { limit = 20 } = {}) {
  const needleLower = String(needle ?? "").toLowerCase();
  if (!needleLower) return [];
  const out = [];
  for (const { sessionId } of listSessions(archiveRoot)) {
    for (const event of readSession(archiveRoot, sessionId)) {
      for (const m of event.messages ?? []) {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        if (text && text.toLowerCase().includes(needleLower)) {
          out.push({ sessionId, at: event.at, role: m.role, content: text.slice(0, 400) });
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

#!/usr/bin/env node
/**
 * mcp/server.mjs — 对影记忆上浮的 MCP server（stdio 传输，零依赖）
 *
 * 把引擎暴露为 MCP 工具，任何 MCP 客户端（zcode / claude 系 / 自建 agent）
 * 配置一行 command 即获得"记忆上浮"能力。
 *
 * 配置示例（宿主 MCP 配置）：
 * {
 *   "duiying-memory": {
 *     "command": "node",
 *     "args": ["<本文件路径>"],
 *     "env": { "DUIYING_ROOTS": "D:/记忆库A;D:/记忆库B" }
 *   }
 * }
 *
 * DUIYING_ROOTS：默认语料根，分号分隔（工具参数 root 可逐次覆盖）。
 *
 * 协议：newline-delimited JSON-RPC 2.0（MCP stdio 规约），
 * 实现 initialize / tools/list / tools/call / ping——手写协议子集，无 SDK。
 */
import path from "node:path";
import { search, runDoctor, displayPath } from "../engine/core.mjs";
import { ingest } from "../engine/ingest.mjs";

const VERSION = "0.2.0";
const DEFAULT_ROOTS = (process.env.DUIYING_ROOTS || process.cwd())
  .split(";").map(s => s.trim()).filter(Boolean);
const DEFAULT_EXCLUDE = (process.env.DUIYING_EXCLUDE || "")
  .split(";").map(s => s.trim()).filter(Boolean);

// ---- 工具定义 ----
const TOOLS = [
  {
    name: "memory_surface",
    description: "从长期记忆库检索相关记忆线索（路标：一行一条，含日期/标题/出处/联想邻居）。用户提到过去的决定、事件、偏好、对话时调用。返回的线索供你自然引用——除非用户问起，不要主动罗列。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词，逗号分隔多个；含'最近/上周/去年'等时间词自动切时间优先模式" },
        root: { type: "array", items: { type: "string" }, description: "可选：覆盖默认语料根目录" },
        exclude: { type: "array", items: { type: "string" }, description: "可选：追加排除的目录名（默认排除表之外）" },
        limit: { type: "number", description: "可选：最多返回条数（默认 10）" },
        detail: { type: "boolean", description: "可选：附正文命中摘录" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_doctor",
    description: "记忆库体检：坏链/近重复/标题质量/沉默清单。只报不修。",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "array", items: { type: "string" }, description: "可选：覆盖默认语料根目录" },
        exclude: { type: "array", items: { type: "string" }, description: "可选：追加排除的目录名" },
      },
    },
  },
  {
    name: "memory_ingest",
    description: "向共享记忆库贡献一条记忆（多前端写入协议）。摘要由写入方负责（谁灌的谁写）；原文两种形态二选一：content 落盘灌库，或 source_path 路径标记（原文留原处，库只落薄条目）。channel=来源前端标识（如 zcode/codex/qq-bridge），event=内容事件标签（decision/meeting/insight…自由打）。写入后其他前端即可检索到。",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "记忆摘要（必填，写入方负责；超 40 字自动截标题、全文保留正文）" },
        channel: { type: "string", description: "来源前端标识（必填，如 zcode / codex / qq-bridge）" },
        content: { type: "string", description: "模式 A：原文全文落盘灌库" },
        source_path: { type: "string", description: "模式 B：原文路径标记（原文留原处，库只落薄条目）" },
        event: { type: "string", description: "可选：事件标签（decision / meeting / insight / milestone…自由打）" },
        root: { type: "array", items: { type: "string" }, description: "可选：覆盖默认语料根目录（单值数组）" },
      },
      required: ["summary", "channel"],
    },
  },
];

function asList(v, splitRe = /[;；]/) {
  if (typeof v === "string") return v.split(splitRe).map(s => s.trim()).filter(Boolean);
  if (Array.isArray(v)) return v.flatMap(item => asList(String(item), splitRe));
  return [];
}

function rootsOf(root) {
  const list = asList(root);
  return list.length ? list : DEFAULT_ROOTS;
}

function asLimit(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 10;
  return Math.floor(n);
}

function toolCall(name, args) {
  const mergeExclude = extra => {
    const list = [...DEFAULT_EXCLUDE];
    for (const e of asList(extra, /[;；,，]/)) if (!list.includes(e)) list.push(e);
    return list.length ? list : undefined;
  };
  if (name === "memory_surface") {
    const query = String(args.query ?? "").trim();
    if (!query) return { isError: true, text: "query 不能为空" };
    const roots = rootsOf(args.root);
    const exclude = mergeExclude(args.exclude);
    const r = search({
      roots,
      keywords: query.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      limit: asLimit(args.limit),
      detail: args.detail === true || args.detail === "true" || args.detail === 1,
      exclude,
    });
    let text = `当前：${r.time.line}\n命中 ${r.total} 条（显示 ${r.results.length}）\n${r.hint}\n`;
    for (const x of r.results) {
      text += `\n- [${x.date}] ${x.title} —— ${displayPath(x)} (相关度 ${x.score})`;
      if (x.links.length) text += `\n  关联: ${x.links.join(", ")}`;
      if (x.note) text += `\n  ${x.note}`;
      if (x.excerpt) text += `\n  摘录: ${x.excerpt}`;
    }
    if (r.results.length === 0) {
      text = `当前：${r.time.line}\n没有命中的记忆。换更具体的关键词，或扩大 root 范围。`;
    }
    return { text };
  }
  if (name === "memory_doctor") {
    const roots = rootsOf(args.root);
    const { count, report } = runDoctor(roots, mergeExclude(args.exclude));
    if (report.length === 0) return { text: `语料 ${count} 篇 · 体检通过，无警示项` };
    return {
      text: `语料 ${count} 篇 · ${report.length} 项警示：\n` +
        report.map(r => `- [${r.type}] ${r.file} — ${r.detail}`).join("\n") +
        `\n（doctor 只报不修）`,
    };
  }
  if (name === "memory_ingest") {
    const root = rootsOf(args.root)[0];
    const r = ingest({
      root,
      channel: args.channel,
      summary: args.summary,
      content: args.content,
      source_path: args.source_path,
      event: args.event,
    });
    if (r.error) return { isError: true, text: r.error };
    let text = `✓ 已入库（${r.mode === "inline" ? "落盘灌库" : "路径标记"}）：${path.relative(root, r.file)}\n其他前端连此 MCP 即可检索到这条记忆。`;
    for (const w of r.warnings) text += `\n⚠️ ${w}`;
    return { text };
  }
  return { isError: true, text: `未知工具: ${name}` };
}

// ---- JSON-RPC over stdio（行分隔）----
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handleMessage(line);
  }
});
process.stdin.on("end", () => process.exit(0));

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handleMessage(line) {
  let msg;
  try { msg = JSON.parse(line); } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05", // 固定回本 server 支持的版本，协商由宿主决定
        capabilities: { tools: {} },
        serverInfo: { name: "duiying-memory", version: VERSION },
      },
    });
    return;
  }
  if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
    return; // 通知不回包
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    let out;
    try {
      out = toolCall(name, args);
    } catch (e) {
      out = { isError: true, text: `工具执行失败: ${e.message}` };
    }
    send({
      jsonrpc: "2.0", id,
      result: { content: [{ type: "text", text: out.text }], isError: Boolean(out.isError) },
    });
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

process.stderr.write(`[duiying-memory] v${VERSION} 就绪 · 语料根: ${DEFAULT_ROOTS.map(r => path.basename(r)).join(", ")}\n`);

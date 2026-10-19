#!/usr/bin/env node
/**
 * hooks/user-prompt-surface.mjs — duiying-open 的层级二上浮钩子
 * （UserPromptSubmit：每条用户消息进模型前，自动检索共享记忆库，命中路标注入上下文）
 *
 * zcode 配置（config.json 顶层，hooks.enabled 必须 true）：
 * "hooks": { "enabled": true, "events": { "UserPromptSubmit": [
 *   { "hooks": [ { "type": "process", "command": "node",
 *       "args": ["<本文件路径>"], "timeoutMs": 8000 } ] } ] } }
 *
 * stdin: 事件 JSON（含 prompt 字段=用户消息文本）
 * stdout: {"hookEventName":"UserPromptSubmit","additionalContext":"…"}（无命中输出 {}）
 * 任何异常静默 exit 0——钩子永远不阻塞对话。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // 读 stdin（带超时保护，读不到就空手退出）
  const raw = await Promise.race([
    new Promise(res => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", c => (buf += c));
      process.stdin.on("end", () => res(buf));
      setTimeout(() => res(buf), 1500);
    }),
    new Promise(res => setTimeout(() => res(""), 1500)),
  ]);

  let prompt = "";
  try { prompt = String(JSON.parse(raw).prompt ?? ""); } catch { /* 输入非 JSON 时用空串 */ }
  prompt = prompt.trim();
  if (!prompt) return; // 无话可浮，空输出

  // 语料根：环境变量优先（分号分隔），缺省 = zcode 记忆库 + dig
  const roots = (process.env.DUIYING_HOOK_ROOTS || process.env.DUIYING_HOOK_ROOTS_FALLBACK ||
    "D:/Users/那刻夏zcode/.zcode/memory;D:/Users/那刻夏zcode/dig")
    .split(";").map(s => s.trim()).filter(Boolean);
  // 排除目录：环境变量（逗号分隔）优先；缺省排除常见蒸馏/清洗目录（防工作区产物污染路标）
  const exclude = (process.env.DUIYING_HOOK_EXCLUDE ||
    "源2-提取,清洗批次,蒸馏数据")
    .split(",").map(s => s.trim()).filter(Boolean);

  const coreUrl = pathToFileURL(path.join(HERE, "..", "engine", "core.mjs")).href;
  const { search } = await import(coreUrl);
  const r = search({ roots, keywords: prompt.split(/\s+/).filter(Boolean), limit: 5, detail: false, exclude });
  if (!r.results.length) return;

  const lines = r.results.map(x => `- [${x.date}] ${x.title} —— ${x.path}`);
  const ctx =
    `[记忆上浮 · 共享库自动检索]（与当前消息可能相关的长期记忆线索；自然引用，除非对方问起不要罗列）\n` +
    lines.join("\n");

  process.stdout.write(JSON.stringify({ hookEventName: "UserPromptSubmit", additionalContext: ctx }));
}

main().then(
  () => process.exit(0),
  () => process.exit(0), // 任何异常静默通过——钩子绝不阻塞
);

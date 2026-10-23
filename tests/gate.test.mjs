import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { search } from "../engine/core.mjs";
import { classifyIntent, lexicalScore, anchorKeywords, GATE_TTL_MS } from "../engine/lib.mjs";

const run = promisify(execFile);
const ENGINE = fileURLToPath(new URL("../engine/surface.mjs", import.meta.url));
const SERVER = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
const HOOK = fileURLToPath(new URL("../hooks/user-prompt-surface.mjs", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../examples/partner-xiaolin", import.meta.url));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "duiying-gate-"));
}
function write(dir, rel, body, mtime) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mtime) fs.utimesSync(p, mtime, mtime);
  return p;
}
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ["DUIYING_GATE", "DUIYING_RERANK", "DUIYING_GATE_TTL_MS"]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

test("意图：问候、纯情绪、回忆、话题", () => {
  assert.equal(classifyIntent("你好").intent, "companion");
  assert.equal(classifyIntent("你好").reason, "greeting");
  assert.equal(classifyIntent("你好").prefetch, false);
  assert.equal(classifyIntent("好累").reason, "emotion");
  assert.equal(classifyIntent("好累啊").reason, "emotion");
  assert.equal(classifyIntent("嗯").intent, "companion");
  const recall = classifyIntent("记得上次部署");
  assert.equal(recall.intent, "memory_recall");
  assert.equal(recall.prefetch, true);
  assert.equal(recall.memorySignal, true);
  assert.equal(classifyIntent("部署回滚").reason, "topic");
  assert.equal(classifyIntent("最近").prefetch, false);
  assert.deepEqual(anchorKeywords(["好累", "记得上次部署"]), ["记得上次部署"]);
  assert.deepEqual(anchorKeywords(["好累，记得上次部署"]), ["记得上次部署"]);
});

test("词面分：整段重合高于只堆其中一个词", () => {
  const full = lexicalScore("蓝图归档", "笔记里写了蓝图归档一次");
  const pile = lexicalScore("蓝图归档", "归档".repeat(30));
  assert.ok(full > pile, `${full} 应高于 ${pile}`);
  assert.ok(pile > 0);
});

test("自动门控：问候和纯情绪零条；记得上次部署会浮出", () => {
  const dir = tmp();
  write(dir, "deploy.md", "# 部署记录\n\n上次部署用了快照回滚。\n");
  write(dir, "mood.md", "# 状态\n\n好累。\n");
  write(dir, "hi.md", "# 招呼\n\n你好，今天开始。\n");
  const base = { roots: [dir], useLinks: false, gate: true, gateSession: new Map() };
  const hello = search({ ...base, keywords: ["你好"], queryText: "你好" });
  assert.equal(hello.total, 0);
  assert.equal(hello.gate.reason, "greeting");
  assert.equal(hello.results.length, 0);
  const tired = search({ ...base, keywords: ["好累"], queryText: "好累" });
  assert.equal(tired.total, 0);
  assert.equal(tired.gate.reason, "emotion");
  const recalled = search({
    ...base, keywords: ["记得上次部署"], queryText: "记得上次部署",
  });
  assert.equal(recalled.gate.intent, "memory_recall");
  assert.ok(recalled.results.some(x => x.path === "deploy.md"));
  const mixed = search({
    ...base,
    keywords: ["好累，记得上次部署"],
    queryText: "好累，记得上次部署",
  });
  assert.deepEqual(mixed.results.map(x => x.path), ["deploy.md"]);
  const manual = search({ roots: [dir], keywords: ["你好"], useLinks: false });
  assert.ok(manual.results.some(x => x.path === "hi.md"));
  assert.equal("gate" in manual, false);
});

test("自动门控：同一句在 TTL 内不重复浮", () => {
  const dir = tmp();
  write(dir, "deploy.md", "# 部署记录\n\n上次部署用了快照回滚。\n");
  const session = new Map();
  const now = 1_700_000_000_000;
  const opts = {
    roots: [dir], keywords: ["记得上次部署"], queryText: "记得上次部署",
    useLinks: false, gate: true, gateSession: session,
  };
  const first = search({ ...opts, nowMs: now });
  const again = search({ ...opts, nowMs: now + 1000 });
  const later = search({ ...opts, nowMs: now + GATE_TTL_MS + 1 });
  assert.ok(first.results.length > 0);
  assert.equal(again.total, 0);
  assert.equal(again.gate.reason, "duplicate");
  assert.ok(later.results.length > 0);
});

test("词面重排把同时写到两个词的笔记排到堆词前面，分数仍是融合分量级", () => {
  const dir = tmp();
  const now = new Date(2026, 5, 1).getTime();
  write(dir, "bait.md", "# 归档手册\n\n" + "归档".repeat(50) + "\n", new Date(now - 2 * 86400000));
  write(dir, "overlap.md", "# 笔记\n\n这里同时写了蓝图和归档各一次。\n", new Date(now - 200 * 86400000));
  for (let i = 0; i < 10; i++) {
    write(dir, `f${i}.md`, `# 填料\n\n蓝图背景${i}。\n`, new Date(now - 10 * 86400000));
  }
  const keywords = ["蓝图", "归档"];
  const off = search({ roots: [dir], keywords, useLinks: false, rerank: false, nowMs: now });
  const on = search({ roots: [dir], keywords, useLinks: false, rerank: true, nowMs: now });
  assert.equal(off.results[0].path, "bait.md");
  assert.equal(on.results[0].path, "overlap.md");
  assert.ok(on.results[0].score >= 1, "重排后的分数不该塌成 0–1 的另一套分");
  assert.ok(on.results[0].score <= off.results[0].score * 2);
  assert.equal(on.results[0].path !== undefined && !("lexical" in on.results[0]), true);
});

test("手动 CLI 不门控：只有「最近」仍是空结果，不在这里补最近条目", async () => {
  const { stdout } = await run(process.execPath, [ENGINE, "最近", "--root", EXAMPLE, "--json", "--no-gate"], {
    env: cleanEnv(),
  });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.total, 0);
  assert.deepEqual(parsed.results, []);
  assert.equal(parsed.gate, undefined);
  const gated = await run(process.execPath, [ENGINE, "最近", "--root", EXAMPLE, "--json", "--gate"], {
    env: cleanEnv(),
  });
  const gatedParsed = JSON.parse(gated.stdout);
  assert.equal(gatedParsed.total, 0);
  assert.equal(gatedParsed.gate.allow, false);
});

test("CLI：--gate 挡住问候，不加 --gate 仍能查到", async () => {
  const dir = tmp();
  write(dir, "hi.md", "# 招呼\n\n你好，今天开始。\n");
  write(dir, "deploy.md", "# 部署记录\n\n上次部署用了快照回滚。\n");
  const open = await run(process.execPath, [ENGINE, "你好", "--root", dir, "--json"], { env: cleanEnv() });
  assert.ok(JSON.parse(open.stdout).results.some(x => x.path === "hi.md"));
  const shut = await run(process.execPath, [ENGINE, "你好", "--root", dir, "--json", "--gate"], { env: cleanEnv() });
  const shutParsed = JSON.parse(shut.stdout);
  assert.equal(shutParsed.total, 0);
  assert.equal(shutParsed.gate.reason, "greeting");
  const recalled = await run(process.execPath, [ENGINE, "记得上次部署", "--root", dir, "--json", "--gate"], {
    env: cleanEnv(),
  });
  assert.ok(JSON.parse(recalled.stdout).results.some(x => x.path === "deploy.md"));
});

test("钩子默认门控：问候和纯情绪不注入，记得上次部署会注入", () => {
  const dir = tmp();
  write(dir, "deploy.md", "# 部署记录\n\n上次部署用了快照回滚。\n");
  write(dir, "mood.md", "# 状态\n\n好累。\n");
  write(dir, "hi.md", "# 招呼\n\n你好，今天开始。\n");
  const call = (prompt, extraEnv = {}) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ prompt }),
    encoding: "utf8",
    env: cleanEnv({ DUIYING_HOOK_ROOTS: dir, ...extraEnv }),
  });
  const hello = call("你好");
  assert.equal(hello.status, 0);
  assert.equal(hello.stdout, "");
  const tired = call("好累");
  assert.equal(tired.stdout, "");
  const recalled = call("记得上次部署");
  assert.match(recalled.stdout, /部署记录/);
  assert.match(recalled.stdout, /deploy\.md/);
  const forced = call("你好", { DUIYING_GATE: "0" });
  assert.match(forced.stdout, /招呼/);
});

test("MCP：主动调用默认不门控；gate true 时问候零条", () => {
  const dir = tmp();
  write(dir, "hi.md", "# 招呼\n\n你好，今天开始。\n");
  const call = arguments_ => JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "memory_surface", arguments: arguments_ },
  }) + "\n";
  const open = spawnSync(process.execPath, [SERVER], {
    input: call({ query: "你好", root: dir }),
    encoding: "utf8",
    env: cleanEnv(),
  });
  const openText = JSON.parse(open.stdout.trim().split("\n").at(-1)).result.content[0].text;
  assert.match(openText, /招呼/);
  const shut = spawnSync(process.execPath, [SERVER], {
    input: call({ query: "你好", root: dir, gate: true }),
    encoding: "utf8",
    env: cleanEnv(),
  });
  const shutText = JSON.parse(shut.stdout.trim().split("\n").at(-1)).result.content[0].text;
  assert.match(shutText, /上浮门控未检索/);
  assert.doesNotMatch(shutText, /招呼/);
});

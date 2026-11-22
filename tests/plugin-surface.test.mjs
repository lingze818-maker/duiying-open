import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { recallCandidates, registerCandidateRecall, lastRecallMeta } from "../engine/candidate-recall.mjs";
import { duiyingExtensions } from "../mcp/extensions.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENGINE = fileURLToPath(new URL("../engine/surface.mjs", import.meta.url));
const SERVER = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../examples/partner-xiaolin", import.meta.url));
const CONFIG = fileURLToPath(new URL("../mcp/client.mcp.json", import.meta.url));

test("通用 MCP 配置是粘贴稿，示例库上浮能带回引用", () => {
  const raw = fs.readFileSync(CONFIG, "utf8");
  const cfg = JSON.parse(raw);
  const server = cfg.mcpServers["duiying-memory"];
  assert.equal(server.command, "node");
  assert.equal(server.args.length, 1);
  assert.match(server.args[0], /<插件目录>\/mcp\/server\.mjs$/);
  assert.match(server.env.DUIYING_ROOTS, /^<授权记忆根>$/);
  assert.equal(server.env.DUIYING_HOOK_SYNC, undefined);
  assert.equal(fs.existsSync(path.join(ROOT, "mcp", "server.mjs")), true);
  assert.equal(fs.existsSync(path.join(ROOT, "engine", "surface.mjs")), true);
  assert.doesNotMatch(raw, /installer|claude_desktop|mcp\.json/i);

  const cli = spawnSync(process.execPath, [ENGINE, "部署", "--root", EXAMPLE, "--json"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const payload = JSON.parse(cli.stdout);
  assert.equal(payload.engine, "duiying-open/0.4.0");
  const paths = payload.results.map(item => item.path);
  assert.ok(paths.includes("会议纪要.md"));
  assert.ok(paths.includes("决策记录.md"));
  assert.match(payload.hint, /除非对方问起/);

  const mcp = spawnSync(process.execPath, [SERVER], {
    input: `${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "memory_surface", arguments: { query: "部署", root: [EXAMPLE] } },
    })}\n`,
    encoding: "utf8",
  });
  assert.equal(mcp.status, 0, mcp.stderr);
  const message = JSON.parse(mcp.stdout.trim().split("\n").at(-1));
  const text = message.result.content[0].text;
  assert.match(text, /会议纪要\.md/);
  assert.match(text, /决策记录\.md/);
  assert.match(text, /除非对方问起/);
});

test("Layer 1 后登记的后端优先，排序核心不引用 MiniSearch", () => {
  assert.equal(duiyingExtensions.lexicalRecall, "engine/candidate-recall.mjs");
  assert.equal(duiyingExtensions.lexicalBackend, "engine/recall-minisearch.mjs");
  assert.equal(duiyingExtensions.vectorCandidateSource, null);
  const core = fs.readFileSync(new URL("../engine/core.mjs", import.meta.url), "utf8");
  assert.equal(/minisearch/i.test(core), false);
  let live = true;
  let recalls = 0;
  registerCandidateRecall({
    id: "stand-in",
    available: () => live,
    present: () => false,
    lastMeta: () => ({ id: "stand-in" }),
    recall: () => {
      recalls += 1;
      return null;
    },
    refresh: () => ({ ok: false, reason: "unavailable" }),
  });
  try {
    const hit = recallCandidates({ roots: [EXAMPLE], keywords: ["部署"] });
    assert.equal(hit, null);
    assert.equal(recalls, 1);
    assert.equal(lastRecallMeta().id, "stand-in");
  } finally {
    live = false;
  }
});

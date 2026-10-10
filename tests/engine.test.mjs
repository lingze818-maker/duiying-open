import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, buildStats, bm25, timeBoost, hasTimeWord, buildLinks, spread } from "../engine/lib.mjs";

// ---- tokenize ----
test("tokenize: CJK 切 bigram", () => {
  assert.deepEqual(tokenize("记忆上浮"), ["记忆", "忆上", "上浮"]);
});
test("tokenize: 英文数字整串", () => {
  assert.deepEqual(tokenize("BM25 rocks 42"), ["bm25", "rocks", "42"]);
});
test("tokenize: 中英混合不串味", () => {
  const t = tokenize("用node写引擎");
  assert.ok(t.includes("node"));
  assert.ok(t.includes("用n") === false); // 英文不参与 CJK bigram
  assert.ok(t.some(x => x.includes("写")));
});
test("tokenize: 大小写归一", () => {
  assert.deepEqual(tokenize("ABC"), tokenize("abc"));
});

// ---- BM25 ----
function mkDoc(text) {
  const tf = new Map();
  let len = 0;
  for (const t of tokenize(text)) { tf.set(t, (tf.get(t) || 0) + 1); len++; }
  return { tf, len };
}
test("bm25: 命中多的文档得分更高", () => {
  const docs = [mkDoc("今天讨论了部署方案"), mkDoc("部署方案 部署方案 部署 回滚方案")];
  const stats = buildStats(docs);
  const q = tokenize("部署方案");
  const s0 = bm25(q, docs[0], stats);
  const s1 = bm25(q, docs[1], stats);
  assert.ok(s1 > s0, `密集命中(${s1}) 应高于稀疏命中(${s0})`);
});
test("bm25: 未命中得分为 0", () => {
  const docs = [mkDoc("完全无关的内容")];
  const stats = buildStats(docs);
  assert.equal(bm25(tokenize("部署"), docs[0], stats), 0);
});

// ---- 时间先验 ----
test("timeBoost: 新记忆加权高于旧记忆", () => {
  const now = Date.now();
  const fresh = timeBoost(now - 5 * 86400000, now, false);
  const old = timeBoost(now - 200 * 86400000, now, false);
  assert.ok(fresh > old);
});
test("timeBoost: 时间词模式放大差距", () => {
  const now = Date.now();
  const fresh = timeBoost(now - 5 * 86400000, now, true);
  assert.equal(fresh, 1.6);
});
test("hasTimeWord: 识别时间词", () => {
  assert.ok(hasTimeWord("最近的项目"));
  assert.ok(hasTimeWord("上周开会"));
  assert.equal(hasTimeWord("部署方案"), false);
});

// ---- 建链与扩散 ----
test("buildLinks: 相似文档互链", () => {
  const a = new Set(tokenize("部署方案 回滚 数据库"));
  const b = new Set(tokenize("部署方案 回滚 流程"));
  const c = new Set(tokenize("樱花 苗圃 浇水"));
  const links = buildLinks([a, b, c]);
  assert.ok(links[0].some(([j]) => j === 1), "a-b 应互链");
  assert.equal(links[0].some(([j]) => j === 2), false, "a-c 不应链");
});
test("spread: 命中沿链把分数分给邻居", () => {
  const links = [[[1, 0.5]], [[0, 0.5]], []];
  const scores = [10, 0, 0];
  spread(scores, links);
  assert.ok(scores[1] > 0, "邻居应获得扩散分");
  assert.ok(scores[2] === 0, "无链者不获得");
});

// ---- 端到端：临时语料 + CLI JSON 输出 ----
test("CLI 端到端: --root 临时语料 --json 可解析且排序合理", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  const dir = mkdtempSync(path_join(tmpdir(), "duiying-test-"));
  mkdirSync(path_join(dir, "sub"), { recursive: true });
  writeFileSync(path_join(dir, "deploy.md"), "# 部署方案\n\n回滚流程：先停服务，再还原数据库快照。\n");
  writeFileSync(path_join(dir, "sub", "garden.md"), "# 樱花园\n\n樱花苗圃每周浇水两次。\n");
  writeFileSync(path_join(dir, "rollback.md"), "# 回滚预案\n\n部署失败时执行回滚，回滚前备份当前版本。\n");

  try {
    const engine = new URL("../engine/surface.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const { stdout } = await run("node", [engine, "部署,回滚", "--root", dir, "--json", "--detail"]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.engine, "duiying-open/0.2");
    assert.ok(parsed.total >= 2);
    assert.ok(parsed.hint.includes("不要主动罗列"));
    const paths = parsed.results.map(r => r.path);
    assert.ok(paths.includes("deploy.md") || paths.includes("rollback.md"));
    // 排序：同时命中双词的应靠前
    assert.ok(parsed.results[0].score >= parsed.results[parsed.results.length - 1].score);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import path from "node:path";
function path_join(...args) { return path.join(...args); }

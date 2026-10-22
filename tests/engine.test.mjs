import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, buildStats, bm25, timeBoost, hasTimeWord, buildLinks, spread, overlapRatio, formatLocalDate } from "../engine/lib.mjs";

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
  assert.ok(hasTimeWord("what changed recently"));
  assert.ok(hasTimeWord("last week"));
  assert.equal(hasTimeWord("deployment"), false);
});
test("formatLocalDate: 本地日历日", () => {
  assert.equal(formatLocalDate(new Date(2026, 0, 2, 1, 30, 0)), "2026-01-02");
});
test("overlapRatio: 短集合去比对长集合，而不是跟自己比", () => {
  const big = new Set(["部署", "回滚", "快照", "停服"]);
  const other = new Set(["樱花"]);
  assert.equal(overlapRatio(big, other), 0);
  assert.equal(overlapRatio(other, big), 0);
  assert.equal(overlapRatio(new Set(), big), 0);
  assert.ok(overlapRatio(big, new Set(["部署", "回滚", "快照"])) >= 0.75);
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

test("exclude: 排除目录后不再进语料", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const dir = mkdtempSync((await import("node:path")).join(tmpdir(), "exc-"));
  mkdirSync((await import("node:path")).join(dir, "工作区"), { recursive: true });
  writeFileSync((await import("node:path")).join(dir, "keep.md"), "# 保留\n\n部署部署部署\n");
  writeFileSync((await import("node:path")).join(dir, "工作区", "drop.md"), "# 排除\n\n部署部署部署部署部署\n");
  try {
    const engine = new URL("../engine/surface.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const { stdout: withDir } = await run("node", [engine, "部署", "--root", dir, "--json"]);
    const { stdout: noDir } = await run("node", [engine, "部署", "--root", dir, "--json", "--exclude", "工作区"]);
    const a = JSON.parse(withDir), b = JSON.parse(noDir);
    assert.ok(a.results.some(r => r.path.includes("工作区")));
    assert.ok(!b.results.some(r => r.path.includes("工作区")), "排除目录不应出现在结果");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("time anchor: 一次调用同时返回时间锚与记忆线索", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const dir = mkdtempSync(join(tmpdir(), "time-"));
  writeFileSync(join(dir, "a.md"), "# 部署\n\n部署部署\n");
  try {
    const engine = new URL("../engine/surface.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const { stdout } = await run("node", [engine, "部署", "--root", dir, "--json"]);
    const d = JSON.parse(stdout);
    assert.ok(d.time, "JSON 应含 time 锚");
    assert.match(d.time.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(d.time.weekday.startsWith("星期"));
    assert.match(d.time.time, /^\d{2}:\d{2}$/);
    assert.ok(d.time.line.includes(d.time.weekday) && d.time.line.includes(d.time.period));
    assert.ok(d.time.line.startsWith(d.time.date));
    assert.match(d.time.iso, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("synonyms: 查'头疼'能命中只写'头痛'的语料", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const dir = mkdtempSync(join(tmpdir(), "syn-"));
  // 语料只写「头痛」，一个字「疼」都不出现
  writeFileSync(join(dir, "case.md"), "# 病案\n\n2026-10-03 头痛危机，颈源性，已定位。\n");
  writeFileSync(join(dir, "noise.md"), "# 无关\n\n部署部署部署\n");
  try {
    const engine = new URL("../engine/surface.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const { stdout } = await run("node", [engine, "头疼", "--root", dir, "--json"]);
    const d = JSON.parse(stdout);
    assert.ok(d.results.some(r => r.path.includes("case.md")), "同义词扩展应命中只写'头痛'的文档: " + JSON.stringify(d.results.map(r => r.path)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

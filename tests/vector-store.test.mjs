import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cosine, topK, LocalFileStore, SOFT_LIMIT } from "../engine/vector-store.mjs";

const DIRS = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "duiying-vec-"));
  DIRS.push(dir);
  return dir;
}
test.after(() => {
  for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

// ---- 纯函数层 ----

test("cosine: 同向=1、正交=0、反向=-1、零向量=0", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(Math.abs(cosine([1, 0], [0, 1])) < 1e-9, true);
  assert.equal(cosine([1, 0], [-1, 0]), -1);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

test("cosine: 维度不等返回 0（不抛错，防御性）", () => {
  assert.equal(cosine([1, 0], [1, 0, 0]), 0);
});

test("topK: 按相似度降序、截断 k、零相似不出现", () => {
  const entries = [
    { id: "a", vec: [1, 0] },
    { id: "b", vec: [0.9, 0.1] },
    { id: "c", vec: [0, 1] },   // 与 query 正交，score=0，不应出现
    { id: "d", vec: [-1, 0] },  // 反向，score=-1，不应出现
  ];
  const got = topK([1, 0], entries, 2);
  assert.deepEqual(got.map(x => x.id), ["a", "b"]);
  assert.ok(got[0].score > got[1].score);
});

// ---- LocalFileStore ----

test("store: 未 load 就用会报错（强制显式加载纪律）", () => {
  const store = new LocalFileStore(scratch(), { dim: 4 });
  assert.throws(() => store.stats(), /先调用 load/);
});

test("store: upsert→search 最近邻正确，维度不匹配报错", () => {
  const store = new LocalFileStore(scratch(), { dim: 4 }).load();
  store.upsert([
    { id: "服务器宕机.md", vec: [1, 0, 0, 0] },
    { id: "服务中断.md", vec: [0.95, 0.3, 0, 0] },  // 语义相近 → 向量相近
    { id: "团建照片.md", vec: [0, 0, 1, 0] },
  ]);
  const got = store.search([1, 0.1, 0, 0], 2);
  assert.deepEqual(got.map(x => x.id), ["服务器宕机.md", "服务中断.md"]);
  assert.throws(() => store.upsert([{ id: "bad", vec: [1, 2] }]), /维度/);
  assert.throws(() => store.search([1, 2], 2), /维度/);
});

test("store: 同 id upsert 覆盖（原位更新）", () => {
  const store = new LocalFileStore(scratch(), { dim: 2 }).load();
  store.upsert([{ id: "x", vec: [1, 0] }]);
  store.upsert([{ id: "x", vec: [0, 1] }]);
  assert.equal(store.stats().count, 1);
  const got = store.search([0, 1], 1);
  assert.equal(got[0].id, "x");
  assert.ok(got[0].score > 0.99);
});

test("store: remove 后检索排除该条；不存在的 id 静默", () => {
  const store = new LocalFileStore(scratch(), { dim: 2 }).load();
  store.upsert([
    { id: "keep", vec: [1, 0] },
    { id: "drop", vec: [0.99, 0.05] },
  ]);
  store.remove(["drop", "不存在"]);
  const got = store.search([1, 0], 10);
  assert.deepEqual(got.map(x => x.id), ["keep"]);
});

test("store: flush→重新 load 持久化往返一致", () => {
  const dir = scratch();
  const first = new LocalFileStore(dir, { dim: 3 }).load();
  first.upsert([
    { id: "纪要A.md", vec: [0.1, 0.2, 0.3] },
    { id: "纪要B.md", vec: [0.7, -0.2, 0.5] },
    { id: "已删.md", vec: [1, 1, 1] },
  ]);
  first.remove(["已删.md"]);
  first.flush();

  assert.ok(existsSync(join(dir, "vectors.bin")));
  assert.ok(existsSync(join(dir, "vectors.meta.json")));

  const second = new LocalFileStore(dir, { dim: 3 }).load();
  assert.equal(second.stats().count, 2); // compaction 后已删条目不回来
  const got = second.search([0.1, 0.2, 0.3], 1);
  assert.equal(got[0].id, "纪要A.md");
  assert.ok(got[0].score > 0.999);
});

test("store: rebuild 换维度清空，重灌后正常", () => {
  const dir = scratch();
  const store = new LocalFileStore(dir, { dim: 2 }).load();
  store.upsert([{ id: "old", vec: [1, 0] }]);
  store.rebuild(8);
  assert.equal(store.stats().count, 0);
  assert.equal(store.stats().dim, 8);
  store.upsert([{ id: "new", vec: [1, 0, 0, 0, 0, 0, 0, 0] }]);
  assert.equal(store.search([1, 0, 0, 0, 0, 0, 0, 0], 1)[0].id, "new");
});

test("store: 空库 search 返回空数组；stats 报 overLimit 语义", () => {
  const store = new LocalFileStore(scratch(), { dim: 2 }).load();
  assert.deepEqual(store.search([1, 0], 5), []);
  const s = store.stats();
  assert.equal(s.overLimit, false);
  assert.equal(s.softLimit, SOFT_LIMIT);
});

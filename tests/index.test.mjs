import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { search } from "../engine/core.mjs";
import {
  INDEX_DIR_NAME, INDEX_FILE_NAME, refreshIndex, recallBackendAvailable, lastRecallMeta, indexPresent,
  vectorCandidateSource,
} from "../engine/candidate-recall.mjs";
import { duiyingExtensions } from "../mcp/extensions.mjs";
import { checkFrozenSet, loadFrozen } from "./frozen-eval.mjs";

const EXAMPLE = path.resolve("examples/partner-xiaolin");
const available = recallBackendAvailable();

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "duiying-index-"));
}
function write(dir, rel, body, mtime) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mtime) fs.utimesSync(p, mtime, mtime);
  return p;
}
function indexFile(root) {
  return path.join(root, INDEX_DIR_NAME, INDEX_FILE_NAME);
}

test("向量候选源预留且默认关闭", () => {
  assert.equal(vectorCandidateSource(), null);
  assert.equal(duiyingExtensions.vectorCandidateSource, null);
  const ext = fs.readFileSync(new URL("../mcp/extensions.mjs", import.meta.url), "utf8");
  const recall = fs.readFileSync(new URL("../engine/candidate-recall.mjs", import.meta.url), "utf8");
  assert.equal(/onnx|transformers|bge-|@huggingface/i.test(ext + recall), false);
});

test("排序层不引用 MiniSearch", () => {
  const core = fs.readFileSync(new URL("../engine/core.mjs", import.meta.url), "utf8");
  const lib = fs.readFileSync(new URL("../engine/lib.mjs", import.meta.url), "utf8");
  const surface = fs.readFileSync(new URL("../engine/surface.mjs", import.meta.url), "utf8");
  assert.equal(/minisearch/i.test(core), false);
  assert.equal(/minisearch/i.test(lib), false);
  assert.equal(surface.includes("recall-minisearch"), false);
  assert.equal(core.includes("candidate-recall"), true);
});

test("没有索引或索引损坏时，结果与强制全量扫描相同", () => {
  const dir = tmp();
  write(dir, "a.md", "# 甲\n\n部署方案写在这里。\n");
  write(dir, "b.md", "---\nsuppress: true\n---\n# 乙\n\n部署方案但整篇沉默。\n");
  const full = search({ roots: [dir], keywords: ["部署方案"], useLinks: false, index: false });
  const missing = search({ roots: [dir], keywords: ["部署方案"], useLinks: false });
  assert.deepEqual(missing.results.map(r => r.path), full.results.map(r => r.path));
  fs.mkdirSync(path.join(dir, INDEX_DIR_NAME), { recursive: true });
  fs.writeFileSync(indexFile(dir), "{ not json");
  const broken = search({ roots: [dir], keywords: ["部署方案"], useLinks: false });
  assert.deepEqual(broken.results.map(r => r.path), full.results.map(r => r.path));
  assert.equal(broken.results.some(r => r.path === "b.md"), false);
});

test("增量增删改、按根分片、冻结集与示例库不退步", { skip: !available && "minisearch 未安装" }, () => {
  const parent = tmp();
  const a = path.join(parent, "a");
  const b = path.join(parent, "b");
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  write(a, "keep.md", "# 保留\n\n雾港班次只记在这一篇。\n");
  write(a, "edit.md", "# 旧稿\n\n这里原来写北岸旧词。\n");
  write(b, "other.md", "# 另一根\n\n雾港班次也出现，但属于另一个授权根。\n");
  const builtA = refreshIndex(a, { create: true });
  const builtB = refreshIndex(b, { create: true });
  assert.equal(builtA.ok, true);
  assert.equal(builtA.added, 2);
  assert.equal(builtB.added, 1);
  assert.equal(fs.existsSync(indexFile(a)), true);
  assert.equal(fs.existsSync(indexFile(b)), true);
  assert.equal(fs.existsSync(path.join(parent, INDEX_DIR_NAME)), false);

  const again = refreshIndex(a, { create: true });
  assert.equal(again.added, 0);
  assert.equal(again.updated, 0);
  assert.equal(again.removed, 0);
  assert.equal(again.unchanged, 2);

  write(a, "edit.md", "# 新稿\n\n改成北岸灯塔口令。\n");
  const edited = refreshIndex(a, { create: true });
  assert.equal(edited.updated, 1);
  assert.equal(edited.added, 0);
  assert.equal(edited.unchanged, 1);
  const otherUntouched = refreshIndex(b, { create: true });
  assert.equal(otherUntouched.unchanged, 1);
  assert.equal(otherUntouched.updated, 0);

  write(a, "fresh.md", "# 新增\n\n槲寄生口令只在新文件。\n");
  fs.rmSync(path.join(a, "keep.md"));
  const delta = refreshIndex(a, { create: true });
  assert.equal(delta.added, 1);
  assert.equal(delta.removed, 1);
  assert.equal(delta.unchanged, 1);

  const found = search({ roots: [a], keywords: ["北岸灯塔"], useLinks: false });
  assert.deepEqual(found.results.map(r => r.path), ["edit.md"]);
  const addedHit = search({ roots: [a], keywords: ["槲寄生"], useLinks: false });
  assert.deepEqual(addedHit.results.map(r => r.path), ["fresh.md"]);
  const gone = search({ roots: [a], keywords: ["雾港班次"], useLinks: false });
  assert.equal(gone.results.some(r => r.path === "keep.md"), false);
  const onlyB = search({ roots: [b], keywords: ["雾港班次"], useLinks: false });
  assert.deepEqual(onlyB.results.map(r => r.path), ["other.md"]);
  const meta = lastRecallMeta();
  assert.equal(meta.shardDocs, 1);
  assert.ok(meta.materialized <= 1);

  // 一个根没有索引时，不拿另一根的索引凑结果。
  const mixed = search({ roots: [a, b], keywords: ["槲寄生口令"], useLinks: false, index: false });
  fs.rmSync(indexFile(b));
  assert.equal(indexPresent(b), false);
  const fallback = search({ roots: [a, b], keywords: ["槲寄生口令"], useLinks: false });
  assert.deepEqual(fallback.results.map(r => r.path), mixed.results.map(r => r.path));

  const sup = tmp();
  write(sup, "show.md", "# 可见\n\n青岚浇灌写在苗圃。\n");
  write(sup, "hide.md", "---\nsuppress_when: [浇灌]\n---\n# 条件沉默\n\n青岚浇灌不要在这个词下浮出。\n");
  write(sup, "old.md", "---\nsuperseded_by: next.md\n---\n# 旧\n\n部署方案第一版。\n");
  write(sup, "next.md", "# 新\n\n部署方案第二版。\n");
  write(sup, "near.md", "# 近形\n\n网和路是分开记的。\n");
  refreshIndex(sup, { create: true });
  const hidden = search({ roots: [sup], keywords: ["青岚浇灌"], useLinks: false });
  assert.equal(hidden.results.some(r => r.path === "hide.md"), false);
  assert.ok(hidden.results.some(r => r.path === "show.md"));
  const replaced = search({ roots: [sup], keywords: ["部署方案"], useLinks: false });
  assert.match(replaced.results.find(r => r.path === "old.md").note, /next\.md/);
  const uni = search({ roots: [sup], keywords: ["网路"], useLinks: false });
  assert.equal(uni.results[0].path, "near.md");
  assert.equal(uni.results[0].note, "按单字近似匹配");

  const copied = tmp();
  fs.cpSync(EXAMPLE, copied, { recursive: true });
  assert.equal(refreshIndex(copied, { create: true }).ok, true);
  const deployFull = search({ roots: [copied], keywords: ["部署"], limit: 10, index: false });
  const deployIdx = search({ roots: [copied], keywords: ["部署"], limit: 10 });
  const deployPaths = deployIdx.results.map(r => r.path);
  assert.ok(deployPaths.indexOf("会议纪要.md") < deployPaths.indexOf("决策记录.md"));
  assert.ok(deployPaths.includes("协作偏好.md"));
  assert.ok(deployIdx.results.every(r => r.path !== "README.md" && !r.links.includes("README.md")));
  assert.match(deployIdx.results.find(r => r.path === "决策记录.md").note, /会议纪要\.md/);
  const sqlite = search({ roots: [copied], keywords: ["SQLite"], limit: 10 });
  const sqlitePaths = sqlite.results.map(r => r.path);
  assert.ok(sqlitePaths.indexOf("决策记录.md") < sqlitePaths.indexOf("会议纪要.md"));
  assert.equal(sqlite.results.find(r => r.path === "决策记录.md").note, undefined);
  const sql = search({ roots: [copied], keywords: ["手写 SQL"], limit: 10 });
  assert.equal(sql.results.find(r => r.path === "决策记录.md").note, undefined);
  const recentFull = search({ roots: [copied], keywords: ["最近"], queryText: "最近", limit: 10, index: false });
  const recentIdx = search({ roots: [copied], keywords: ["最近"], queryText: "最近", limit: 10 });
  assert.deepEqual(recentIdx.results.map(r => r.path), recentFull.results.map(r => r.path));
  assert.ok(deployFull.results.length >= 1);

  const frozenRoot = tmp();
  fs.cpSync(path.resolve("evals/frozen/2026-11-22"), path.join(frozenRoot, "frozen"), { recursive: true });
  const frozenDir = path.join(frozenRoot, "frozen");
  const { spec } = loadFrozen(frozenDir);
  const fixtures = path.join(frozenDir, "fixtures");
  for (const name of spec.roots ? ["qinglan", "lumen"] : ["qinglan", "lumen"]) {
    const report = refreshIndex(path.join(fixtures, name), { create: true });
    assert.equal(report.ok, true, name);
  }
  const failures = checkFrozenSet(fixtures, spec);
  assert.deepEqual(failures, [], failures.map(f => `${f.id}: ${f.errors.join("; ")}`).join("\n"));
});

test("虚构大库：索引查询不读完全部正文，并仍守住沉默", { skip: !available && "minisearch 未安装" }, () => {
  const dir = tmp();
  const n = 1200;
  for (let i = 0; i < n; i++) {
    const id = String(i).padStart(4, "0");
    write(dir, `雾港班次${id}.md`, `# 雾港班次${id}\n\n虚构班次 ${id}。码头灯语与潮汐表无关。\n`);
  }
  write(dir, "rare.md", "# 北岸灯塔\n\n只有这一篇写了北岸灯塔口令。\n");
  write(dir, "sealed.md", "---\nsuppress: true\n---\n# 封存\n\n北岸灯塔口令不该浮出。\n");
  const built = refreshIndex(dir, { create: true });
  assert.equal(built.docs, n + 2);

  const fullStarted = process.hrtime.bigint();
  const full = search({ roots: [dir], keywords: ["北岸灯塔口令"], useLinks: false, index: false });
  const fullMs = Number(process.hrtime.bigint() - fullStarted) / 1e6;

  const warm = refreshIndex(dir, { create: true });
  assert.equal(warm.unchanged, n + 2);
  assert.equal(warm.updated, 0);

  const idxStarted = process.hrtime.bigint();
  const indexed = search({ roots: [dir], keywords: ["北岸灯塔口令"], useLinks: false });
  const idxMs = Number(process.hrtime.bigint() - idxStarted) / 1e6;
  const meta = lastRecallMeta();

  assert.deepEqual(indexed.results.map(r => r.path), ["rare.md"]);
  assert.deepEqual(full.results.map(r => r.path), ["rare.md"]);
  assert.equal(indexed.results.some(r => r.path === "sealed.md"), false);
  assert.ok(meta.materialized < 10, `materialized ${meta.materialized}`);
  assert.ok(meta.shardDocs > 1000);
  console.log(`[index-bench] files=${n + 2} full_scan_ms=${fullMs.toFixed(1)} index_query_ms=${idxMs.toFixed(1)} materialized=${meta.materialized}`);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { search } from "../engine/core.mjs";

const DIRS = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "duiying-fusion-"));
  DIRS.push(dir);
  return dir;
}
test.after(() => {
  for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

/** 假 VectorStore：预定义「向量检索」结果（id=rel），不真算向量——融合逻辑的确定性测试。 */
function mockStore(hitsByQuery) {
  return {
    search(vec, k) {
      const hits = hitsByQuery[vec.tag] ?? [];
      return hits.slice(0, k);
    },
  };
}

test("融合: 语义命中「用词不同」的文档并标注 match=semantic", () => {
  const dir = scratch();
  // 语料与查询刻意零词面交集：「主机宕机」的 bigram（主机/机宕/宕机）不在「服务中断」里出现
  writeFileSync(join(dir, "服务中断.md"), "# 服务中断\n\n生产环境服务中断两小时，根因是数据库连接池耗尽。\n");
  writeFileSync(join(dir, "团建纪要.md"), "# 团建纪要\n\n季度团建安排在月末，自愿报名。\n");
  const store = mockStore({ 宕机vec: [{ id: "服务中断.md", score: 0.87 }] });
  const r = search({
    roots: [dir],
    keywords: ["主机宕机"],
    vector: { store, queryVec: { tag: "宕机vec" } },
  });
  const hit = r.results.find(x => x.path === "服务中断.md");
  assert.ok(hit, "语义近邻应被召回: " + JSON.stringify(r.results.map(x => x.path)));
  assert.equal(hit.match, "semantic");
});

test("融合: 词面与语义同时命中 → match=both，融合分高于单一来源", () => {
  const dir = scratch();
  writeFileSync(join(dir, "部署.md"), "# 部署\n\n部署方案需要记住。服务部署用 Docker。\n");
  writeFileSync(join(dir, "日常.md"), "# 日常\n\n今天天气不错。\n");
  const store = mockStore({ tag: [{ id: "部署.md", score: 0.9 }] });
  const fused = search({
    roots: [dir], keywords: ["部署"], vector: { store, queryVec: { tag: "tag" } },
  });
  const plain = search({ roots: [dir], keywords: ["部署"] });
  const fHit = fused.results.find(x => x.path === "部署.md");
  const pHit = plain.results.find(x => x.path === "部署.md");
  assert.ok(fHit, "融合结果里应有部署.md");
  assert.ok(pHit, "纯词面结果里应有部署.md");
  assert.equal(fHit.match, "both");
  assert.ok(fHit.score >= pHit.score, `融合分 ${fHit.score} 应不低于纯词面 ${pHit.score}`);
  // 纯词面路径（无 vector）结果不带 match 字段——现状行为不变
  assert.equal(pHit.match, undefined);
});

test("融合: 沉默条目不因语义分复活", () => {
  const dir = scratch();
  writeFileSync(join(dir, "可见.md"), "# 可见\n\n部署方案确定，相关内容在这里。\n");
  writeFileSync(join(dir, "沉默.md"), "---\nsuppress: true\n---\n# 沉默\n\n部署方案也写了但不要浮。\n");
  const store = mockStore({ tag: [{ id: "沉默.md", score: 0.95 }] });
  const r = search({
    roots: [dir], keywords: ["部署方案"], vector: { store, queryVec: { tag: "tag" } },
  });
  assert.ok(!r.results.some(x => x.path === "沉默.md"), "沉默条目不得出现在结果里");
});

test("融合: 只问时间路径不受向量路干扰", () => {
  const dir = scratch();
  writeFileSync(join(dir, "a.md"), "# 笔记\n\n2026-01-05 发生的事。\n");
  const store = mockStore({ tag: [{ id: "a.md", score: 0.9 }] });
  const r = search({
    roots: [dir], keywords: ["最近"], queryText: "最近",
    vector: { store, queryVec: { tag: "tag" } },
  });
  // 只问时间走发生日路径，向量路被跳过——不报错即通过
  assert.ok(Array.isArray(r.results));
});

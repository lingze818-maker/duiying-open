import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, applyMemoryState, doctor } from "../engine/lib.mjs";

// ---- ⑥ frontmatter 解析（零依赖 YAML 子集：key: value / key: [a, b]）----
test("parseFrontmatter: 解析 superseded_by 与 suppress 字段", () => {
  const md = `---
title: 旧版部署方案
superseded_by: 决策记录.md
suppress_when: [离职, 裁员]
---

# 正文开始`;
  const fm = parseFrontmatter(md);
  assert.equal(fm.get("superseded_by"), "决策记录.md");
  assert.deepEqual(fm.get("suppress_when"), ["离职", "裁员"]);
  assert.equal(fm.get("title"), "旧版部署方案");
});
test("parseFrontmatter: 无 frontmatter 返回空 Map", () => {
  assert.equal(parseFrontmatter("# 只有正文").size, 0);
});
test("parseFrontmatter: frontmatter 不闭合按正文处理", () => {
  const md = "---\nbroken: [未闭合\n# 正文";
  assert.equal(parseFrontmatter(md).size, 0);
});
test("parseFrontmatter: UTF-8 BOM 不挡住头部", () => {
  const fm = parseFrontmatter("\uFEFF---\nsuppress: true\n---\n# 正文");
  assert.equal(fm.get("suppress"), "true");
});

// ---- ⑥ 取代标记：降权 + 附注，不消失 ----
test("superseded: 被取代条目降权并附注", () => {
  const docs = [
    { rel: "旧方案.md", score: 10, fm: new Map([["superseded_by", "新方案.md"]]) },
    { rel: "新方案.md", score: 8, fm: new Map() },
  ];
  const { notes } = applyMemoryState(docs);
  assert.ok(docs[0].score < 10, "被取代条目应降权");
  assert.ok(docs[0].score > 0, "但不应消失——取代而非删除");
  assert.ok(notes.get("旧方案.md").includes("新方案.md"), "附注指向取代者");
  assert.equal(docs[1].score, 8, "正常条目不动");
});

// ---- ⑦ 沉默列表：浮不上来 ≠ 删掉 ----
test("suppress: 整篇沉默的条目从结果剔除", () => {
  const docs = [
    { rel: "正常.md", score: 5, fm: new Map() },
    { rel: "沉默.md", score: 99, fm: new Map([["suppress", "true"]]) },
  ];
  const { kept } = applyMemoryState(docs);
  assert.ok(kept.some(d => d.rel === "正常.md"));
  assert.ok(!kept.some(d => d.rel === "沉默.md"), "suppress:true 整篇不浮");
});
test("suppress_when: 条件沉默——命中指定关键词时才不浮", () => {
  const docs = [
    { rel: "敏感.md", score: 9, fm: new Map([["suppress_when", ["裁员"]]]) },
  ];
  const hit = applyMemoryState(docs, { query: ["裁员", "方案"] }).kept;
  const phrase = applyMemoryState(docs, { query: ["公司裁员方案"] }).kept;
  const miss = applyMemoryState(docs, { query: ["福利方案"] }).kept;
  assert.equal(hit.length, 0, "查询含敏感词→不浮");
  assert.equal(phrase.length, 0, "整句关键词里含敏感词也要沉默");
  assert.equal(miss.length, 1, "查询不含→正常浮");
});
test("suppress: True 与 true 一样整篇沉默", () => {
  const { kept } = applyMemoryState([
    { rel: "沉默.md", score: 3, fm: new Map([["suppress", "True"]]) },
  ]);
  assert.equal(kept.length, 0);
});

// ---- ⑧ doctor 体检 ----test
test("doctor: 坏链检测——superseded_by 指向不存在的文件", () => {
  const docs = [
    { rel: "a.md", title: "A", fm: new Map([["superseded_by", "不存在的.md"]]), tokens: new Set(["部署", "回滚"]) },
    { rel: "b.md", title: "B", fm: new Map(), tokens: new Set(["樱花", "浇水"]) },
  ];
  const report = doctor(docs);
  assert.ok(report.some(r => r.type === "broken_link" && r.file === "a.md"));
});
test("doctor: 重复检测——高重合度条目警示", () => {
  const docs = [
    { rel: "a.md", title: "A", fm: new Map(), tokens: new Set(["部署", "回滚", "快照", "停服"]) },
    { rel: "b.md", title: "B", fm: new Map(), tokens: new Set(["部署", "回滚", "快照", "停服", "备份"]) },
  ];
  const report = doctor(docs);
  assert.ok(report.some(r => r.type === "near_duplicate"));
});
test("doctor: 沉默条目清单提醒——人工定期复核", () => {
  const docs = [
    { rel: "正常.md", title: "N", fm: new Map(), tokens: new Set(["a"]) },
    { rel: "沉默.md", title: "S", fm: new Map([["suppress", "true"]]), tokens: new Set(["b"]) },
  ];
  const report = doctor(docs);
  assert.ok(report.some(r => r.type === "suppressed_list"));
});

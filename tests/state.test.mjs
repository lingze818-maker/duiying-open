import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, applyMemoryState, doctor, memoryKey, supersessionApplies } from "../engine/lib.mjs";

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
  assert.equal(notes.get(memoryKey(docs[0])), notes.get("旧方案.md"));
  assert.equal(docs[1].score, 8, "正常条目不动");
});
test("supersessionApplies: 多段里没被重述的决定不算被取代", () => {
  const old = `---
superseded_by: next.md
---
# 记录

## 选型
定了用 SQLite，手写 SQL。

## 部署方案
回滚流程：先停服务，再还原快照。
`;
  const next = "# 纪要\n\n部署方案评审通过，回滚流程补了自动化。\n";
  assert.equal(supersessionApplies(old, next, ["SQLite"]), false);
  assert.equal(supersessionApplies(old, next, ["手写 SQL"]), false);
  assert.equal(supersessionApplies(old, next, ["部署"]), true);
  assert.equal(supersessionApplies(old, next, ["最近"]), false);
  const whole = "# 旧部署\n\n部署方案第一版。\n";
  const rewritten = "# 新部署\n\n完全换了一套说法。\n";
  assert.equal(supersessionApplies(whole, rewritten, ["部署方案"]), true);
});
test("superseded: 不同根的同名文件各有附注", () => {
  const docs = [
    { root: "/bank-a", rel: "note.md", score: 10, fm: new Map([["superseded_by", "next.md"]]) },
    { root: "/bank-b", rel: "note.md", score: 10, fm: new Map([["superseded_by", "other.md"]]) },
  ];
  const { notes } = applyMemoryState(docs);
  assert.match(notes.get(memoryKey(docs[0])), /next\.md/);
  assert.match(notes.get(memoryKey(docs[1])), /other\.md/);
  assert.notEqual(notes.get(memoryKey(docs[0])), notes.get(memoryKey(docs[1])));
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
test("doctor: 多根同名文件不跨根判重，坏链按各自的根，file 带根", () => {
  const shared = new Set(["部署", "回滚", "快照", "停服"]);
  const docs = [
    { root: "/bank-a", rel: "note.md", title: "A", fm: new Map([["superseded_by", "next.md"]]), tokens: shared },
    { root: "/bank-a", rel: "next.md", title: "A 的新方案", fm: new Map(), tokens: new Set(["新方", "方案"]) },
    { root: "/bank-b", rel: "note.md", title: "B", fm: new Map([["superseded_by", "next.md"]]), tokens: shared },
    { root: "/bank-a", rel: "copy.md", title: "副本", fm: new Map(), tokens: new Set(["部署", "回滚", "快照", "停服", "备份"]) },
  ];
  const report = doctor(docs);
  assert.equal(report.some(r => r.type === "near_duplicate" && r.file.includes("bank-b")), false);
  const dup = report.find(r => r.type === "near_duplicate");
  assert.equal(dup.file, "/bank-a/note.md");
  assert.match(dup.detail, /\/bank-a\/copy\.md/);
  assert.doesNotMatch(dup.detail, /bank-b/);
  const broken = report.filter(r => r.type === "broken_link");
  assert.equal(broken.length, 1);
  assert.equal(broken[0].file, "/bank-b/note.md");
});
test("doctor: 正文有日期但没有 date 字段时提示，合法 date 不提示", () => {
  const docs = [
    { rel: "a.md", title: "周会", fm: new Map(), tokens: new Set(["部署"]), content: "# 周会\n\n## 2026-04-10 周会\n" },
    { rel: "b.md", title: "已标", fm: new Map([["date", "2026-04-10"]]), tokens: new Set(["评审"]), content: "# 已标\n\n## 2026-03-02 选型\n" },
    { rel: "c.md", title: "无日期", fm: new Map(), tokens: new Set(["浇水"]), content: "# 无日期\n\n没有日历日。\n" },
    { rel: "d.md", title: "灌库", fm: new Map([["ingested_at", "2026-04-10 12:00:00"]]), tokens: new Set(["摘要"]), content: "---\ningested_at: 2026-04-10 12:00:00\n---\n# 灌库\n\n只有摘要。\n" },
    { rel: "e.md", title: "写错", fm: new Map([["date", "2026/04/10"]]), tokens: new Set(["部署"]), content: "# 写错\n\n没有正文日期。\n" },
  ];
  const report = doctor(docs);
  const hints = report.filter(r => r.type === "missing_date");
  assert.deepEqual(hints.map(r => r.file), ["a.md", "e.md"]);
  assert.match(hints[0].detail, /没有 date 字段/);
  assert.match(hints[1].detail, /不是 YYYY-MM-DD/);
});
test("doctor: 沉默条目清单提醒——人工定期复核", () => {
  const docs = [
    { rel: "正常.md", title: "N", fm: new Map(), tokens: new Set(["a"]) },
    { rel: "沉默.md", title: "S", fm: new Map([["suppress", "true"]]), tokens: new Set(["b"]) },
  ];
  const report = doctor(docs);
  assert.ok(report.some(r => r.type === "suppressed_list"));
});

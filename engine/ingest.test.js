#!/usr/bin/node
/** engine/ingest.test.js — 多前端写入协议测试（node --test 零依赖） */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingest } from "./ingest.mjs";
import { search } from "./core.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "duiying-ingest-"));
}

test("模式 A：content 落盘灌库——文件生成、frontmatter 齐、可被检索命中", () => {
  const root = tmpRoot();
  const r = ingest({
    root,
    channel: "zcode",
    summary: "数据库选型定为 SQLite 起步",
    content: "讨论记录：单机部署零运维，量级到了再换 Postgres。",
    event: "decision",
    ingested_at: "2026-10-18T15:30:00.000Z",
  });
  assert.equal(r.mode, "inline");
  assert.ok(fs.existsSync(r.file));
  const md = fs.readFileSync(r.file, "utf8");
  assert.ok(md.includes("channel: zcode"));
  assert.ok(md.includes("event: decision"));
  assert.ok(md.includes("ingested_at: 2026-10-18 15:30:00"));
  assert.ok(md.includes("# 数据库选型定为 SQLite 起步"));
  // 检索命中（同根搜「SQLite」应命中 ingest 条目）
  const s = search({ roots: [root], keywords: ["SQLite"], limit: 5 });
  assert.ok(s.results.some(x => x.title.includes("SQLite")), "ingest 条目应可检索");
});

test("模式 B：source_path 路径标记——薄条目只含指针", () => {
  const root = tmpRoot();
  const original = path.join(root, "elsewhere", "long-doc.md");
  fs.mkdirSync(path.dirname(original), { recursive: true });
  fs.writeFileSync(original, "# 长文正文", "utf8");
  const r = ingest({
    root,
    channel: "codex",
    summary: "长文决策记录（原文在别处）",
    source_path: original,
    ingested_at: "2026-10-18T15:30:00.000Z",
  });
  assert.equal(r.mode, "reference");
  assert.equal(r.warnings.length, 0);
  const md = fs.readFileSync(r.file, "utf8");
  assert.ok(md.includes(`source_path: ${original}`));
  assert.ok(md.includes("原文未落库"));
});

test("校验：缺 summary 报错（摘要谁灌的谁写）", () => {
  const r = ingest({ root: tmpRoot(), channel: "zcode", content: "x" });
  assert.match(r.error, /summary/);
});

test("校验：content 与 source_path 二选一", () => {
  const root = tmpRoot();
  let r = ingest({ root, channel: "zcode", summary: "s" });
  assert.match(r.error, /至少给一个/);
  r = ingest({ root, channel: "zcode", summary: "s", content: "a", source_path: "b" });
  assert.match(r.error, /二选一/);
});

test("校验：channel 缺失报错", () => {
  const r = ingest({ root: tmpRoot(), summary: "s", content: "x" });
  assert.match(r.error, /channel/);
});

test("安全：channel 路径穿越被清洗（../ 不逃出 ingest/）", () => {
  const root = tmpRoot();
  const r = ingest({ root, channel: "../../evil", summary: "越权尝试", content: "x" });
  const expected = path.join(root, "ingest");
  assert.ok(r.file.startsWith(expected), "写入必须落在 ingest/ 内");
  assert.ok(!r.file.includes(".."));
});

test("append-only：同一 slug 冲突时自动递增后缀", () => {
  const root = tmpRoot();
  const args = { root, channel: "zcode", summary: "同一条摘要", content: "v1", ingested_at: "2026-10-18T15:30:00.000Z" };
  const a = ingest(args);
  const b = ingest({ ...args, content: "v2" });
  const c = ingest({ ...args, content: "v3" });
  assert.notEqual(a.file, b.file);
  assert.notEqual(b.file, c.file);
  assert.ok(a.file.includes("-同一条摘要.md"));
  assert.ok(b.file.includes("-同一条摘要-2.md"));
  assert.ok(c.file.includes("-同一条摘要-3.md"));
});

test("超长摘要：标题行截断 40 字，正文保留全文，附 warning", () => {
  const root = tmpRoot();
  const long = "这是一条特别长的摘要用来测试标题截断逻辑".repeat(3);
  const r = ingest({ root, channel: "zcode", summary: long, content: "x" });
  assert.ok(r.warnings.some(w => w.includes("截断")));
  const md = fs.readFileSync(r.file, "utf8");
  const titleLine = md.split("\n").find(l => l.startsWith("# "));
  assert.ok(titleLine.replace("# ", "").length <= 40);
  assert.ok(md.includes(long), "正文应有完整摘要");
});

test("不存在的 source_path：仍写入但附 warning", () => {
  const root = tmpRoot();
  const r = ingest({ root, channel: "zcode", summary: "s", source_path: "D:/不存在的路径/x.md" });
  assert.equal(r.mode, "reference");
  assert.ok(r.warnings.some(w => w.includes("不存在")), r.warnings.join(" | "));
});

test("相对 source_path 只提示未校验，不报不存在", () => {
  const r = ingest({ root: tmpRoot(), channel: "zcode", summary: "s", source_path: "notes/missing.md" });
  assert.ok(r.warnings.some(w => w.includes("相对路径")));
  assert.equal(r.warnings.some(w => w.includes("不存在")), false);
});

test("source_path 换行被压成一行，不撑破 frontmatter", () => {
  const root = tmpRoot();
  const r = ingest({
    root, channel: "zcode", summary: "换行路径",
    source_path: "/tmp/duiying-missing.md\nsuppress: false",
  });
  assert.ok(r.warnings.some(w => w.includes("换行")));
  const lines = fs.readFileSync(r.file, "utf8").split("\n");
  const close = lines.indexOf("---", 1);
  const fm = lines.slice(1, close);
  assert.ok(fm.some(l => l.startsWith("source_path: ") && l.includes("/tmp/duiying-missing.md")));
  assert.equal(fm.some(l => l.startsWith("suppress:")), false);
});

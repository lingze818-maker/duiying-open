import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDocs, chunkText, importTo } from "../engine/importer.mjs";

const DIRS = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "duiying-import-"));
  DIRS.push(dir);
  return dir;
}
test.after(() => {
  for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

test("scanDocs: 递归找 md/txt，跳过隐藏目录与 node_modules", () => {
  const dir = scratch();
  writeFileSync(join(dir, "a.md"), "x");
  mkdirSync(join(dir, "子目录"));
  writeFileSync(join(dir, "子目录", "b.txt"), "x");
  mkdirSync(join(dir, ".hidden"));
  writeFileSync(join(dir, ".hidden", "c.md"), "x");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "d.md"), "x");
  const got = scanDocs(dir);
  assert.equal(got.length, 2);
  assert.ok(got.some(e => e.path.endsWith("a.md")));
  assert.ok(got.some(e => e.path.endsWith("b.txt")));
});

test("chunkText: 短文本单块、标题取首个 # 行", () => {
  const blocks = chunkText("# 会议纪要\n\n内容只有一段。", "回退标题");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].title, "会议纪要");
});

test("chunkText: markdown 按标题切块，子标题并入父标题", () => {
  const blocks = chunkText([
    "# 项目档案",
    "",
    "总体概述内容。",
    "",
    "## 预算",
    "",
    "预算细节很长，这里是一段说明。",
    "",
    "## 风险",
    "",
    "风险登记在册。",
  ].join("\n"), "项目档案");
  const titles = blocks.map(b => b.title);
  assert.ok(titles.includes("项目档案"));
  assert.ok(titles.includes("预算"), JSON.stringify(titles));
  assert.ok(titles.includes("风险"));
  assert.ok(blocks.every(b => b.body.trim()));
});

test("chunkText: 长纯文本按段落聚合到 chunkChars", () => {
  const para = "这一段有一百多个字的样子。".repeat(8) + "\n";
  const text = para.repeat(12);
  const blocks = chunkText(text, "长文档", 400);
  assert.ok(blocks.length > 1, `应拆成多块，实际 ${blocks.length}`);
  assert.ok(blocks.every(b => b.body.length <= 1200), "每块不应严重超限");
});

test("chunkText: 空文本至少返回一块（不炸）", () => {
  const blocks = chunkText("", "空");
  assert.equal(blocks.length, 1);
});

test("importTo: md/txt 写成记忆文件，frontmatter 带 title/date/source", async () => {
  const src = scratch();
  const root = scratch();
  writeFileSync(join(src, "会议纪要.md"), "# 周会\n\n讨论了部署方案。\n");
  writeFileSync(join(src, "旧档案.txt"), "纯文本档案内容。\n");
  const r = await importTo(root, src, { subdir: "导入" });
  assert.equal(r.imported, 2);
  assert.equal(r.chunks, 2);
  assert.equal(r.skipped.length, 0);
  const outDir = join(root, "导入");
  const files = readdirSync(outDir);
  assert.equal(files.length, 2);
  const conf = readFileSync(join(outDir, "会议纪要.md"), "utf8");
  assert.match(conf, /---/);
  assert.match(conf, /"周会"/);
  assert.match(conf, /讨论了部署方案/);
});

test("importTo: 空文档进 skipped 并带原因，不阻塞其他（不支持格式由 scanDocs 预过滤）", async () => {
  const src = scratch();
  const root = scratch();
  writeFileSync(join(src, "好文档.md"), "内容。\n");
  writeFileSync(join(src, "空文档.md"), "   \n");
  const r = await importTo(root, src);
  assert.equal(r.imported, 1);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /空文档/);
});

test("importTo: 长文档拆成多块，文件名带序号", async () => {
  const src = scratch();
  const root = scratch();
  writeFileSync(join(src, "长报告.md"), [
    "# 长报告",
    "",
    "第一段。" + "内容填充。".repeat(30),
    "",
    "## 第二章",
    "",
    "第二段。" + "更多内容。".repeat(30),
  ].join("\n"));
  const r = await importTo(root, src, { chunkChars: 200 });
  assert.ok(r.chunks >= 2, `长文档应拆多块，实际 ${r.chunks}`);
  const files = readdirSync(root).filter(f => f.includes("--"));
  assert.ok(files.length >= 1, "拆块文件名应带序号");
});

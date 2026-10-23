import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { search, runDoctor } from "../engine/core.mjs";

const run = promisify(execFile);
const ENGINE = fileURLToPath(new URL("../engine/surface.mjs", import.meta.url));
const SERVER = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
const HOOK = fileURLToPath(new URL("../hooks/user-prompt-surface.mjs", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../examples/partner-xiaolin", import.meta.url));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "duiying-search-"));
}
function write(dir, rel, body, mtime) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  if (mtime) fs.utimesSync(p, mtime, mtime);
  return p;
}

test("近重复：更短且无关的文档不会被丢掉", () => {
  const dir = tmp();
  write(dir, "long.md", "# 部署方案\n\n" + "部署回滚快照停服备份演练流程 ".repeat(20));
  write(dir, "short.md", "# 樱花\n\n樱花苗圃浇水。\n");
  const r = search({ roots: [dir], keywords: ["部署", "樱花"], useLinks: false, limit: 10 });
  const paths = r.results.map(x => x.path);
  assert.ok(paths.includes("long.md"));
  assert.ok(paths.includes("short.md"), "短文档被误判成重复: " + paths.join(","));
  assert.equal(r.total, r.results.length);
});

test("近重复：重合度够高时只留较新的一条", () => {
  const dir = tmp();
  const text = "部署方案回滚流程快照停服完全一样。";
  const now = Date.now();
  // 两篇都在 30 天内，时间加权相同；旧篇重复更多，融合分更高。留新不留高分。
  write(dir, "old.md", "# 旧\n\n" + text.repeat(8), new Date(now - 10 * 86400000));
  write(dir, "new.md", "# 新\n\n" + text, new Date(now - 86400000));
  const r = search({ roots: [dir], keywords: ["部署方案"], useLinks: false, limit: 10 });
  const paths = r.results.map(x => x.path);
  assert.ok(paths.includes("new.md"), paths.join(","));
  assert.equal(paths.includes("old.md"), false);
  assert.equal(r.total, 1);
});

test("坏链不附注，好链仍附注", () => {
  const dir = tmp();
  write(dir, "broken.md", "---\nsuperseded_by: 不存在.md\n---\n# 旧决策\n\n部署方案已经废弃。\n");
  write(dir, "old.md", "---\nsuperseded_by: next.md\n---\n# 旧部署\n\n部署方案第一版。\n");
  write(dir, "next.md", "# 新部署\n\n部署方案第二版。\n");
  const r = search({ roots: [dir], keywords: ["部署方案"], useLinks: false, limit: 10 });
  const broken = r.results.find(x => x.path === "broken.md");
  const old = r.results.find(x => x.path === "old.md");
  assert.ok(broken);
  assert.equal(broken.note, undefined);
  assert.ok(old.note.includes("next.md"));
});

test("frontmatter title 覆盖首个标题", () => {
  const dir = tmp();
  write(dir, "titled.md", "---\ntitle: 自定义路标\n---\n# 文件里的很长很长很长很长很长很长的标题不该当路标\n\n这里写了部署。\n");
  const r = search({ roots: [dir], keywords: ["部署"], useLinks: false });
  assert.equal(r.results[0].title, "自定义路标");
  const report = runDoctor([dir]).report.filter(x => x.file === "titled.md" && x.type === "title_quality");
  assert.equal(report.length, 0);
});

test("UTF-8 BOM 不挡住首个标题", () => {
  const dir = tmp();
  write(dir, "bom.md", "\uFEFF# 带标记的标题\n\n这里写部署。\n");
  const r = search({ roots: [dir], keywords: ["部署"], useLinks: false });
  assert.equal(r.results[0].title, "带标记的标题");
  assert.equal(r.results[0].path, "bom.md");
});

test("surface.md 是普通笔记，会进检索", () => {
  const dir = tmp();
  write(dir, "surface.md", "# 表面上浮\n\n专记这个词只出现在这里。\n");
  const r = search({ roots: [dir], keywords: ["专记"], useLinks: false });
  assert.ok(r.results.some(x => x.path === "surface.md"));
});

test("suppress_when 对整句关键词生效，同义词也算", () => {
  const dir = tmp();
  write(dir, "secret.md", "---\nsuppress_when: [裁员]\n---\n# 人事\n\n裁员方案三月讨论过。\n");
  write(dir, "head.md", "---\nsuppress_when: [头痛]\n---\n# 病案\n\n头痛危机已经记下。\n");
  const phrase = search({ roots: [dir], keywords: ["公司裁员方案"], useLinks: false });
  assert.equal(phrase.results.some(x => x.path === "secret.md"), false);
  const synonym = search({ roots: [dir], keywords: ["头疼"], useLinks: false });
  assert.equal(synonym.results.some(x => x.path === "head.md"), false);
  const ok = search({ roots: [dir], keywords: ["福利方案"], useLinks: false });
  assert.ok(ok.results.some(x => x.path === "secret.md"));
});

test("detail 按字面量摘录，不把查询当正则", () => {
  const dir = tmp();
  write(dir, "meta.md", "# 元字符\n\n调用写成 foo(bar) 并且另一行有 a(b 片段。\n");
  const paren = search({ roots: [dir], keywords: ["foo(bar)"], detail: true, useLinks: false });
  assert.match(paren.results[0].excerpt, /foo\(bar\)/);
  const broken = search({ roots: [dir], keywords: ["a(b"], detail: true, useLinks: false });
  assert.match(broken.results[0].excerpt, /a\(b/);
});

test("沉默条目不出现在 links 里", () => {
  const dir = tmp();
  const shared = "项目周会纪要快照演练流程数据库备份停服容器编排评审";
  write(dir, "visible.md", `# 可见\n\n部署方案确定。\n${shared}\n`);
  write(dir, "loud.md", `# 大声的邻居\n\n${shared}\n`);
  write(dir, "quiet.md", `---\nsuppress: true\n---\n# 沉默\n\n${shared}\n部署方案也写了但不要浮。\n`);
  const r = search({ roots: [dir], keywords: ["部署方案"], limit: 10 });
  assert.equal(r.results.some(x => x.path === "quiet.md"), false);
  assert.ok(r.results.some(x => x.links.includes("loud.md")), "联想链本身应仍在: " + JSON.stringify(r.results));
  assert.ok(r.results.every(x => !x.links.includes("quiet.md")));
});

test("示例库：SQLite 的词面命中排在纯联想前面，部署仍以会议纪要为先", () => {
  const sqlite = search({ roots: [EXAMPLE], keywords: ["SQLite"], limit: 10 });
  const sqlitePaths = sqlite.results.map(x => x.path);
  assert.ok(sqlitePaths.includes("决策记录.md"));
  assert.ok(sqlitePaths.indexOf("决策记录.md") < sqlitePaths.indexOf("会议纪要.md"));
  const deploy = search({ roots: [EXAMPLE], keywords: ["部署"], limit: 10 });
  const deployPaths = deploy.results.map(x => x.path);
  assert.ok(deployPaths.indexOf("会议纪要.md") < deployPaths.indexOf("决策记录.md"));
  assert.ok(deployPaths.includes("协作偏好.md"));
  assert.ok(deploy.results.every(x => x.path !== "README.md" && !x.links.includes("README.md")));
});

test("frontmatter date 覆盖更新的 mtime：结果日期与时间先验都认发生日", () => {
  const dir = tmp();
  const now = new Date(2026, 3, 20, 12, 0, 0);
  const shared = "部署方案需要记住。";
  // 旧决定被重新保存，mtime 是今天；周会文件很久没碰，但 date 更晚。
  write(dir, "old-decision.md", `---\ndate: 2026-01-01\n---\n# 旧决定\n\n苹果香蕉橘子葡萄草莓柚子。${shared}\n`, now);
  write(dir, "meeting.md", `---\ndate: "2026-04-10"\n---\n# 周会\n\n火车轮船飞机地铁公交单车。${shared}\n`, new Date(2020, 0, 1));
  const dated = search({
    roots: [dir], keywords: ["最近的部署"], useLinks: false, nowMs: now.getTime(),
  });
  const byPath = Object.fromEntries(dated.results.map(x => [x.path, x]));
  assert.equal(byPath["meeting.md"].date, "2026-04-10");
  assert.equal(byPath["old-decision.md"].date, "2026-01-01");
  assert.ok(
    dated.results.findIndex(x => x.path === "meeting.md")
      < dated.results.findIndex(x => x.path === "old-decision.md"),
    dated.results.map(x => `${x.path}:${x.date}:${x.score}`).join(", "),
  );
  // 不带时间词时，时间先验仍然用发生日，而不是“刚保存所以更新”。
  const plain = search({
    roots: [dir], keywords: ["部署"], useLinks: false, nowMs: now.getTime(),
  });
  assert.ok(
    plain.results.findIndex(x => x.path === "meeting.md")
      < plain.results.findIndex(x => x.path === "old-decision.md"),
  );
});

test("没有合法 date 时，结果日期和先后都退回 mtime", () => {
  const dir = tmp();
  const now = new Date(2026, 3, 20, 15, 0, 0);
  const shared = "部署方案需要记住。";
  write(dir, "touched.md", `# 旧决定\n\n苹果香蕉橘子葡萄草莓柚子。${shared}\n`, now);
  write(dir, "ancient.md", `---\ndate: 2026-02-31\n---\n# 周会\n\n火车轮船飞机地铁公交单车。${shared}\n`, new Date(2020, 0, 1, 8, 0, 0));
  const r = search({
    roots: [dir], keywords: ["最近的部署"], useLinks: false, nowMs: now.getTime(),
  });
  const byPath = Object.fromEntries(r.results.map(x => [x.path, x]));
  assert.equal(byPath["touched.md"].date, "2026-04-20");
  assert.equal(byPath["ancient.md"].date, "2020-01-01");
  assert.equal(r.results[0].path, "touched.md");
});

test("近重复：发生日比 mtime 新的留下，且不改原文", () => {
  const dir = tmp();
  const text = "部署方案回滚流程快照停服完全一样。";
  const now = new Date(2026, 3, 20, 12, 0, 0);
  const oldBody = `---\ndate: 2026-01-01\n---\n# 旧\n\n${text.repeat(8)}`;
  const newBody = `---\ndate: 2026-04-10\n---\n# 新\n\n${text}`;
  const oldPath = write(dir, "old.md", oldBody, now);
  const newPath = write(dir, "new.md", newBody, new Date(2020, 0, 1));
  const r = search({
    roots: [dir], keywords: ["部署方案"], useLinks: false, nowMs: now.getTime(), limit: 10,
  });
  assert.deepEqual(r.results.map(x => x.path), ["new.md"]);
  assert.equal(r.results[0].date, "2026-04-10");
  assert.equal(fs.readFileSync(oldPath, "utf8"), oldBody);
  assert.equal(fs.readFileSync(newPath, "utf8"), newBody);
});

test("doctor：正文有日期但没有 date 时提示，并且不改文件", () => {
  const dir = tmp();
  const body = "# 周会\n\n## 2026-04-10 周会\n\n部署方案评审通过。\n";
  const marked = "---\ndate: 2026-03-02\n---\n# 选型\n\n## 2026-03-02 选型\n\n定了 SQLite。\n";
  const p = write(dir, "meet.md", body);
  write(dir, "decision.md", marked);
  const hints = runDoctor([dir]).report.filter(x => x.type === "missing_date");
  assert.deepEqual(hints.map(x => x.file), ["meet.md"]);
  assert.match(hints[0].detail, /没有 date 字段/);
  assert.equal(fs.readFileSync(p, "utf8"), body);
});

test("结果日期跟随 TZ 的本地日历日", async () => {
  const dir = tmp();
  write(dir, "tz.md", "# 时区\n\n部署时区测试唯一词。\n", new Date("2026-01-01T16:30:00.000Z"));
  const { stdout } = await run(process.execPath, [ENGINE, "时区测试唯一词", "--root", dir, "--json"], {
    env: { ...process.env, TZ: "Asia/Shanghai" },
  });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.results[0].date, "2026-01-02");
});

test("CLI：缺参数会失败，--json --out 会落盘且 stdout 仍是 JSON", async () => {
  const dir = tmp();
  write(dir, "a.md", "# 部署\n\n部署关键词。\n");
  await assert.rejects(run(process.execPath, [ENGINE, "部署", "--root"]));
  const out = path.join(dir, "out.json");
  const { stdout } = await run(process.execPath, [ENGINE, "部署", "--root", dir, "--json", "--out", out]);
  const fromStd = JSON.parse(stdout);
  const fromFile = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(fromStd.engine, "duiying-open/0.2");
  assert.equal(fromFile.results[0].path, "a.md");
});

test("MCP：字符串 root 生效，无命中仍带时间锚", () => {
  const dir = tmp();
  write(dir, "only.md", "# 唯一\n\n石榴词只在临时库。\n");
  const call = arguments_ => JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "memory_surface", arguments: arguments_ },
  }) + "\n";
  const hit = spawnSync(process.execPath, [SERVER], {
    input: call({ query: "石榴词", root: dir }),
    encoding: "utf8",
  });
  const hitMsg = JSON.parse(hit.stdout.trim().split("\n").at(-1));
  assert.match(hitMsg.result.content[0].text, /唯一/);
  const miss = spawnSync(process.execPath, [SERVER], {
    input: call({ query: "完全没有的词xyz", root: dir }),
    encoding: "utf8",
  });
  const missText = JSON.parse(miss.stdout.trim().split("\n").at(-1)).result.content[0].text;
  assert.match(missText, /^当前：/);
  assert.match(missText, /没有命中/);
});

test("多根：同名文件不串附注、不跨根去重，结果带 root", async () => {
  const a = tmp();
  const b = tmp();
  const body = "部署方案回滚流程快照停服完全一样的跨库正文。";
  write(a, "note.md", `---\nsuperseded_by: next.md\n---\n# A\n\n${body}\n`);
  write(a, "next.md", "# A 的新方案\n\n新方案在 A。\n");
  write(b, "note.md", `---\nsuperseded_by: other.md\n---\n# B\n\n${body}\n`);
  write(b, "other.md", "# B 的新方案\n\n新方案在 B。\n");
  write(a, "gap.md", "---\nsuperseded_by: missing.md\n---\n# 缺口A\n\n部署方案回滚流程只在 A 断链。\n");
  write(b, "gap.md", "---\nsuperseded_by: missing.md\n---\n# 缺口B\n\n部署方案回滚流程只在 B 断链。\n");

  const resolved = dir => path.resolve(dir).split(path.sep).join("/");
  const r = search({
    roots: [a, b], keywords: ["部署方案回滚流程"], useLinks: false, limit: 10,
  });
  const notes = r.results.filter(x => x.path === "note.md");
  assert.equal(notes.length, 2, JSON.stringify(r.results));
  const byTitle = Object.fromEntries(notes.map(x => [x.title, x]));
  assert.match(byTitle.A.note, /next\.md/);
  assert.doesNotMatch(byTitle.A.note, /other\.md/);
  assert.match(byTitle.B.note, /other\.md/);
  assert.doesNotMatch(byTitle.B.note, /next\.md/);
  assert.equal(byTitle.A.root, resolved(a));
  assert.equal(byTitle.B.root, resolved(b));
  assert.equal(byTitle.A.path, "note.md");
  const single = search({ roots: [a], keywords: ["部署方案回滚流程"], useLinks: false });
  assert.equal("root" in single.results[0], false);

  const report = runDoctor([a, b]).report;
  const cross = report.filter(x => x.type === "near_duplicate");
  assert.equal(cross.length, 0, JSON.stringify(report));
  const gaps = report.filter(x => x.type === "broken_link" && x.file.endsWith("/gap.md"));
  assert.equal(gaps.length, 2, JSON.stringify(report));
  assert.notEqual(gaps[0].file, gaps[1].file);
  assert.ok(gaps.some(x => x.file === `${resolved(a)}/gap.md`));
  assert.ok(gaps.some(x => x.file === `${resolved(b)}/gap.md`));
  assert.ok(report.every(x => x.file !== "note.md" && x.file !== "gap.md"));

  const { stdout } = await run(process.execPath, [
    ENGINE, "部署方案回滚流程", "--root", a, "--root", b, "--json", "--no-links",
  ]);
  const parsed = JSON.parse(stdout);
  const cliNotes = parsed.results.filter(x => x.path === "note.md");
  assert.equal(cliNotes.length, 2);
  assert.ok(cliNotes.every(x => x.root && x.path === "note.md"));
  const doctor = await run(process.execPath, [ENGINE, "--doctor", "--root", a, "--root", b]);
  assert.doesNotMatch(doctor.stdout, /与 note\.md /);
  assert.match(doctor.stdout, new RegExp(resolved(a).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/gap\\.md"));
  assert.match(doctor.stdout, new RegExp(resolved(b).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/gap\\.md"));
});

test("多根：links 不指向另一个根的同名文件", () => {
  const a = tmp();
  const b = tmp();
  const shared = "项目周会纪要快照演练流程数据库备份停服容器编排评审部署方案";
  write(a, "topic.md", `# A主题\n\n部署方案在 A。\n${shared}\n`);
  write(b, "topic.md", `# B主题\n\n部署方案在 B。\n${shared}\n`);
  const r = search({ roots: [a, b], keywords: ["部署方案"], limit: 10 });
  const aTopic = r.results.find(x => x.path === "topic.md" && x.title.startsWith("A"));
  assert.ok(aTopic, JSON.stringify(r.results));
  assert.equal(aTopic.links.includes("topic.md"), false, JSON.stringify(aTopic.links));
  for (const hit of r.results) {
    for (const link of hit.links) {
      assert.equal(link.includes("/") || link.includes("\\"), false);
      assert.ok(fs.existsSync(path.join(hit.root, link)), `${hit.root} + ${link}`);
    }
  }
});

test("钩子：未配置排除时不隐藏目录", () => {
  const dir = tmp();
  write(dir, path.join("蒸馏数据", "note.md"), "# 蒸馏\n\n钩子唯一标记词。\n");
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ prompt: "钩子唯一标记词" }),
    encoding: "utf8",
    env: { ...process.env, DUIYING_HOOK_ROOTS: dir, DUIYING_HOOK_EXCLUDE: "" },
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /蒸馏数据/);
});

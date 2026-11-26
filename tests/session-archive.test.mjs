import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sessionFileId,
  sessionPath,
  appendSession,
  readSession,
  listSessions,
  searchArchive,
  compressSession,
  sessionView,
} from "../engine/session-archive.mjs";

const DIRS = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "duiying-sess-"));
  DIRS.push(dir);
  return dir;
}
test.after(() => {
  for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

test("sessionFileId: 中文保留、非法字符替换、空值兜底", () => {
  assert.equal(sessionFileId("会议-部署"), "会议-部署");
  assert.equal(sessionFileId("a/b\\c:d"), "a-b-c-d");
  assert.equal(sessionFileId(""), "unnamed");
});

test("appendSession→readSession 往返一致", () => {
  const root = scratch();
  const msgs = [
    { role: "user", content: "服务器宕机了怎么办" },
    { role: "assistant", content: "先查监控告警，再看连接池。" },
  ];
  appendSession({ archiveRoot: root, sessionId: "s1", messages: msgs, meta: { agent: "部门助手" } });
  const events = readSession(root, "s1");
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, "s1");
  assert.equal(events[0].agent, "部门助手");
  assert.deepEqual(events[0].messages, msgs);
});

test("appendSession: 多次追加是 append-only（不覆盖旧行）", () => {
  const root = scratch();
  appendSession({ archiveRoot: root, sessionId: "s2", messages: [{ role: "user", content: "第一条" }] });
  appendSession({ archiveRoot: root, sessionId: "s2", messages: [{ role: "user", content: "第二条" }] });
  const events = readSession(root, "s2");
  assert.equal(events.length, 2);
});

test("searchArchive: 在归档消息里全文命中", () => {
  const root = scratch();
  appendSession({
    archiveRoot: root, sessionId: "s3",
    messages: [{ role: "user", content: "出差住宿标准是多少" }],
  });
  const hits = searchArchive(root, "住宿标准");
  assert.equal(hits.length, 1);
  assert.match(hits[0].content, /住宿标准/);
  assert.equal(searchArchive(root, "查无此词").length, 0);
});

test("searchArchive: 空查询返回空、limit 生效", () => {
  const root = scratch();
  for (let i = 0; i < 5; i++) {
    appendSession({
      archiveRoot: root, sessionId: `s-${i}`,
      messages: [{ role: "user", content: `预算内容${i}` }],
    });
  }
  assert.equal(searchArchive(root, "").length, 0);
  assert.ok(searchArchive(root, "预算", { limit: 2 }).length <= 2);
});

test("必填校验: 缺 archiveRoot / sessionId / 空 messages 抛可读错误", () => {
  const root = scratch();
  assert.throws(() => appendSession({ sessionId: "s", messages: [{ role: "user", content: "x" }] }), /archiveRoot/);
  assert.throws(() => appendSession({ archiveRoot: root, messages: [{ role: "user", content: "x" }] }), /sessionId/);
  assert.throws(() => appendSession({ archiveRoot: root, sessionId: "s", messages: [] }), /messages 必须是非空数组/);
});

test("listSessions: 列出所有归档会话文件", () => {
  const root = scratch();
  appendSession({ archiveRoot: root, sessionId: "a", messages: [{ role: "user", content: "1" }] });
  appendSession({ archiveRoot: root, sessionId: "b", messages: [{ role: "user", content: "2" }] });
  const files = listSessions(root);
  assert.equal(files.length, 2);
  assert.ok(files.every(f => f.file.endsWith(".jsonl")));
});

test("compressSession: 原文归档到 -archive 文件，摘要事件成为会话头部", () => {
  const root = scratch();
  const range = [
    { role: "user", content: "讨论了部署方案" },
    { role: "assistant", content: "方案确定，用 Docker。" },
  ];
  const r = compressSession({
    archiveRoot: root, sessionId: "work-1",
    summary: "已确定部署方案：Docker。后续按此执行。",
    range, meta: { by: "部门助手" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.archivedCount, 2);
  const archiveEvents = readSession(root, "work-1-archive");
  assert.equal(archiveEvents.length, 1);
  assert.equal(archiveEvents[0].kind, "compressed-original");
  assert.deepEqual(archiveEvents[0].messages, range);
  const view = sessionView(root, "work-1");
  assert.match(view.summary, /Docker/);
  assert.equal(view.messages.length, 0, "被压缩的消息不再出现在有效视图");
});

test("compressSession: 压缩掉的原文仍可通过全文搜索找回（searchArchive 覆盖 -archive 文件）", () => {
  const root = scratch();
  compressSession({
    archiveRoot: root, sessionId: "work-2",
    summary: "确定数据库方案。",
    range: [{ role: "user", content: "连接池耗尽导致服务中断" }],
  });
  const hits = searchArchive(root, "连接池");
  assert.equal(hits.length, 1);
  assert.match(hits[0].content, /连接池/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUserLibs, resolveUserRoots, canWrite } from "../engine/authz.mjs";
import { AuditLog } from "../engine/audit.mjs";
import { importTo } from "../engine/importer.mjs";

const CONFIG = {
  libs: {
    common:  { readers: ["*"], writers: ["admin"] },
    finance: { readers: ["group:finance"], writers: ["group:finance-lead", "财务科长"] },
    secret:  { readers: ["group:board"], writers: ["board-chair"] },
  },
  users: {
    zhang: { groups: ["finance"], libs: ["common", "finance"] },
    li:    { groups: ["admin"], libs: ["*"] },
    匿名:  { libs: ["common"] },  // 显式只提 common，但 common readers * 本来就放行
    outsider: {},
  },
};

const DIRS = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "duiying-authz-"));
  DIRS.push(dir);
  return dir;
}
test.after(() => {
  for (const d of DIRS) rmSync(d, { recursive: true, force: true });
});

// ---- 读权限（两道闸）----

test("读权限: 财务组成员 = common + finance，不含 secret", () => {
  assert.deepEqual(resolveUserLibs("zhang", CONFIG), ["common", "finance"]);
});

test("读权限: 管理员 * 通配 = 全部库", () => {
  assert.deepEqual(resolveUserLibs("li", CONFIG), ["common", "finance", "secret"]);
});

test("读权限: 未知用户只剩公共层（匿名只见 readers:* 的库）", () => {
  assert.deepEqual(resolveUserLibs("陌生人", CONFIG), ["common"]);
});

test("读权限: 两道闸——显式清单没列 secret 的用户，即使混进 board 组也不读", () => {
  const cfg = {
    libs: {
      common: { readers: ["*"], writers: [] },
      secret: { readers: ["*"], writers: [] },
    },
    users: { 内鬼: { groups: ["board"], libs: ["common"] } },  // 显式清单只提 common
  };
  assert.deepEqual(resolveUserLibs("内鬼", cfg), ["common"]);
});

test("读权限: resolveUserRoots 把库名映射为路径，未映射库跳过", () => {
  const paths = { common: "D:/mem/common", finance: "D:/mem/finance" };
  assert.deepEqual(resolveUserRoots("zhang", CONFIG, paths), ["D:/mem/common", "D:/mem/finance"]);
  // secret 没映射路径 → 静默跳过；li 的 secret 在 paths 缺失 → 也跳过
  assert.deepEqual(resolveUserRoots("li", CONFIG, paths), ["D:/mem/common", "D:/mem/finance"]);
});

// ---- 写权限（默认拒绝）----

test("写权限: writers 命中才可写；默认拒绝", () => {
  assert.equal(canWrite("zhang", "finance", CONFIG), false);  // zhang 在 finance 但不在 writers
  assert.equal(canWrite("财务科长", "finance", CONFIG), true); // writers 点名
  assert.equal(canWrite("admin", "common", CONFIG), true);
  assert.equal(canWrite("admin", "secret", CONFIG), false);    // secret writers 只有 board-chair
  assert.equal(canWrite("任何人", "不存在的库", CONFIG), false);
});

// ---- 审计日志 ----

test("审计: JSONL 追加、目录自动创建、一行一事件", () => {
  const dir = scratch();
  const log = new AuditLog(join(dir, "audit", "audit.jsonl"));
  log.logSearch("zhang", "部署方案", ["common", "finance"]);
  log.logWrite("admin", "common", { imported: 3, chunks: 7 });
  log.append({ user: "li", action: "custom" });
  const lines = readFileSync(log.path, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  const events = lines.map(l => JSON.parse(l));
  assert.equal(events[0].user, "zhang");
  assert.equal(events[0].action, "search");
  assert.match(events[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(events[1].action, "write");
});

test("审计: 查询词截断到 200 字（审计不是监视工具，不存命中明细）", () => {
  const dir = scratch();
  const log = new AuditLog(join(dir, "audit.jsonl"));
  log.logSearch("zhang", "很长的查询".repeat(100), ["common"]);
  const ev = JSON.parse(readFileSync(log.path, "utf8"));
  assert.ok(ev.query.length <= 200);
});

// ---- 导入器写权限接线 ----

test("导入器×权限: 无写权限整体拒绝（默认拒绝），有权限正常导入", async () => {
  const src = scratch();
  const root = scratch();
  writeFileSync(join(src, "财务纪要.md"), "# 财务\n\n财务纪要内容。\n");
  const authz = { user: "zhang", libName: "finance", config: CONFIG };
  // zhang 在 finance readers（组:finance）但不在 writers → 拒绝
  await assert.rejects(() => importTo(root, src, { subdir: "finance", authz }), /无库 finance 的写权限/);
  // 换有写权限的用户 → 正常导入
  const r = await importTo(root, src, { subdir: "finance", authz: { ...authz, user: "财务科长" } });
  assert.equal(r.imported, 1);
  const files = readdirSync(join(root, "finance"));
  assert.equal(files.length, 1);
});

test("导入器×权限: 不传 authz 时行为不变（向后兼容）", async () => {
  const src = scratch();
  const root = scratch();
  writeFileSync(join(src, "普通.md"), "内容。\n");
  const r = await importTo(root, src);
  assert.equal(r.imported, 1);
});

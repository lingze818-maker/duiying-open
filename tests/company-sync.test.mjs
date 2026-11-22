import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { search, runDoctor } from "../engine/core.mjs";
import { createAdapter } from "../adapters/fixture-company.mjs";
import { defineAdapter, STATE_FILENAME } from "../adapters/sync.mjs";
const ENGINE = fileURLToPath(new URL("../engine/surface.mjs", import.meta.url));
const SERVER = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
const HOOK = fileURLToPath(new URL("../hooks/user-prompt-surface.mjs", import.meta.url));
const SYNC = fileURLToPath(new URL("../hooks/company-sync.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/company-source", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../examples/partner-xiaolin", import.meta.url));

function tmp(prefix = "duiying-company-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out.sort();
}

function snapshot(dir) {
  return new Map(walkFiles(dir).map(file => [file, fs.readFileSync(file)]));
}

function mdRels(dir) {
  return walkFiles(dir)
    .filter(file => file.endsWith(".md"))
    .map(file => path.relative(dir, file).split(path.sep).join("/"))
    .sort();
}

function spawnNode(script, { input = "", env = {} } = {}) {
  return spawnSync(process.execPath, [script], { input, encoding: "utf8", env: { ...process.env, ...env } });
}

test("虚构夹具实现 list、fetch、toNote，并且不提供回写", async () => {
  const adapter = createAdapter();
  const listed = await adapter.list();
  assert.equal(listed.length, 4);
  for (const item of listed) {
    assert.equal(typeof item.id, "string");
    assert.equal(typeof item.title, "string");
    assert.equal(typeof item.updated, "string");
    assert.equal(typeof item.path, "string");
  }
  const item = await adapter.fetch("ledger-14");
  const note = adapter.toNote(item);
  assert.equal(note.title, "仓库台账");
  assert.equal(note.date, "2026-03-02");
  assert.equal(note.rel, "records/ledger.md");
  assert.match(note.body, /样例潮位码/);
  const old = adapter.toNote(await adapter.fetch("patrol-old-03"));
  assert.equal(old.superseded_by, "records/patrol-quarter.md");
  const sealed = adapter.toNote(await adapter.fetch("sealed-draft-02"));
  assert.equal(sealed.suppress, true);
  assert.equal(adapter.push, undefined);
  assert.equal(adapter.writeBack, undefined);
});

test("同步进临时根后，search、surface 和 memory_surface 都能命中，源目录不变", async () => {
  const before = snapshot(FIXTURE);
  const root = tmp();
  const other = tmp();
  fs.writeFileSync(path.join(other, "local.md"), "# 另一根\n\n这里只记本地备忘。\n");
  const synced = await createAdapter().sync({ root });
  assert.equal(synced.direction, "pull");
  assert.equal(synced.written.length, 4);
  assert.deepEqual(snapshot(FIXTURE), before);

  const hit = search({ roots: [root], keywords: ["样例潮位码"], detail: true, useLinks: false });
  const ledger = hit.results.find(item => item.path === "records/ledger.md");
  assert.ok(ledger);
  assert.equal(ledger.title, "仓库台账");
  assert.equal(ledger.date, "2026-03-02");
  assert.equal(ledger.root, undefined);
  assert.match(ledger.excerpt, /样例潮位码/);

  const hidden = search({ roots: [root], keywords: ["样例封存词"], useLinks: false });
  assert.equal(hidden.results.some(item => item.path === "records/sealed.md"), false);
  assert.equal(fs.existsSync(path.join(root, "records", "sealed.md")), true);

  const replaced = search({ roots: [root], keywords: ["样例蜡油规程"], useLinks: false });
  const old = replaced.results.find(item => item.path === "records/patrol-old.md");
  assert.ok(old);
  assert.match(old.note, /records\/patrol-quarter\.md/);

  const both = search({ roots: [root, other], keywords: ["样例潮位码"], useLinks: false });
  const ledgerBoth = both.results.find(item => item.path === "records/ledger.md");
  assert.ok(ledgerBoth);
  assert.equal(ledgerBoth.root, synced.root);
  assert.equal(both.results.some(item => item.path === "local.md"), false);

  const report = runDoctor([root]).report;
  assert.equal(report.some(item => item.type === "broken_link"), false);
  assert.equal(report.some(item => item.type === "near_duplicate"), false);
  assert.ok(report.some(item => item.type === "suppressed_list" && item.file === "records/sealed.md"));

  const surfaced = spawnSync(process.execPath, [ENGINE, "样例潮位码", "--root", root, "--json", "--detail"], { encoding: "utf8" });
  assert.equal(surfaced.status, 0);
  const payload = JSON.parse(surfaced.stdout);
  assert.equal(payload.query[0], "样例潮位码");
  assert.ok(payload.results.some(item => item.path === "records/ledger.md" && /样例潮位码/.test(item.excerpt)));

  const mcp = spawnSync(process.execPath, [SERVER], {
    input: `${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "memory_surface", arguments: { query: "样例潮位码", root: [root], detail: true } },
    })}\n`,
    encoding: "utf8",
  });
  assert.equal(mcp.status, 0);
  const message = JSON.parse(mcp.stdout.trim().split("\n").at(-1));
  assert.match(message.result.content[0].text, /仓库台账/);
  assert.match(message.result.content[0].text, /样例潮位码/);
});

test("再次同步不另起文件；since 只拉更晚的条目；改了 updated 就覆盖同一篇", async () => {
  const root = tmp();
  const adapter = createAdapter();
  await adapter.sync({ root });
  const before = fs.statSync(path.join(root, "records", "ledger.md")).mtimeMs;
  const again = await adapter.sync({ root });
  assert.deepEqual(again.written, []);
  assert.equal(fs.statSync(path.join(root, "records", "ledger.md")).mtimeMs, before);
  assert.deepEqual(mdRels(root), [
    "records/ledger.md",
    "records/patrol-old.md",
    "records/patrol-quarter.md",
    "records/sealed.md",
  ]);

  const bounded = tmp();
  const partial = await adapter.sync({ root: bounded, since: "2026-03-02T08:00:00.000Z" });
  assert.deepEqual(partial.written.map(item => item.id).sort(), ["patrol-quarter-09", "sealed-draft-02"]);
  assert.equal(fs.existsSync(path.join(bounded, "records", "ledger.md")), false);

  fs.rmSync(path.join(root, STATE_FILENAME));
  const restored = await adapter.sync({ root });
  assert.deepEqual(restored.written, []);
  assert.equal(mdRels(root).length, 4);

  const source = tmp("duiying-company-src-");
  fs.cpSync(FIXTURE, source, { recursive: true });
  const copied = tmp();
  const local = createAdapter({ source });
  await local.sync({ root: copied });
  const catalogPath = path.join(source, "catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  catalog.items.find(item => item.id === "ledger-14").updated = "2026-08-01T00:00:00.000Z";
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  const ledgerPath = path.join(source, "records", "ledger.md");
  fs.writeFileSync(ledgerPath, `${fs.readFileSync(ledgerPath, "utf8").trim()}\n样例潮位码改记内档。\n`);
  const updated = await local.sync({ root: copied });
  assert.deepEqual(updated.written, [{ id: "ledger-14", rel: "records/ledger.md" }]);
  assert.match(fs.readFileSync(path.join(copied, "records", "ledger.md"), "utf8"), /样例潮位码改记内档/);
  assert.equal(mdRels(copied).length, 4);
  const found = search({ roots: [copied], keywords: ["样例潮位码改记内档"], detail: true, useLinks: false });
  assert.equal(found.results[0].path, "records/ledger.md");
  assert.match(found.results[0].excerpt, /样例潮位码改记内档/);
});

test("路径跑出授权根时拒绝写入", async () => {
  const root = tmp();
  const outside = path.resolve(root, "..", "..", "escape.md");
  const bad = defineAdapter({
    id: "bad-path",
    async list() {
      return [{ id: "x", title: "越界", updated: "2026-02-02T00:00:00.000Z" }];
    },
    async fetch(id) {
      return { id, title: "越界", updated: "2026-02-02T00:00:00.000Z", date: "2026-02-02", body: "不要写出去" };
    },
    toNote() {
      return { title: "越界", date: "2026-02-02", body: "不要写出去", rel: "../../escape.md" };
    },
  });
  await assert.rejects(() => bad.sync({ root }), /拒绝写出授权根/);
  assert.equal(fs.existsSync(outside), false);
  assert.equal(fs.existsSync(path.join(root, STATE_FILENAME)), false);
});

test("同步钩子：成功打出 JSON；失败默认 exit 0，严格模式才 exit 1", () => {
  const root = tmp();
  const ok = spawnNode(SYNC, {
    input: JSON.stringify({ adapter: "fixture", root, since: "2026-04-01T00:00:00.000Z" }),
  });
  assert.equal(ok.status, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.direction, "pull");
  assert.deepEqual(parsed.written.map(item => item.rel).sort(), ["records/patrol-quarter.md", "records/sealed.md"]);

  const env = { ...process.env };
  delete env.DUIYING_COMPANY_ADAPTER;
  delete env.DUIYING_COMPANY_ROOT;
  delete env.DUIYING_COMPANY_SYNC_STRICT;
  delete env.DUIYING_COMPANY_SINCE;
  delete env.DUIYING_COMPANY_SOURCE;
  const soft = spawnSync(process.execPath, [SYNC], { input: "{", encoding: "utf8", env });
  assert.equal(soft.status, 0);
  assert.equal(soft.stdout, "");
  assert.match(soft.stderr, /company-sync:/);

  const strict = spawnSync(process.execPath, [SYNC], {
    input: "",
    encoding: "utf8",
    env: { ...env, DUIYING_COMPANY_SYNC_STRICT: "1" },
  });
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /未指定适配器/);
});

test("配置里的本地模块会被加载，不必改 engine", async () => {
  const file = path.join(tmp(), "adapter.mjs");
  fs.writeFileSync(file, `export function createAdapter() {
  return {
    id: "scratch",
    async list() {
      return [{ id: "scratch-1", title: "临时条目", updated: "2026-07-01T00:00:00.000Z", path: "scratch.md" }];
    },
    async fetch(id) {
      return { id, title: "临时条目", updated: "2026-07-01T00:00:00.000Z", body: "槲寄生口令只在这条。" };
    },
    toNote(item) {
      return "---\\ntitle: 临时条目\\ndate: 2026-07-01\\n---\\n\\n# 临时条目\\n\\n" + item.body + "\\n";
    },
  };
}
`);
  const root = tmp();
  const env = { ...process.env };
  delete env.DUIYING_COMPANY_SYNC_STRICT;
  const res = spawnSync(process.execPath, [SYNC], {
    input: "",
    encoding: "utf8",
    env: { ...env, DUIYING_COMPANY_ADAPTER: file, DUIYING_COMPANY_ROOT: root },
  });
  assert.equal(res.status, 0, res.stderr);
  const hit = search({ roots: [root], keywords: ["槲寄生口令"], detail: true, useLinks: false });
  assert.equal(hit.results[0].path, "scratch.md");
  assert.equal(hit.results[0].date, "2026-07-01");
  assert.match(hit.results[0].excerpt, /槲寄生口令/);
  assert.match(fs.readFileSync(path.join(root, "scratch.md"), "utf8"), /source_id: scratch-1/);
});

test("上浮钩子默认不同步；配上公司根之后能注入线索；同步失败也不挡住对话", async () => {
  const empty = tmp();
  const offEnv = {
    ...process.env,
    DUIYING_COMPANY_ADAPTER: "fixture",
    DUIYING_COMPANY_ROOT: empty,
    DUIYING_HOOK_ROOTS: EXAMPLE,
  };
  delete offEnv.DUIYING_HOOK_SYNC;
  delete offEnv.DUIYING_COMPANY_SYNC_STRICT;
  const off = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ prompt: "记得上次怎么部署" }),
    encoding: "utf8",
    env: offEnv,
  });
  assert.equal(off.status, 0);
  assert.match(off.stdout, /会议纪要/);
  assert.equal(fs.readdirSync(empty).length, 0);

  const root = tmp();
  const on = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ prompt: "记得样例潮位码" }),
    encoding: "utf8",
    env: {
      ...process.env,
      DUIYING_HOOK_SYNC: "1",
      DUIYING_COMPANY_ADAPTER: "fixture",
      DUIYING_COMPANY_ROOT: root,
      DUIYING_HOOK_ROOTS: root,
      DUIYING_COMPANY_SYNC_STRICT: "0",
    },
  });
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /仓库台账/);
  assert.match(on.stdout, /样例潮位码/);
  assert.match(on.stdout, /records\/ledger\.md/);
  assert.equal(fs.existsSync(path.join(root, "records", "ledger.md")), true);

  const blocked = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ prompt: "记得上次怎么部署" }),
    encoding: "utf8",
    env: {
      ...process.env,
      DUIYING_HOOK_SYNC: "1",
      DUIYING_COMPANY_SYNC_STRICT: "1",
      DUIYING_COMPANY_ADAPTER: path.join(tmp(), "missing-adapter.mjs"),
      DUIYING_COMPANY_ROOT: tmp(),
      DUIYING_HOOK_ROOTS: EXAMPLE,
    },
  });
  assert.equal(blocked.status, 0);
  assert.match(blocked.stdout, /会议纪要/);
  assert.doesNotMatch(blocked.stdout, /company-sync/);
});

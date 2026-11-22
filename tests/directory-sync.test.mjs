import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { search } from "../engine/core.mjs";
import { createAdapter, directorySourceId } from "../adapters/directory.mjs";
import { loadAdapter } from "../adapters/load.mjs";
import { STATE_FILENAME } from "../adapters/sync.mjs";
import { duiyingAdapterExtensions, projectSourceFile } from "../adapters/extensions.mjs";
import { duiyingExtensions } from "../mcp/extensions.mjs";

const HOOK = fileURLToPath(new URL("../hooks/user-prompt-surface.mjs", import.meta.url));
const SYNC = fileURLToPath(new URL("../hooks/company-sync.mjs", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../examples/partner-xiaolin", import.meta.url));

function tmp(prefix = "duiying-dir-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(dir, rel, body, mtime) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
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

test("转换器预留位保持 null，非 Markdown 不会被读成笔记", async () => {
  assert.equal(duiyingAdapterExtensions.markdownConverter, null);
  assert.equal(duiyingExtensions.markdownConverter, null);
  assert.equal(duiyingExtensions.vectorCandidateSource, null);
  const ext = fs.readFileSync(new URL("../adapters/extensions.mjs", import.meta.url), "utf8");
  assert.equal(/docx|pdfjs|word|wps|libreoffice/i.test(ext), false);

  const source = tmp();
  const bin = write(source, "note.bin", "raw-bytes-stay");
  const before = fs.readFileSync(bin);
  const skipped = await projectSourceFile({ rel: "note.bin", sourcePath: bin, converter: null });
  assert.equal(skipped, null);
  assert.deepEqual(fs.readFileSync(bin), before);

  const projected = await projectSourceFile({
    rel: "note.bin",
    sourcePath: bin,
    converter: () => ({ markdown: "# 桩\n\n只在授权根。\n", rel: "from-bin.md" }),
  });
  assert.equal(projected.rel, "from-bin.md");
  assert.match(projected.markdown, /只在授权根/);
  assert.equal(projected.passthrough, false);
  assert.deepEqual(fs.readFileSync(bin), before);
});

test("本地目录只增量拉取已有 Markdown，源文件保持原样", async () => {
  const source = tmp("duiying-dir-src-");
  const root = tmp("duiying-dir-root-");
  const t1 = new Date("2026-03-01T00:00:00.000Z");
  const t2 = new Date("2026-03-02T00:00:00.000Z");
  write(source, "notes/alpha.md", "# 甲岸\n\n样例潮汐口令写在甲岸。\n", t1);
  write(source, "notes/beta.md", "---\nsuppress: true\n---\n# 封存\n\n样例沉默词只在封存。\n", t2);
  write(source, "drop/brief.docx", "PK fictional-docx");
  write(source, "drop/scan.pdf", "%PDF fictional");
  write(source, "drop/sheet.wps", "fictional-wps");
  write(source, "drop/plain.txt", "还不是 markdown");
  const outside = write(tmp("duiying-dir-out-"), "outside.md", "# 界外\n\n不要碰。\n");
  fs.symlinkSync(outside, path.join(source, "link.md"));
  const before = snapshot(source);
  const outsideBefore = fs.readFileSync(outside);

  const adapter = createAdapter({ source });
  assert.equal(adapter.id, "directory");
  const listed = await adapter.list();
  assert.deepEqual(listed.map(item => item.path).sort(), ["notes/alpha.md", "notes/beta.md"]);
  for (const item of listed) {
    assert.equal(item.id.includes("/"), false);
    assert.equal(item.id, directorySourceId(item.path));
  }

  const first = await adapter.sync({ root });
  assert.equal(first.direction, "pull");
  assert.equal(first.written.length, 2);
  assert.deepEqual(snapshot(source), before);
  assert.deepEqual(fs.readFileSync(outside), outsideBefore);
  assert.equal(fs.existsSync(path.join(source, STATE_FILENAME)), false);
  assert.deepEqual(mdRels(root), ["notes/alpha.md", "notes/beta.md"]);
  assert.equal(walkFiles(root).some(file => /\.(docx|pdf|wps|txt)$/.test(file)), false);

  const hit = search({ roots: [root], keywords: ["样例潮汐口令"], detail: true, useLinks: false });
  assert.equal(hit.results[0].path, "notes/alpha.md");
  assert.match(hit.results[0].excerpt, /样例潮汐口令/);
  const hidden = search({ roots: [root], keywords: ["样例沉默词"], useLinks: false });
  assert.equal(hidden.results.some(item => item.path === "notes/beta.md"), false);
  assert.equal(fs.existsSync(path.join(root, "notes", "beta.md")), true);

  const again = await adapter.sync({ root });
  assert.deepEqual(again.written, []);

  const t3 = new Date("2026-04-01T00:00:00.000Z");
  write(source, "notes/gamma.md", "# 丙岸\n\n样例新潮口令只在丙岸。\n", t3);
  const sourceAfterAdd = snapshot(source);
  const added = await adapter.sync({ root });
  assert.deepEqual(added.written, [{ id: directorySourceId("notes/gamma.md"), rel: "notes/gamma.md" }]);
  assert.deepEqual(snapshot(source), sourceAfterAdd);
  assert.equal(mdRels(root).length, 3);

  const t4 = new Date("2026-05-01T00:00:00.000Z");
  write(source, "notes/alpha.md", "# 甲岸\n\n样例潮汐口令改记夜航。\n", t4);
  const sourceAfterEdit = snapshot(source);
  const updated = await adapter.sync({ root });
  assert.deepEqual(updated.written, [{ id: directorySourceId("notes/alpha.md"), rel: "notes/alpha.md" }]);
  assert.match(fs.readFileSync(path.join(root, "notes", "alpha.md"), "utf8"), /样例潮汐口令改记夜航/);
  assert.equal(mdRels(root).length, 3);
  assert.deepEqual(snapshot(source), sourceAfterEdit);
  const found = search({ roots: [root], keywords: ["样例潮汐口令改记夜航"], detail: true, useLinks: false });
  assert.equal(found.results[0].path, "notes/alpha.md");

  fs.rmSync(path.join(source, "notes", "gamma.md"));
  const sourceAfterRemove = snapshot(source);
  const kept = await adapter.sync({ root });
  assert.equal(kept.written.some(item => item.rel === "notes/gamma.md"), false);
  assert.equal(fs.existsSync(path.join(root, "notes", "gamma.md")), true);
  assert.deepEqual(snapshot(source), sourceAfterRemove);
});

test("测试桩转换器只把 Markdown 写入授权根", async () => {
  const source = tmp("duiying-dir-src-");
  const root = tmp("duiying-dir-root-");
  const bin = write(source, "note.bin", "raw-bytes-stay", new Date("2026-06-01T00:00:00.000Z"));
  const before = fs.readFileSync(bin);
  let saw = null;
  const adapter = createAdapter({
    source,
    converter: file => {
      saw = file;
      return { markdown: "# 桩笔记\n\n虚构转换正文。\n", rel: "from-bin.md" };
    },
  });
  const synced = await adapter.sync({ root });
  assert.deepEqual(synced.written, [{ id: directorySourceId("note.bin"), rel: "from-bin.md" }]);
  assert.equal(saw.rel, "note.bin");
  assert.equal(saw.sourcePath, bin);
  assert.match(fs.readFileSync(path.join(root, "from-bin.md"), "utf8"), /虚构转换正文/);
  assert.deepEqual(fs.readFileSync(bin), before);
  const hit = search({ roots: [root], keywords: ["虚构转换正文"], detail: true, useLinks: false });
  assert.equal(hit.results[0].path, "from-bin.md");
});

test("名字 directory 可加载；同步失败不挡住上浮；钩子默认不拉取", async () => {
  const source = tmp("duiying-dir-src-");
  const root = tmp("duiying-dir-root-");
  write(source, "keep.md", "# 留存\n\n样例目录口令在留存。\n", new Date("2026-02-02T00:00:00.000Z"));
  const loaded = await loadAdapter("directory", { source });
  await loaded.sync({ root });
  assert.match(fs.readFileSync(path.join(root, "keep.md"), "utf8"), /样例目录口令/);

  const missing = path.join(tmp(), "no-such-folder");
  await assert.rejects(() => createAdapter({ source: missing }).sync({ root: tmp() }), /本地目录/);
  const still = search({ roots: [root], keywords: ["样例目录口令"], useLinks: false });
  assert.equal(still.results[0].path, "keep.md");

  const empty = tmp("duiying-dir-root-");
  const offEnv = {
    ...process.env,
    DUIYING_COMPANY_ADAPTER: "directory",
    DUIYING_COMPANY_SOURCE: source,
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

  const blocked = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ prompt: "记得上次怎么部署" }),
    encoding: "utf8",
    env: {
      ...process.env,
      DUIYING_HOOK_SYNC: "1",
      DUIYING_COMPANY_SYNC_STRICT: "1",
      DUIYING_COMPANY_ADAPTER: "directory",
      DUIYING_COMPANY_SOURCE: missing,
      DUIYING_COMPANY_ROOT: tmp(),
      DUIYING_HOOK_ROOTS: EXAMPLE,
    },
  });
  assert.equal(blocked.status, 0);
  assert.match(blocked.stdout, /会议纪要/);

  const env = { ...process.env };
  delete env.DUIYING_COMPANY_SYNC_STRICT;
  delete env.DUIYING_HOOK_SYNC;
  const soft = spawnSync(process.execPath, [SYNC], {
    input: "",
    encoding: "utf8",
    env: {
      ...env,
      DUIYING_COMPANY_ADAPTER: "directory",
      DUIYING_COMPANY_SOURCE: missing,
      DUIYING_COMPANY_ROOT: tmp(),
    },
  });
  assert.equal(soft.status, 0);
  assert.match(soft.stderr, /company-sync:/);
  assert.equal(soft.stdout, "");
});

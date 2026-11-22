import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runAcceptance } from "../scripts/acceptance-dry-run.mjs";

const RUNNER = fileURLToPath(new URL("../scripts/acceptance-dry-run.mjs", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../examples/partner-xiaolin", import.meta.url));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "duiying-accept-"));
}

test("验收跑法记录命中文件，也记录正确地说明未命中", async () => {
  const questions = [
    { id: "hit-deploy", query: "部署", expect: "hit", path: "会议纪要.md" },
    { id: "miss-token", query: "no-such-ledger-441", expect: "miss" },
  ];
  const report = await runAcceptance({ root: EXAMPLE, questions });
  assert.equal(report.ok, true);
  assert.equal(report.total, 2);
  assert.equal(report.passed, 2);
  assert.equal(report.failed, 0);
  const hit = report.items.find(item => item.id === "hit-deploy");
  assert.equal(hit.pass, true);
  assert.ok(hit.paths.includes("会议纪要.md"));
  const miss = report.items.find(item => item.id === "miss-token");
  assert.equal(miss.pass, true);
  assert.equal(miss.explained, true);
  assert.equal(miss.note, "没有命中的记忆。");
  assert.deepEqual(miss.paths, []);

  const wrong = await runAcceptance({
    root: EXAMPLE,
    questions: [{ id: "bad", query: "部署", expect: "hit", path: "不存在.md" }],
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.items[0].pass, false);

  const falseMiss = await runAcceptance({
    root: EXAMPLE,
    questions: [{ id: "bad-miss", query: "部署", expect: "miss" }],
  });
  assert.equal(falseMiss.ok, false);
  assert.equal(falseMiss.items[0].explained, false);

  const dir = tmp();
  const file = path.join(dir, "questions.json");
  const out = path.join(dir, "report.json");
  fs.writeFileSync(file, JSON.stringify({ questions }));
  const res = spawnSync(process.execPath, [RUNNER, "--questions", file, "--root", EXAMPLE, "--out", out], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const written = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(written.ok, true);
  assert.equal(written.total, 2);
  assert.match(res.stderr, /20/);
});

#!/usr/bin/env node
/**
 * scripts/acceptance-dry-run.mjs — 用一份本地题单对一个记忆根跑上浮。
 *
 * 记录每一题是命中了预期文件，还是正确地说明了没有命中。
 * 题单留在本机。不要把题库提交进仓库。
 *
 *   node scripts/acceptance-dry-run.mjs --questions <题单.json> --root <记忆根> [--out 报告.json]
 *
 * 题单：{ "questions": [ { "id", "query", "expect": "hit"|"miss", "path"? } ] }
 * 练习跑用 20 到 30 题。少于或多于这个范围时仍会跑，并在标准错误提示。
 */
import fs from "node:fs";
import { search } from "../engine/core.mjs";

export async function runAcceptance({ root, questions, limit = 10 } = {}) {
  const rootArg = root == null ? "" : String(root).trim();
  if (!rootArg) throw new Error("root 不能为空");
  const itemsIn = normalizeQuestions(questions);
  const items = [];
  for (const q of itemsIn) {
    const keywords = q.query.split(/[,，]/).map(part => part.trim()).filter(Boolean);
    const result = search({
      roots: [rootArg],
      keywords,
      queryText: q.query,
      limit,
    });
    const paths = result.results.map(item => item.path);
    const empty = result.total === 0 && result.results.length === 0;
    const explained = q.expect === "miss" && empty;
    const pass = q.expect === "hit" ? paths.includes(q.path) : explained;
    items.push({
      id: q.id,
      query: q.query,
      expect: q.expect,
      ...(q.path ? { path: q.path } : {}),
      paths,
      pass,
      ...(q.expect === "miss" ? { explained } : {}),
      ...(empty ? { note: "没有命中的记忆。" } : {}),
    });
  }
  const passed = items.filter(item => item.pass).length;
  return {
    ok: passed === items.length,
    total: items.length,
    passed,
    failed: items.length - passed,
    items,
  };
}

function normalizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) throw new Error("题单是空的");
  return questions.map((q, index) => {
    const id = String(q?.id ?? index + 1);
    const query = String(q?.query ?? "").trim();
    if (!query) throw new Error(`题目 ${id} 缺少 query`);
    const expect = String(q?.expect ?? "");
    if (expect !== "hit" && expect !== "miss") throw new Error(`题目 ${id} 的 expect 只能是 hit 或 miss`);
    const file = q?.path == null ? "" : String(q.path).trim();
    if (expect === "hit" && !file) throw new Error(`题目 ${id} 期望命中但没有 path`);
    return { id, query, expect, path: file };
  });
}

function readQuestions(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (err) { throw new Error(`无法读取题单：${err.message}`); }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.questions)) return parsed.questions;
  throw new Error("题单需要 questions 数组");
}

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return "";
  return process.argv[index + 1];
}

async function main() {
  const questionsFile = arg("--questions");
  const root = arg("--root");
  const out = arg("--out");
  if (!questionsFile || !root) {
    process.stderr.write("用法：node scripts/acceptance-dry-run.mjs --questions <题单.json> --root <记忆根> [--out 报告.json]\n");
    process.exitCode = 1;
    return;
  }
  const questions = readQuestions(questionsFile);
  if (questions.length < 20 || questions.length > 30) {
    process.stderr.write(`题单 ${questions.length} 题。练习跑建议 20 到 30 题。\n`);
  }
  const report = await runAcceptance({ root, questions });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(text);
  if (out) fs.writeFileSync(out, text, "utf8");
  if (!report.ok) process.exitCode = 1;
}

const invoked = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/acceptance-dry-run.mjs");
if (invoked) {
  main().then(
    () => process.exit(process.exitCode || 0),
    err => {
      process.stderr.write(`acceptance: ${err && err.message ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}

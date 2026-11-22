/**
 * 冻结集核对。只认 queries.json 里现行词面基线要守住的约束。
 * lexical_current === "expected_miss" 的「必须出现」是留给以后的目标，现行应当找不到。
 */
import fs from "node:fs";
import path from "node:path";
import { search, runDoctor } from "../engine/core.mjs";

export const FROZEN_DIR = path.resolve("evals/frozen/2026-11-22");
export const FROZEN_NOW = Date.parse("2026-11-15T12:00:00+08:00");

export function loadFrozen(dir = FROZEN_DIR) {
  const spec = JSON.parse(fs.readFileSync(path.join(dir, "queries.json"), "utf8"));
  const fixtures = path.join(dir, "fixtures");
  return { spec, fixtures };
}

function rootAbs(fixtures, name) {
  return path.resolve(fixtures, name).split(path.sep).join("/");
}

export function resultLabel(result, roots) {
  if (result.root) {
    const norm = String(result.root).split(path.sep).join("/");
    const hit = roots.find(r => r.abs === norm);
    return `${hit ? hit.name : norm}/${result.path}`;
  }
  if (roots.length === 1) return `${roots[0].name}/${result.path}`;
  return result.path;
}

/**
 * @returns {string[]} 失败原因。空数组表示这条通过。
 */
export function checkFrozenQuery(query, spec, fixtures, searchOpts = {}) {
  const roots = query.roots.map(name => ({ name, abs: rootAbs(fixtures, name) }));
  const keywords = Array.isArray(query.query_keywords) && query.query_keywords.length
    ? query.query_keywords
    : [query.query];
  const limit = query.k || spec.k || 10;
  const useLinks = query.use_links !== undefined ? query.use_links : spec.use_links_default !== false;
  const result = search({
    roots: roots.map(r => r.abs),
    keywords,
    queryText: query.query,
    limit,
    useLinks,
    rerank: query.rerank !== false,
    gate: query.gate === true,
    nowMs: FROZEN_NOW,
    gateSession: new Map(),
    ...searchOpts,
  });
  const labels = result.results.map(r => resultLabel(r, roots));
  const errors = [];
  const expectedMiss = query.lexical_current === "expected_miss" || query.pending === "vector";
  const must = query.must_appear || [];
  if (expectedMiss) {
    for (const rel of must) {
      if (labels.includes(rel)) errors.push(`expected_miss 仍出现 ${rel}`);
    }
  } else {
    for (const rel of must) {
      if (!labels.includes(rel)) errors.push(`缺少 ${rel}`);
    }
  }
  for (const rel of query.must_not_appear || []) {
    if (labels.includes(rel)) errors.push(`不该出现 ${rel}`);
  }
  for (const rel of query.leak_if_appear || []) {
    if (labels.includes(rel)) errors.push(`泄漏 ${rel}`);
  }
  if (query.expect_total != null && result.total !== query.expect_total) {
    errors.push(`total ${result.total} !== ${query.expect_total}`);
  }
  if (query.expect_gate_reason) {
    if (!result.gate || result.gate.reason !== query.expect_gate_reason) {
      errors.push(`gate ${(result.gate && result.gate.reason) || "none"} !== ${query.expect_gate_reason}`);
    }
  }
  for (const rule of query.rank_constraints || []) {
    if (rule.higher && rule.lower) {
      const hi = labels.indexOf(rule.higher);
      const lo = labels.indexOf(rule.lower);
      if (rule.if_both_present && (hi < 0 || lo < 0)) continue;
      if (hi < 0) errors.push(`排序缺少 ${rule.higher}`);
      else if (lo >= 0 && hi > lo) errors.push(`${rule.higher} 应排在 ${rule.lower} 之前`);
    }
    if (rule.order_by === "memory_date_desc") {
      for (let i = 1; i < result.results.length; i++) {
        if (result.results[i - 1].date < result.results[i].date) {
          errors.push(`日期不是从新到旧：${result.results[i - 1].path} ${result.results[i - 1].date} < ${result.results[i].path} ${result.results[i].date}`);
          break;
        }
      }
    }
    if (rule.before && rule.after_any_unigram_noise) {
      const before = labels.indexOf(rule.before);
      const noise = result.results.findIndex(r => String(r.note || "").includes("按单字近似匹配"));
      if (before < 0) errors.push(`排序缺少 ${rule.before}`);
      else if (noise >= 0 && noise < before) errors.push(`${rule.before} 应排在单字近似之前`);
    }
  }
  if (query.no_cross_root_links && roots.length > 1) {
    for (const item of result.results) {
      for (const link of item.links || []) {
        if (roots.some(r => link === r.name || link.startsWith(`${r.name}/`))) {
          errors.push(`links 跨根：${item.path} -> ${link}`);
        }
      }
    }
  }
  if (Array.isArray(query.root_constraints)) {
    for (const rule of query.root_constraints) {
      const item = result.results.find(r => resultLabel(r, roots) === rule.path);
      if (!item) {
        errors.push(`root 约束找不到 ${rule.path}`);
        continue;
      }
      const label = resultLabel(item, roots);
      if (!label.startsWith(`${rule.root}/`)) errors.push(`${rule.path} 不属于 ${rule.root}`);
    }
  }
  if (query.must_not_guess_successor_for) {
    const item = result.results.find(r => resultLabel(r, roots) === query.must_not_guess_successor_for);
    const note = item?.note || "";
    if (/east\/纪要|west\/纪要/.test(note)) errors.push(`把同名文件猜成继任：${note}`);
  }
  if (Array.isArray(query.doctor_expect)) {
    const report = runDoctor(roots.map(r => r.abs)).report;
    for (const exp of query.doctor_expect) {
      const hit = report.find(r =>
        r.type === exp.type
        && r.file === exp.file
        && (!exp.detail_contains || String(r.detail).includes(exp.detail_contains)));
      if (!hit) errors.push(`doctor 缺少 ${exp.type} ${exp.file}`);
    }
  }
  return errors;
}

export function checkFrozenSet(fixtures, spec, searchOpts = {}) {
  const failures = [];
  const byId = new Map();
  for (const query of spec.queries) {
    const errors = checkFrozenQuery(query, spec, fixtures, searchOpts);
    byId.set(query.id, errors);
    if (query.id === "T3") {
      const t2 = spec.queries.find(q => q.id === "T2");
      if (t2) {
        const a = searchLabels(query, spec, fixtures, searchOpts);
        const b = searchLabels(t2, spec, fixtures, searchOpts);
        if (a.join("\n") === b.join("\n")) errors.push("结果与只问「最近」相同");
      }
    }
    if (errors.length) failures.push({ id: query.id, errors });
  }
  return failures;
}

function searchLabels(query, spec, fixtures, searchOpts) {
  const roots = query.roots.map(name => ({ name, abs: rootAbs(fixtures, name) }));
  const keywords = Array.isArray(query.query_keywords) && query.query_keywords.length
    ? query.query_keywords
    : [query.query];
  const result = search({
    roots: roots.map(r => r.abs),
    keywords,
    queryText: query.query,
    limit: query.k || spec.k || 10,
    useLinks: query.use_links !== undefined ? query.use_links : spec.use_links_default !== false,
    rerank: query.rerank !== false,
    gate: query.gate === true,
    nowMs: FROZEN_NOW,
    gateSession: new Map(),
    ...searchOpts,
  });
  return result.results.map(r => resultLabel(r, roots));
}

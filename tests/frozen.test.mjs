import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFrozenSet, loadFrozen } from "./frozen-eval.mjs";

test("冻结词面集：没有索引时与现行全量扫描一致", () => {
  const { spec, fixtures } = loadFrozen();
  const failures = checkFrozenSet(fixtures, spec, { index: false });
  assert.deepEqual(failures, [], failures.map(f => `${f.id}: ${f.errors.join("; ")}`).join("\n"));
});

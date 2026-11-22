import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createEmbedder, embeddingReadiness, EMBEDDING_MODELS, BGE_QUERY_PREFIX } from "../engine/embedding.mjs";

const HAS_DEP = existsSync(new URL("../node_modules/@huggingface/transformers", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

test("工厂: backend none 返回 null——零依赖哲学的落地（不装依赖就是纯词面）", async () => {
  const embedder = await createEmbedder({ backend: "none" });
  assert.equal(embedder, null);
});

test("工厂: 未知后端与未知模型给出可行动的报错", async () => {
  await assert.rejects(
    () => createEmbedder({ backend: "magic" }),
    /未知后端.*(transformers\.js|none)/,
  );
  // 模型名校验在可选依赖检查之前——与依赖是否安装无关，都报「未知模型」
  await assert.rejects(
    () => createEmbedder({ backend: "transformers.js", model: "nope" }),
    /未知模型 "nope"/,
  );
});

test("readiness: none 后端的就绪报告说明纯词面", () => {
  const r = embeddingReadiness({ backend: "none" });
  assert.equal(r.backend, "none");
  assert.match(r.note, /纯词面/);
});

test("readiness: transformers.js 后端报告模型名与维度", () => {
  const r = embeddingReadiness({ backend: "transformers.js" });
  assert.equal(r.model, EMBEDDING_MODELS["bge-small-zh"].model);
  assert.equal(r.dim, 512);
  assert.equal(typeof r.depInstalled, "boolean");
});

// 真模型冒烟：仅在可选依赖已安装的环境跑（CI 无模型则跳过，本地装了就验）。
test("冒烟: transformers.js 真模型出归一化向量（依赖缺失则跳过）", { skip: !HAS_DEP }, async () => {
  const embedder = await createEmbedder({ backend: "transformers.js", offline: true });
  assert.equal(embedder.dim, EMBEDDING_MODELS["bge-small-zh"].dim);
  const rows = await embedder.embed(["服务器宕机，服务中断"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, embedder.dim);
  // 归一化校验：模长 ≈ 1
  let norm = 0;
  for (const v of rows[0]) norm += v * v;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-3, `模长 ${Math.sqrt(norm)} 应约等于 1`);
  // 查询侧带指令前缀：同 query 两次调用结果一致（确定性）
  const q1 = await embedder.embedQuery("服务器宕机");
  const q2 = await embedder.embedQuery("服务器宕机");
  assert.deepEqual([...q1], [...q2]);
});

#!/usr/bin/env node
/**
 * build-vector-index.mjs — 向量索引构建（安装手册第五章配套）
 *
 * 扫描记忆根下全部 .md，用 embedding 后端出向量，写入 VectorStore 索引目录。
 * 全量重建语义：已有索引先清空（rebuild）——文档变更后重跑即可。
 *
 * 用法：
 *   node scripts/build-vector-index.mjs --root workspace/memories/common \
 *        --store workspace/vectors [--model bge-small-zh] [--offline] [--batch 8]
 *
 * 企业内网：--offline 禁止联网，模型文件须已在缓存目录（安装包分发，见安装手册第五章）。
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { LocalFileStore } from "../engine/vector-store.mjs";
import { createEmbedder, EMBEDDING_MODELS } from "../engine/embedding.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = name => args.includes(`--${name}`);

const root = arg("root");
const storeDir = arg("store");
if (!root || !storeDir) {
  const modelKey = arg("model", "bge-small-zh");
  console.log(`用法：node scripts/build-vector-index.mjs --root <记忆根目录> --store <索引目录> [--model ${modelKey}] [--offline] [--batch 8]
内置模型：${Object.keys(EMBEDDING_MODELS).join(" / ")}（维度：${Object.values(EMBEDDING_MODELS).map(m => m.dim).join(" / ")}）`);
  process.exit(1);
}

const modelKey = arg("model", "bge-small-zh");
const batch = Number(arg("batch", "8"));

function walkMd(dir, base) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkMd(full, base));
    else if (/\.md$/i.test(name)) out.push({ path: full, rel: relative(base, full).replace(/\\/g, "/") });
  }
  return out;
}

console.log(`[vec] 扫描 ${root} …`);
const files = walkMd(root, root).map(f => ({ ...f, text: readFileSync(f.path, "utf8") }));

if (!files.length) {
  console.log("[vec] 记忆根下没有 .md 文件——先导入文档再建索引");
  process.exit(0);
}
console.log(`[vec] 共 ${files.length} 个记忆文件`);

const embedder = await createEmbedder({
  backend: "transformers.js",
  model: modelKey,
  offline: has("offline"),
  cacheDir: arg("cache-dir"),
});
if (!embedder) { console.error("[vec] embedding 后端不可用"); process.exit(1); }
console.log(`[vec] 模型 ${EMBEDDING_MODELS[modelKey].model}（${embedder.dim} 维）`);

const store = new LocalFileStore(storeDir, { dim: embedder.dim }).rebuild(embedder.dim);
let done = 0;
for (let i = 0; i < files.length; i += batch) {
  const slice = files.slice(i, i + batch);
  const vecs = await embedder.embed(slice.map(f => `${f.rel}\n${f.text}`));
  store.upsert(vecs.map((vec, j) => ({ id: slice[j].rel, vec })));
  done += vecs.length;
  console.log(`[vec] ${done}/${files.length}`);
}
store.flush();
const s = store.stats();
console.log(`[vec] 完成：${s.count} 条向量落盘 → ${storeDir}（overLimit: ${s.overLimit}）`);

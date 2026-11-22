/**
 * vector-store.mjs — 向量存储与最近邻检索（企业记忆库线 M1.1）
 *
 * 设计要点（docs/notes/向量检索设计-M1-2026-11-22.md §2）：
 * - VectorStore 是**接口**，LocalFileStore 是本期默认实现；调用方只面向接口，
 *   未来可插拔 sqlite-vec / HNSW / 外部向量库（大型公司共享池场景），API 不变。
 * - 本地文件存储 = vectors.bin（Float32Array 平铺）+ vectors.meta.json（id → [offset, dim]）。
 *   10 万条 × 512 维 ≈ 200MB 内存、暴力余弦 ~50ms，单部门规模下完全可接受；
 *   超过 SOFT_LIMIT 时 stats().overLimit = true 提示升级后端，功能不降级。
 * - 纯函数（cosine / topK）与 IO（LocalFileStore）分层，与 lib.mjs 的无副作用纪律一致。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** 单根软上限（条数）。超过后 stats().overLimit = true，提示升级后端，功能不降级。 */
export const SOFT_LIMIT = 100_000;

/** 计算两个等长向量的余弦相似度。零向量返回 0（与任何向量都不相似）。 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/** 暴力最近邻：query 与 vecs 里每个向量算余弦，返回按相似度降序的 {id, score} 前 k 个。 */
export function topK(queryVec, entries, k = 10) {
  const scored = [];
  for (const { id, vec } of entries) {
    const score = cosine(queryVec, vec);
    if (score > 0) scored.push({ id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * LocalFileStore — 本地文件向量存储（VectorStore 接口的默认实现）。
 *
 * 文件布局（dir 下）：
 *   vectors.bin       Float32Array 平铺，追加写
 *   vectors.meta.json { dim, nextOffset, items: { [id]: [offsetInFloats, dim] } }
 *
 * 全部同步 IO——与引擎现有 readFileSync 风格一致，单进程内串行使用。
 * upsert 同 id 覆盖：旧槽位标记删除（compaction 时回收），新向量追加。
 */
export class LocalFileStore {
  constructor(dir, { dim = 512 } = {}) {
    this.dir = dir;
    this.dim = dim;
    this.binPath = join(dir, "vectors.bin");
    this.metaPath = join(dir, "vectors.meta.json");
    this.items = new Map(); // id -> { offset, dim }
    this.vectors = [];      // 内存中的 Float32Array 列表（与文件同序）
    this.loaded = false;
  }

  #assertLoaded() {
    if (!this.loaded) throw new Error("VectorStore: 先调用 load() 再使用");
  }

  /** 从磁盘加载（不存在则视为空库）。dim 不匹配的旧文件按文件内 dim 为准并在加载时报错。 */
  load() {
    this.items = new Map();
    this.vectors = [];
    if (!existsSync(this.metaPath)) {
      this.loaded = true;
      return this;
    }
    const meta = JSON.parse(readFileSync(this.metaPath, "utf8"));
    if (meta.dim !== this.dim) {
      throw new Error(`VectorStore: 维度不匹配（文件 ${meta.dim} vs 配置 ${this.dim}），换模型请 rebuild()`);
    }
    const bytes = existsSync(this.binPath) ? readFileSync(this.binPath) : Buffer.alloc(0);
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
    for (const [id, [offset, dim]] of Object.entries(meta.items)) {
      this.items.set(id, { offset, dim });
      this.vectors.push(floats.slice(offset, offset + dim));
    }
    this.loaded = true;
    return this;
  }

  /** 插入或覆盖。vec 长度必须等于配置维度。内存生效，flush() 落盘。 */
  upsert(items) {
    this.#assertLoaded();
    for (const { id, vec } of items) {
      if (!Array.isArray(vec) && !(vec instanceof Float32Array)) {
        throw new Error(`VectorStore: ${id} 的向量必须是数组或 Float32Array`);
      }
      if (vec.length !== this.dim) {
        throw new Error(`VectorStore: ${id} 维度 ${vec.length} ≠ 配置 ${this.dim}`);
      }
      const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
      if (this.items.has(id)) {
        const { offset } = this.items.get(id);
        this.items.set(id, { offset, dim: this.dim });
        this.vectors[offset / this.dim] = f32; // 同 id 原位覆盖（槽位不变）
      } else {
        const offset = this.vectors.length * this.dim;
        this.items.set(id, { offset, dim: this.dim });
        this.vectors.push(f32);
      }
    }
    return this;
  }

  /** 删除指定 id（内存生效，flush() 落盘）。不存在的 id 静默忽略。 */
  remove(ids) {
    this.#assertLoaded();
    for (const id of ids) {
      const slot = this.items.get(id);
      if (!slot) continue;
      this.vectors[slot.offset / this.dim] = new Float32Array(this.dim); // 置零向量，cosine 恒 0，检索自然排除
      this.items.delete(id);
    }
    return this;
  }

  /** 暴力最近邻检索。返回 {id, score} 按相似度降序前 k 个；空库返回空数组。 */
  search(queryVec, k = 10) {
    this.#assertLoaded();
    if (!Array.isArray(queryVec) && !(queryVec instanceof Float32Array)) {
      throw new Error("VectorStore: 查询向量必须是数组或 Float32Array");
    }
    if (queryVec.length !== this.dim) {
      throw new Error(`VectorStore: 查询向量维度 ${queryVec.length} ≠ 配置 ${this.dim}`);
    }
    const entries = [];
    for (const [id, { offset, dim }] of this.items) {
      entries.push({ id, vec: this.vectors[offset / dim] });
    }
    return topK(queryVec, entries, k);
  }

  /** 落盘：重写 vectors.bin（回收已删除槽位）+ meta.json。 */
  flush() {
    this.#assertLoaded();
    mkdirSync(this.dir, { recursive: true });
    // compaction：只写存活向量，重排 offset
    const alive = [...this.items.entries()];
    const out = new Float32Array(alive.length * this.dim);
    const metaItems = {};
    alive.forEach(([id, slot], i) => {
      const vec = this.vectors[slot.offset / this.dim];
      out.set(vec, i * this.dim);
      metaItems[id] = [i * this.dim, this.dim];
    });
    writeFileSync(this.binPath, Buffer.from(out.buffer));
    writeFileSync(this.metaPath, JSON.stringify({ dim: this.dim, items: metaItems }, null, 0));
    // compaction 后内存与文件重新对齐
    this.items = new Map(Object.entries(metaItems).map(([id, [offset, dim]]) => [id, { offset, dim }]));
    this.vectors = [];
    for (let i = 0; i < alive.length; i++) {
      this.vectors.push(out.slice(i * this.dim, (i + 1) * this.dim));
    }
    return this;
  }

  /** 空库与统计：条数、维度、是否超软上限。 */
  stats() {
    this.#assertLoaded();
    const count = this.items.size;
    return { count, dim: this.dim, softLimit: SOFT_LIMIT, overLimit: count > SOFT_LIMIT };
  }

  /** 全量重建（换 embedding 模型后维度变化时用）：清空，等外部重新灌向量。 */
  rebuild(newDim) {
    if (newDim) this.dim = newDim;
    this.items = new Map();
    this.vectors = [];
    try { unlinkSync(this.binPath); } catch { /* 首次无文件 */ }
    try { unlinkSync(this.metaPath); } catch { /* 首次无文件 */ }
    this.loaded = true;
    return this;
  }
}

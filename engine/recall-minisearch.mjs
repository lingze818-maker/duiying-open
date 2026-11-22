/**
 * recall-minisearch.mjs — Layer 1 的当前实现。
 *
 * 只用 MiniSearch 做候选召回。分数留给 Layer 2。这个文件是仓库里唯一
 * 加载 minisearch 包的地方；包没装时 available() 为 false，调用方全量扫描。
 *
 * 分词复用 lib.mjs 的中文 bigram。索引进额外的拉丁子串，只为把
 * 「sql 出现在 sqlite 里」这类子串命中也召回来，不写进给排序层的 tf。
 * 不使用 MiniSearch 默认的英文词干。
 */
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { tokenize, expandSynonyms, isTimeOnlyQuery } from "./lib.mjs";
import {
  INDEX_DIR_NAME, INDEX_FILE_NAME, SKIP_DIRS, resolvedRoot, walkMarkdown, readMemoryFile,
} from "./scan.mjs";

const require = createRequire(import.meta.url);
const FORMAT = 1;

let ctorCache;
let lastMetaValue = null;
/** @type {Map<string, { sig: string, mini: object, data: object }>} */
const openShards = new Map();

function loadCtor() {
  if (ctorCache !== undefined) return ctorCache;
  try {
    const mod = require("minisearch");
    const Ctor = typeof mod === "function" ? mod : (mod?.default || mod?.MiniSearch);
    ctorCache = typeof Ctor === "function" ? Ctor : null;
  } catch {
    ctorCache = null;
  }
  return ctorCache;
}

function keepTerm(term) {
  return term ? term : null;
}

/** 索引侧分词：引擎 bigram，再加拉丁词的短子串，便于子串召回。 */
function indexTokenize(text) {
  const terms = tokenize(String(text ?? ""));
  const lower = String(text ?? "").toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    const word = m[0];
    const maxLen = Math.min(word.length, 16);
    for (let len = 2; len <= maxLen; len++) {
      for (let i = 0; i + len <= word.length; i++) terms.push(word.slice(i, i + len));
    }
  }
  return terms;
}

function miniOptions() {
  return {
    idField: "id",
    fields: ["title", "body", "file"],
    storeFields: [],
    tokenize: indexTokenize,
    processTerm: keepTerm,
    searchOptions: {
      combineWith: "OR",
      prefix: false,
      fuzzy: false,
      tokenize: (text) => tokenize(String(text ?? "")),
      processTerm: keepTerm,
    },
  };
}

function indexFile(root) {
  return path.join(path.resolve(root), INDEX_DIR_NAME, INDEX_FILE_NAME);
}

function excludeList(exclude) {
  const out = [];
  const src = exclude instanceof Set ? [...exclude] : (Array.isArray(exclude) ? exclude : []);
  for (const name of src) {
    const s = String(name ?? "").trim();
    if (!s || SKIP_DIRS.has(s) || out.includes(s)) continue;
    out.push(s);
  }
  out.sort();
  return out;
}

function sameExclude(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function skipSet(exclude) {
  return new Set([...SKIP_DIRS, ...excludeList(exclude)]);
}

function sha256(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function packDoc(doc, hash, size, mtimeMs) {
  const fm = {};
  for (const [k, v] of doc.fm) fm[k] = v;
  const tf = {};
  for (const [k, v] of doc.tf) tf[k] = v;
  return {
    hash,
    size,
    mtimeMs,
    title: doc.title,
    base: doc.base,
    len: doc.len,
    whenIso: doc.when.iso,
    whenMs: doc.when.ms,
    fm,
    tf,
  };
}

function miniDocument(doc) {
  return { id: doc.rel, title: doc.title, body: doc.content, file: doc.base };
}

function statsFrom(docs) {
  const df = {};
  let N = 0;
  let totalLen = 0;
  for (const packed of Object.values(docs)) {
    N++;
    totalLen += packed.len || 0;
    for (const term of Object.keys(packed.tf || {})) df[term] = (df[term] || 0) + 1;
  }
  return { N, totalLen, df };
}

function statsToMap(stats) {
  return {
    df: new Map(Object.entries(stats?.df || {})),
    N: stats?.N || 0,
    totalLen: stats?.totalLen || 0,
    avgdl: stats?.N ? stats.totalLen / stats.N : 1,
  };
}

function emptyData(exclude) {
  return { format: FORMAT, tokenizer: "duiying-cjk-bigram", exclude: excludeList(exclude), docs: {}, stats: statsFrom({}) };
}

function fileSig(file) {
  const st = fs.statSync(file);
  return `${st.size}:${Math.round(st.mtimeMs)}`;
}

function saveShard(root, data, mini) {
  const file = indexFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = { ...data, mini: mini.toJSON() };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, file);
  openShards.set(resolvedRoot(root), { sig: fileSig(file), mini, data });
}

function loadShard(root) {
  const key = resolvedRoot(root);
  const file = indexFile(root);
  if (!fs.existsSync(file)) return null;
  const sig = fileSig(file);
  const cached = openShards.get(key);
  if (cached && cached.sig === sig) return cached;
  let payload;
  try { payload = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
  if (!payload || payload.format !== FORMAT || !payload.mini || !payload.docs || !payload.stats) return null;
  const Ctor = loadCtor();
  if (!Ctor) return null;
  let mini;
  try { mini = Ctor.loadJSON(JSON.stringify(payload.mini), miniOptions()); }
  catch { return null; }
  const data = {
    format: FORMAT,
    tokenizer: payload.tokenizer || "duiying-cjk-bigram",
    exclude: Array.isArray(payload.exclude) ? payload.exclude : [],
    docs: payload.docs,
    stats: payload.stats,
  };
  const shard = { sig, mini, data };
  openShards.set(key, shard);
  return shard;
}

function listFiles(root, exclude) {
  return [...walkMarkdown(root, skipSet(exclude))];
}

function relOf(rootFwd, file) {
  return path.resolve(file).split(path.sep).join("/").replace(rootFwd + "/", "");
}

/**
 * 只增删改变过的文件。哈希相同只更新 mtime/size，不重写倒排。
 * 返回 null 表示这份索引读不出来（损坏）。
 */
function updateShard(root, { create = false, exclude, force = false } = {}) {
  const rootFwd = resolvedRoot(root);
  const file = indexFile(root);
  const exists = fs.existsSync(file);
  if (!exists && !create) return { absent: true };
  const wantedExclude = excludeList(exclude);

  let shard = null;
  if (exists && !force) shard = loadShard(root);
  if (exists && !shard && !create && !force) return { corrupt: true };
  if (!shard || (exclude !== undefined && !sameExclude(shard.data.exclude, wantedExclude) && create)) {
    shard = null;
  }
  if (shard && exclude !== undefined && !sameExclude(shard.data.exclude, wantedExclude) && !create) {
    return { excludeMismatch: true, shard };
  }

  const Ctor = loadCtor();
  if (!Ctor) return { unavailable: true };

  const excludeUsed = shard ? shard.data.exclude : wantedExclude;
  const files = listFiles(root, excludeUsed);
  if (!shard) {
    const mini = new Ctor(miniOptions());
    const data = emptyData(excludeUsed);
    let added = 0;
    for (const abs of files) {
      const mem = readMemoryFile(rootFwd, abs);
      if (!mem) continue;
      const st = fs.statSync(abs);
      data.docs[mem.rel] = packDoc(mem, sha256(abs), st.size, Math.round(st.mtimeMs));
      mini.add(miniDocument(mem));
      added++;
    }
    data.stats = statsFrom(data.docs);
    saveShard(root, data, mini);
    return { added, updated: 0, removed: 0, unchanged: 0, retouched: 0, docs: added, created: true };
  }

  const { mini, data } = shard;
  const seen = new Set();
  let added = 0, updated = 0, removed = 0, unchanged = 0, retouched = 0;
  for (const abs of files) {
    const rel = relOf(rootFwd, abs);
    seen.add(rel);
    const st = fs.statSync(abs);
    const size = st.size;
    const mtimeMs = Math.round(st.mtimeMs);
    const prev = data.docs[rel];
    if (prev && prev.size === size && prev.mtimeMs === mtimeMs) {
      unchanged++;
      continue;
    }
    const hash = sha256(abs);
    if (prev && prev.hash === hash) {
      prev.size = size;
      prev.mtimeMs = mtimeMs;
      retouched++;
      continue;
    }
    const mem = readMemoryFile(rootFwd, abs);
    if (!mem) continue;
    data.docs[rel] = packDoc(mem, hash, size, mtimeMs);
    if (prev) {
      mini.replace(miniDocument(mem));
      updated++;
    } else {
      mini.add(miniDocument(mem));
      added++;
    }
  }
  for (const rel of Object.keys(data.docs)) {
    if (seen.has(rel)) continue;
    mini.discard(rel);
    delete data.docs[rel];
    removed++;
  }
  if (added || updated || removed || retouched) {
    if (updated || removed) {
      try { mini.vacuum(); } catch { /* 真空失败不挡住这次写入 */ }
    }
    data.stats = statsFrom(data.docs);
    saveShard(root, data, mini);
  }
  return {
    added, updated, removed, unchanged, retouched,
    docs: Object.keys(data.docs).length,
    created: false,
  };
}

function materialize(rootFwd, rel, packed, readBody) {
  let content = "";
  if (readBody) {
    const abs = path.join(rootFwd, ...rel.split("/"));
    try { content = fs.readFileSync(abs, "utf8"); } catch { return null; }
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  }
  const fm = new Map(Object.entries(packed.fm || {}));
  const tf = new Map(Object.entries(packed.tf || {}));
  return {
    root: rootFwd,
    rel,
    base: packed.base,
    title: packed.title,
    content,
    mtime: new Date(packed.mtimeMs),
    when: { iso: packed.whenIso, ms: packed.whenMs },
    tf,
    len: packed.len,
    fm,
  };
}

function recallRoot(root, keywords, exclude) {
  const counts = updateShard(root, { create: false, exclude });
  if (!counts || counts.absent || counts.corrupt || counts.unavailable || counts.excludeMismatch) {
    return { miss: counts || { absent: true } };
  }
  const shard = loadShard(root);
  if (!shard) return { miss: { corrupt: true } };
  const expanded = expandSynonyms(keywords.map(k => String(k)));
  const query = expanded.join("\n");
  let hits = [];
  if (tokenize(query).length) {
    hits = shard.mini.search(query, {
      combineWith: "OR",
      prefix: false,
      fuzzy: false,
      tokenize: (text) => tokenize(String(text ?? "")),
      processTerm: keepTerm,
    });
  }
  // 词法命中只决定要读哪些正文。排序仍要看到整库的 tf / 标题 / 状态，
  // 否则联想扩散和最大归一会跟全量扫描不一致。正文只读命中篇，以及带取代标记的篇。
  const readBody = new Set(hits.map(hit => hit.id));
  for (const [rel, packed] of Object.entries(shard.data.docs)) {
    const sup = packed?.fm?.superseded_by;
    if (typeof sup !== "string" || !sup) continue;
    readBody.add(rel);
    if (shard.data.docs[sup]) readBody.add(sup);
  }
  const rootFwd = resolvedRoot(root);
  const docs = [];
  let materialized = 0;
  const seen = new Set();
  for (const abs of listFiles(root, shard.data.exclude)) {
    const rel = relOf(rootFwd, abs);
    const packed = shard.data.docs[rel];
    if (!packed) continue;
    seen.add(rel);
    const doc = materialize(rootFwd, rel, packed, readBody.has(rel));
    if (!doc) return { miss: { corrupt: true } };
    if (readBody.has(rel)) materialized++;
    docs.push(doc);
  }
  if (seen.size !== Object.keys(shard.data.docs).length) return { miss: { corrupt: true } };
  return {
    docs,
    stats: statsToMap(shard.data.stats),
    counts,
    shardDocs: docs.length,
    materialized,
  };
}

export const minisearchBackend = {
  id: "minisearch",
  available() {
    return Boolean(loadCtor());
  },
  present(root) {
    return Boolean(root) && fs.existsSync(indexFile(root));
  },
  lastMeta() {
    return lastMetaValue;
  },
  refresh(root, opts = {}) {
    if (!loadCtor()) return { ok: false, reason: "unavailable" };
    if (!root || !String(root).trim()) return { ok: false, reason: "error", message: "root 不能为空" };
    const result = updateShard(root, {
      create: opts.create !== false,
      exclude: opts.exclude,
      force: opts.force === true,
    });
    if (!result) return { ok: false, reason: "error" };
    if (result.unavailable) return { ok: false, reason: "unavailable" };
    if (result.absent) return { ok: true, absent: true, added: 0, updated: 0, removed: 0, unchanged: 0, retouched: 0, docs: 0 };
    if (result.corrupt) return { ok: false, reason: "corrupt" };
    if (result.excludeMismatch) return { ok: false, reason: "exclude-mismatch" };
    return { ok: true, ...result };
  },
  /**
   * 每个根单独召回再合并统计。任一根本身没有可用索引，整次返回 null，
   * 不把「有索引的根」和「没索引的根」拼成半份结果。
   */
  recall(request) {
    lastMetaValue = null;
    if (!loadCtor()) return null;
    const roots = Array.isArray(request?.roots) ? request.roots : [];
    if (!roots.length) return null;
    const queryText = String(request?.queryText ?? "");
    if (isTimeOnlyQuery(queryText)) return null;
    const keywords = Array.isArray(request?.keywords) ? request.keywords : [];
    const parts = [];
    for (const root of roots) {
      const part = recallRoot(root, keywords, request?.exclude);
      if (part.miss) {
        lastMetaValue = { fallback: part.miss.corrupt ? "corrupt" : part.miss.absent ? "missing" : "unused" };
        return null;
      }
      parts.push(part);
    }
    const df = new Map();
    let N = 0;
    let totalLen = 0;
    const docs = [];
    let materialized = 0;
    let shardDocs = 0;
    const added = [];
    for (const part of parts) {
      N += part.stats.N;
      totalLen += part.stats.totalLen;
      for (const [term, n] of part.stats.df) df.set(term, (df.get(term) || 0) + n);
      docs.push(...part.docs);
      materialized += part.materialized;
      shardDocs += part.shardDocs;
      added.push(part.counts);
    }
    lastMetaValue = {
      shards: parts.length,
      shardDocs,
      materialized,
      added: added.reduce((n, c) => n + (c.added || 0), 0),
      updated: added.reduce((n, c) => n + (c.updated || 0), 0),
      removed: added.reduce((n, c) => n + (c.removed || 0), 0),
      unchanged: added.reduce((n, c) => n + (c.unchanged || 0), 0),
    };
    return {
      docs,
      stats: { df, N, avgdl: N ? totalLen / N : 1 },
    };
  },
};

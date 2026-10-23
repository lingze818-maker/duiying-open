/**
 * lib.mjs — 对影记忆上浮引擎的纯函数层（供 surface.mjs CLI 与程序化调用共用）
 *
 * 全部函数无副作用、无 IO——索引与打分的数据都在参数里，方便测试与嵌入。
 */
export const K1 = 1.5, B = 0.75;

/** 分词：英文/数字整串为 token，CJK 段切字符 bigram（"记忆上浮" → ["记忆","忆上","上浮"]） */
export function tokenize(s) {
  const out = [];
  const lower = s.toLowerCase();
  let buf = "", prevCJK = false;
  const flush = () => { if (buf) { out.push(buf); buf = ""; } };
  for (const ch of lower) {
    const cjk = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch);
    const word = /[a-z0-9]/.test(ch);
    if (word) { if (prevCJK) flush(); buf += ch; prevCJK = false; continue; }
    if (cjk) {
      if (!prevCJK) flush();
      if (prevCJK && buf) out.push(buf.slice(-1) + ch);
      buf = ch; prevCJK = true; continue;
    }
    flush(); prevCJK = false;
  }
  if (!prevCJK) flush(); // 尾部 CJK 字符已进 bigram，只有残留的英文/数字 token 才需要收尾
  return out;
}

/** 文档频率表：{df: Map<token, docCount>, N, avgdl} */
export function buildStats(docs) {
  const df = new Map();
  let total = 0;
  for (const d of docs) {
    total += d.len;
    for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  return { df, N: docs.length, avgdl: docs.length ? total / docs.length : 1 };
}

/** BM25 单文档打分（Okapi，k1=1.5 b=0.75） */
export function bm25(queryTokens, d, stats) {
  let s = 0;
  for (const t of queryTokens) {
    const f = d.tf.get(t);
    if (!f) continue;
    const n = stats.df.get(t) || 0;
    const idf = Math.log(1 + (stats.N - n + 0.5) / (n + 0.5));
    s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / stats.avgdl));
  }
  return s;
}

/** 时间先验。mtimeMs 是记忆发生时刻：frontmatter date 的本地零点，或文件 mtime。
 *  常态：30 天内 1.25 / 90 天内 1.1；timeMode（查询含时间词，时间优先）：1.6 / 1.3。 */
export function timeBoost(mtimeMs, nowMs, timeMode) {
  const days = (nowMs - mtimeMs) / 86400000;
  if (timeMode) return days <= 30 ? 1.6 : days <= 90 ? 1.3 : 1.0;
  return days <= 30 ? 1.25 : days <= 90 ? 1.1 : 1.0;
}

/** 时间词检测：查询含时间词 → 切时间优先模式。英文词与 README.en 的说明对齐，用词边界避免误伤。 */
export function hasTimeWord(s) {
  return /(最近|上周|上个月|上月|去年|今年|今天|昨天|前天|以前|之前|早期|当初|前几天|近来)/i.test(s)
    || /\b(?:recently|today|yesterday|earlier|last\s+week|last\s+month|last\s+year)\b/i.test(s);
}

/** 本地日历日 YYYY-MM-DD。不用 toISOString，避免东八区凌晨被记成前一天。 */
export function formatLocalDate(date) {
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 合法的记忆日期：整值必须是真实存在的 YYYY-MM-DD。
 * 返回该日本地零点，和 formatLocalDate / mtime 同一时区口径。
 * 缺省、带时间、斜杠、溢出（如 2026-02-31）都返回 null，调用方退回 mtime。
 */
export function parseMemoryDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const y = Number(value.slice(0, 4));
  const mo = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return { iso: value, ms: dt.getTime() };
}

/** 记忆发生时刻：有合法 frontmatter date 用它，否则用 mtime。 */
export function memoryInstant(fm, mtime) {
  const parsed = parseMemoryDate(fm?.get?.("date"));
  if (parsed) return parsed;
  const date = mtime instanceof Date ? mtime : new Date(mtime);
  return { iso: formatLocalDate(date), ms: date.getTime() };
}

/** 去掉闭合的 frontmatter，只留正文。未闭合则整篇都算正文。 */
function markdownBody(md) {
  const text = md.charCodeAt(0) === 0xfeff ? md.slice(1) : md;
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return text;
  const close = lines.indexOf("---", 1);
  if (close === -1) return text;
  return lines.slice(close + 1).join("\n");
}

/** 正文（不含 frontmatter）里是否有真实的 YYYY-MM-DD。不认别的日期写法。 */
export function bodyHasCalendarDate(md) {
  if (typeof md !== "string" || !md) return false;
  const re = /(?:^|[^\d])(\d{4}-\d{2}-\d{2})(?!\d)/g;
  let m;
  const body = markdownBody(md);
  while ((m = re.exec(body))) {
    if (parseMemoryDate(m[1])) return true;
  }
  return false;
}

/**
 * 多个语料根里可以有相同的相对路径。带 root 时身份是「根 + 相对路径」，
 * 否则仍是相对路径（单根，以及不带根的纯函数调用）。
 */
export function memoryKey(d) {
  if (d?.root) return `${d.root}\0${d.rel}`;
  return d.rel;
}

/** 把语料根和相对路径拼成可打开的位置。无根时原样返回相对路径。 */
export function joinRoot(root, rel) {
  if (!root) return rel;
  return `${String(root).replace(/\/+$/, "")}/${rel}`;
}

/** 重合度 |A∩B| / min(|A|,|B|)。空集为 0。建链、doctor、检索降噪必须共用这一份。 */
export function overlapRatio(a, b) {
  if (!a?.size || !b?.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  return inter / small.size;
}

/**
 * see-also 建链：两两 bigram 集合重合度（|A∩B| / min(|A|,|B|)）≥ threshold 的记为邻居，
 * 每篇最多 maxLinks 个。返回 links[i] = [[j, sim], ...]。
 */
export function buildLinks(sets, threshold = 0.18, maxLinks = 3) {
  const n = sets.length;
  const links = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = overlapRatio(sets[i], sets[j]);
      if (sim >= threshold) { links[i].push([j, sim]); links[j].push([i, sim]); }
    }
  }
  for (const l of links) { l.sort((x, y) => y[1] - x[1]); l.length = Math.min(l.length, maxLinks); }
  return links;
}

/** 联想扩散：命中分数沿链分发 shareRatio，跑 rounds 轮（图扩散检索的降维版）。shareRatio 默认 0.35——扩散是联想不是主检索，宁轻勿重（簇状语料实测：过强会整团抬分）。 */
export function spread(scores, links, shareRatio = 0.35, rounds = 2) {
  for (let r = 0; r < rounds; r++) {
    const delta = new Map();
    scores.forEach((s, i) => {
      if (s <= 0 || !links[i].length) return;
      const share = (s * shareRatio) / links[i].length;
      for (const [j] of links[i]) delta.set(j, (delta.get(j) || 0) + share);
    });
    for (const [j, v] of delta) scores[j] += v;
  }
  return scores;
}

// ================= v0.2 批二：记忆状态（取代/沉默/体检） =================

/**
 * 同义词表（10-13 检索体检发现中文 bigram 盲区：头疼≠头痛，bigram 不交）。
 * 查询词命中表内任一侧，检索自动扩展到另一侧（双向）。只收强等价对——
 * 近义/上下位（生病 vs 感冒）不收，防泛化噪音。增量维护：遇到真实漏检再加。
 */
export const SYNONYMS = [
  ["头疼", "头痛"],
];

/** 查询扩展：返回 keywords + 表内同义变体（去重，保持原词优先）。 */
export function expandSynonyms(keywords) {
  const out = [...keywords];
  for (const kw of keywords) {
    for (const [a, b] of SYNONYMS) {
      const variant = kw.includes(a) ? kw.replace(a, b) : kw.includes(b) ? kw.replace(b, a) : null;
      if (variant && !out.includes(variant)) out.push(variant);
    }
  }
  return out;
}

/**
 * 解析 md 头部 YAML frontmatter 的零依赖子集：key: value 与 key: [a, b] 数组。
 * frontmatter 必须以 --- 起始行开始、--- 独占行闭合；不闭合按无 frontmatter 处理。
 * 不支持的复杂 YAML（嵌套/多行字符串）一律忽略该行。
 */
export function parseFrontmatter(md) {
  const fm = new Map();
  const text = md.charCodeAt(0) === 0xfeff ? md.slice(1) : md;
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return fm;
  const close = lines.indexOf("---", 1);
  if (close === -1) return fm; // 未闭合：整体按正文处理，不部分解析
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, raw] = m;
    const val = raw.trim();
    const arr = val.match(/^\[(.*)\]$/);
    if (arr) {
      const items = arr[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      fm.set(key, items);
    } else if (val) {
      fm.set(key, val.replace(/^["']|["']$/g, ""));
    }
  }
  return fm;
}

/**
 * ⑦ 沉默判定。suppress 大小写不敏感；suppress_when 是「查询含该词」
 * （关键词等于或包含敏感词），不是关键词数组的精确成员判断。
 */
export function isSuppressed(fm, query = []) {
  const f = fm || new Map();
  if (String(f.get("suppress") ?? "").toLowerCase() === "true") return true;
  const when = f.get("suppress_when");
  if (!Array.isArray(when) || when.length === 0) return false;
  const q = query.map(s => String(s).toLowerCase()).filter(Boolean);
  return when.some(w => {
    const needle = String(w).trim().toLowerCase();
    return needle.length > 0 && q.some(item => item.includes(needle));
  });
}

/**
 * 记忆状态应用（⑥取代 + ⑦沉默）——"取代而非删除，沉默而非抹除"。
 *
 * docs: [{rel, root?, score, fm, ...}]（就地降权）；opts.query: 关键词数组（suppress_when 用）
 * 返回 { kept: 保留并可能已降权的条目, notes: Map<memoryKey, 附注文案> }
 */
export function applyMemoryState(docs, opts = {}) {
  const query = opts.query || [];
  const notes = new Map();
  const kept = [];
  for (const d of docs) {
    const fm = d.fm || new Map();
    if (isSuppressed(fm, query)) continue;
    // ⑥ 取代标记：降权 ×0.5，不消失，附注指向取代者。坏链是否展示由调用方按语料核对。
    const sup = fm.get("superseded_by");
    if (typeof sup === "string" && sup) {
      d.score *= 0.5;
      notes.set(memoryKey(d), `此条已被取代，见 ${sup}`);
    }
    kept.push(d);
  }
  return { kept, notes };
}

/**
 * ⑧ doctor 体检——纯规则无 LLM；报告供人工深度清理，检索层另自动应用安全降噪。
 * docs: [{rel, title, fm, tokens: Set, root?, content?}] → 报告数组 [{type, file, detail}]
 * 多个 root 时 file（以及近重复对照名）带上根目录；近重复只在同一个根内比较。
 * content 可选：正文有 YYYY-MM-DD 但没有合法 date 字段时给 missing_date，不改原文。
 */
export function doctor(docs) {
  const report = [];
  const relsByRoot = new Map();
  const roots = new Set();
  for (const d of docs) {
    const root = d.root ?? "";
    if (d.root) roots.add(d.root);
    if (!relsByRoot.has(root)) relsByRoot.set(root, new Set());
    relsByRoot.get(root).add(d.rel);
  }
  const multi = roots.size > 1;
  const label = d => (multi ? joinRoot(d.root, d.rel) : d.rel);
  for (const d of docs) {
    const fm = d.fm || new Map();
    const sup = fm.get("superseded_by");
    const rels = relsByRoot.get(d.root ?? "");
    if (typeof sup === "string" && sup && !rels.has(sup)) {
      report.push({ type: "broken_link", file: label(d), detail: `superseded_by 指向的 ${sup} 不存在` });
    }
    if (!d.title || d.title.length > 40) {
      report.push({ type: "title_quality", file: label(d), detail: d.title ? `标题超长(${d.title.length}字)——路标式注入质量受损` : "无标题" });
    }
    if (String(fm.get("suppress") ?? "").toLowerCase() === "true") {
      report.push({ type: "suppressed_list", file: label(d), detail: "此篇整篇沉默中——请定期人工复核是否解禁" });
    }
    const rawDate = fm.get("date");
    const validDate = parseMemoryDate(typeof rawDate === "string" ? rawDate : undefined);
    if (!validDate && fm.has("date")) {
      report.push({ type: "missing_date", file: label(d), detail: "date 字段不是 YYYY-MM-DD，已退回文件修改时间" });
    } else if (!validDate && bodyHasCalendarDate(d.content)) {
      report.push({ type: "missing_date", file: label(d), detail: "正文里有日期，但没有 date 字段" });
    }
  }
  // 近重复检测：两两 token 重合度 ≥ 0.75（与检索降噪同一公式）。只比同一个根。
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      if ((docs[i].root ?? "") !== (docs[j].root ?? "")) continue;
      const ratio = overlapRatio(docs[i].tokens, docs[j].tokens);
      if (ratio >= 0.75) {
        report.push({
          type: "near_duplicate",
          file: label(docs[i]),
          detail: `与 ${label(docs[j])} 高度重合(${Math.round(ratio * 100)}%)——考虑合并或 superseded_by`,
        });
      }
    }
  }
  return report;
}

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

/** 时间先验：tier=常态（30 天内 1.25 / 90 天内 1.1）；timeMode=查询含时间词时加大（1.6/1.3） */
export function timeBoost(mtimeMs, nowMs, timeMode) {
  const days = (nowMs - mtimeMs) / 86400000;
  if (timeMode) return days <= 30 ? 1.6 : days <= 90 ? 1.3 : 1.0;
  return days <= 30 ? 1.25 : days <= 90 ? 1.1 : 1.0;
}

/** 时间词检测：查询含时间词 → 切时间优先模式 */
export function hasTimeWord(s) {
  return /(最近|上周|上个月|上月|去年|今年|今天|昨天|前天|以前|之前|早期|当初|前几天|近来)/i.test(s);
}

/**
 * see-also 建链：两两 bigram 集合重合度（|A∩B| / min(|A|,|B|)）≥ threshold 的记为邻居，
 * 每篇最多 maxLinks 个。返回 links[i] = [[j, sim], ...]。
 */
export function buildLinks(sets, threshold = 0.14, maxLinks = 3) {
  const n = sets.length;
  const links = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let inter = 0;
      const [a, b] = sets[i].size <= sets[j].size ? [sets[i], sets[j]] : [sets[j], sets[i]];
      for (const t of a) if (b.has(t)) inter++;
      const sim = inter / Math.min(sets[i].size, sets[j].size);
      if (sim >= threshold) { links[i].push([j, sim]); links[j].push([i, sim]); }
    }
  }
  for (const l of links) { l.sort((x, y) => y[1] - x[1]); l.length = Math.min(l.length, maxLinks); }
  return links;
}

/** 联想扩散：命中分数沿链分发 shareRatio，跑 rounds 轮（HippoRAG PPR 的降维版） */
export function spread(scores, links, shareRatio = 0.5, rounds = 2) {
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

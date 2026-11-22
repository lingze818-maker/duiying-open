/**
 * adapters/sync.mjs — 通用公司适配的拉取同步。
 *
 * 适配器只提供 list / fetch / toNote。sync 把笔记写进调用方指定的授权根，
 * 不回写公司源。引擎不参与这次写入；写完之后该根就是普通语料根。
 */
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../engine/lib.mjs";
import { refreshIndexIfPresent } from "../engine/candidate-recall.mjs";
import { INDEX_DIR_NAME } from "../engine/scan.mjs";

export const STATE_FILENAME = ".duiying-company-sync.json";

function assertId(id) {
  const s = String(id ?? "").trim();
  if (!s || /[\r\n]/.test(s) || s.includes("/") || s.includes("\\")) {
    throw new Error("条目 id 无效");
  }
  return s;
}

export function parseStamp(value, label = "updated") {
  const s = String(value ?? "").trim();
  if (!s) throw new Error(`缺少 ${label}`);
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new Error(`无法解析 ${label}：${s}`);
  return ms;
}

/** 单行 YAML 标量。时间戳里的冒号可以裸写；其余可疑字符加引号。 */
export function yamlScalar(value) {
  const s = String(value ?? "").replace(/[\r\n]+/g, " ").trim();
  if (
    s === ""
    || /[:#\[\]{}&*!|>'"%@`,]/.test(s)
    || /^\s|\s$/.test(s)
    || /^(true|false|null|~|yes|no)$/i.test(s)
  ) {
    return JSON.stringify(s);
  }
  return s;
}

function normalizeDate(value, updated) {
  const raw = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const fromUpdated = String(updated ?? "").trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromUpdated)) return fromUpdated;
  throw new Error("toNote 需要 date: YYYY-MM-DD（或可从 updated 取到日历日）");
}

/**
 * 相对路径，必须落在授权根里面，并且是 .md。
 * 拒绝绝对路径、盘符和 .. 。
 */
export function safeRel(rel) {
  const raw = String(rel ?? "").trim();
  if (!raw || /[\r\n]/.test(raw)) throw new Error("笔记相对路径为空");
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
    throw new Error(`拒绝绝对路径：${raw}`);
  }
  const norm = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = norm.split("/");
  if (parts.some(seg => seg === "" || seg === "." || seg === "..")) {
    throw new Error(`拒绝写出授权根：${raw}`);
  }
  if (!norm.endsWith(".md")) throw new Error(`只写入 Markdown：${raw}`);
  return norm;
}

function assertInside(root, dest) {
  const rel = path.relative(path.resolve(root), path.resolve(dest));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("拒绝写出授权根");
  }
}

function slugFile(id) {
  const s = String(id)
    .trim()
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const base = s || "note";
  return base.endsWith(".md") ? base : `${base}.md`;
}

function yamlList(items) {
  const parts = [];
  for (const item of items) {
    const s = String(item ?? "").trim();
    if (!s || /[\r\n,]/.test(s)) throw new Error("suppress_when 的每一项都不能含逗号或换行");
    parts.push(yamlScalar(s));
  }
  return `[${parts.join(", ")}]`;
}

/**
 * 把 toNote 的结构化结果写成引擎已经认识的 Markdown。
 * source_id / source_updated 只为了下次增量对上同一篇，检索不解释这两个键。
 */
export function renderNote(note, item = {}) {
  const title = String(note?.title ?? item.title ?? "").replace(/[\r\n]+/g, " ").trim();
  if (!title) throw new Error("toNote 缺少标题");
  const updated = String(item.updated ?? note?.source_updated ?? "").trim();
  const date = normalizeDate(note?.date ?? item.date, updated);
  const id = assertId(item.id ?? note?.source_id);
  let body = String(note?.body ?? item.body ?? "").replace(/^\uFEFF/, "").trim();
  if (!body.startsWith("#")) body = `# ${title}\n\n${body}`.trim();

  const lines = [
    "---",
    `title: ${yamlScalar(title)}`,
    `date: ${date}`,
    `source_id: ${yamlScalar(id)}`,
  ];
  if (updated) lines.push(`source_updated: ${yamlScalar(updated)}`);
  const superseded = note?.superseded_by ?? item.superseded_by;
  if (superseded != null && String(superseded).trim()) {
    const pointer = String(superseded).replace(/[\r\n]+/g, " ").trim();
    lines.push(`superseded_by: ${yamlScalar(pointer)}`);
  }
  const suppress = note?.suppress ?? item.suppress;
  if (suppress === true || String(suppress).toLowerCase() === "true") lines.push("suppress: true");
  const when = note?.suppress_when ?? item.suppress_when;
  if (Array.isArray(when) && when.length) lines.push(`suppress_when: ${yamlList(when)}`);
  lines.push("---", "", body, "");
  return lines.join("\n");
}

function ensureProvenance(markdown, item) {
  const id = assertId(item.id);
  const updated = String(item.updated ?? "").trim();
  const text = String(markdown ?? "").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);
  const idLine = `source_id: ${yamlScalar(id)}`;
  const updLine = updated ? `source_updated: ${yamlScalar(updated)}` : "";
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close !== -1) {
      const head = lines.slice(1, close);
      if (!head.some(l => /^source_id:/.test(l))) head.push(idLine);
      if (updLine && !head.some(l => /^source_updated:/.test(l))) head.push(updLine);
      return `${["---", ...head, "---", ...lines.slice(close + 1)].join("\n").replace(/\s*$/, "")}\n`;
    }
  }
  const head = ["---", idLine];
  if (updLine) head.push(updLine);
  head.push("---", "", text.replace(/\s*$/, ""), "");
  return head.join("\n");
}

function materialize(note, item) {
  if (typeof note === "string") {
    return { markdown: ensureProvenance(note, item), rel: null };
  }
  if (!note || typeof note !== "object") throw new Error("toNote 必须返回笔记对象或 Markdown 字符串");
  return {
    markdown: renderNote(note, item),
    rel: note.rel ? safeRel(note.rel) : null,
  };
}

function readState(file) {
  if (!fs.existsSync(file)) return { adapter: "", cursor: "", items: {} };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("同步状态不是合法 JSON，未继续写入"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("同步状态格式不对，未继续写入");
  }
  const items = parsed.items && typeof parsed.items === "object" && !Array.isArray(parsed.items)
    ? parsed.items
    : {};
  return {
    adapter: typeof parsed.adapter === "string" ? parsed.adapter : "",
    cursor: typeof parsed.cursor === "string" ? parsed.cursor : "",
    items,
  };
}

function findRelBySourceId(root, id) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === STATE_FILENAME) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === INDEX_DIR_NAME) continue;
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      let text;
      try { text = fs.readFileSync(full, "utf8"); } catch { continue; }
      if (parseFrontmatter(text).get("source_id") !== id) continue;
      const rel = path.relative(root, full).split(path.sep).join("/");
      try { return safeRel(rel); } catch { /* 状态外的奇怪路径不当作同一篇 */ }
    }
  }
  return null;
}

function storedRel(root, state, id) {
  const prev = state.items[id];
  if (prev && typeof prev.rel === "string") {
    try {
      const rel = safeRel(prev.rel);
      if (fs.existsSync(path.join(root, rel))) return rel;
    } catch { /* 坏记录改走正文里的 source_id */ }
  }
  return findRelBySourceId(root, id);
}

function fileUpdated(root, rel) {
  try {
    return parseFrontmatter(fs.readFileSync(path.join(root, rel), "utf8")).get("source_updated") || "";
  } catch {
    return "";
  }
}

/**
 * 增量拉进 root。since 是本次水位（不含等于）；缺省用水位文件里的 cursor。
 * 同一 id 覆盖同一相对路径。不删除本地已有笔记，也不写 root 以外的位置。
 */
export async function syncIntoRoot(adapter, { root, since } = {}) {
  const rootArg = root == null ? "" : String(root).trim();
  if (!rootArg) throw new Error("root 不能为空");
  const rootAbs = path.resolve(rootArg);
  fs.mkdirSync(rootAbs, { recursive: true });
  const stateFile = path.join(rootAbs, STATE_FILENAME);
  const state = readState(stateFile);
  const adapterId = String(adapter?.id || "company");
  if (state.adapter && state.adapter !== adapterId) {
    throw new Error(`该根已由适配器 ${state.adapter} 同步，拒绝改用 ${adapterId}`);
  }

  const explicit = since != null && String(since).trim() !== "";
  const bound = explicit ? parseStamp(since, "since") : (state.cursor ? parseStamp(state.cursor, "cursor") : null);
  const listed = await adapter.list();
  if (!Array.isArray(listed)) throw new Error("list() 必须返回数组");

  const written = [];
  const skipped = [];
  let cursorMs = state.cursor ? parseStamp(state.cursor, "cursor") : null;

  for (const meta of listed) {
    const id = assertId(meta?.id);
    const updated = String(meta?.updated ?? "").trim();
    const updatedMs = parseStamp(updated);
    if (bound != null && updatedMs <= bound) {
      skipped.push(id);
      continue;
    }
    const prevRel = storedRel(rootAbs, state, id);
    const prev = state.items[id];
    const unchanged = prevRel
      && fs.existsSync(path.join(rootAbs, prevRel))
      && (prev?.updated === updated || fileUpdated(rootAbs, prevRel) === updated);
    if (unchanged) {
      state.items[id] = { rel: prevRel, updated };
      skipped.push(id);
      if (cursorMs == null || updatedMs > cursorMs) cursorMs = updatedMs;
      continue;
    }
    const item = await adapter.fetch(id);
    if (!item || typeof item !== "object") throw new Error(`fetch(${id}) 没有返回条目`);
    if (assertId(item.id ?? id) !== id) throw new Error(`fetch(${id}) 返回了别的 id`);
    const fetched = { ...meta, ...item, id, updated: String(item.updated ?? updated).trim() };
    const note = await adapter.toNote(fetched);
    const made = materialize(note, fetched);
    const rel = prevRel || made.rel || (fetched.path ? safeRel(fetched.path) : null) || slugFile(id);
    const dest = path.join(rootAbs, rel);
    assertInside(rootAbs, dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const markdown = made.markdown.endsWith("\n") ? made.markdown : `${made.markdown}\n`;
    fs.writeFileSync(dest, markdown, "utf8");
    state.items[id] = { rel, updated: fetched.updated };
    written.push({ id, rel });
    if (cursorMs == null || updatedMs > cursorMs) cursorMs = updatedMs;
  }

  state.adapter = adapterId;
  state.cursor = cursorMs == null ? (state.cursor || "") : new Date(cursorMs).toISOString();
  const payload = {
    adapter: state.adapter,
    direction: "pull",
    cursor: state.cursor,
    items: state.items,
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try { refreshIndexIfPresent(rootAbs); } catch { /* 同步本身已经落盘；索引坏了检索会退回全量扫描 */ }
  return {
    adapter: adapterId,
    direction: "pull",
    root: rootAbs.split(path.sep).join("/"),
    written,
    skipped,
    cursor: state.cursor,
  };
}

/**
 * 补上默认的 pull sync。已经自带 sync 的对象原样返回（专精实现可以替换写入方式，
 * 默认实现仍然只往 root 里拉）。
 */
export function defineAdapter(impl) {
  if (typeof impl?.list !== "function" || typeof impl?.fetch !== "function" || typeof impl?.toNote !== "function") {
    throw new Error("适配器必须实现 list、fetch、toNote");
  }
  if (typeof impl.sync === "function") return impl;
  const adapter = {
    id: impl.id || "company",
    list: (...args) => impl.list(...args),
    fetch: (...args) => impl.fetch(...args),
    toNote: (...args) => impl.toNote(...args),
  };
  adapter.sync = opts => syncIntoRoot(adapter, opts);
  return adapter;
}

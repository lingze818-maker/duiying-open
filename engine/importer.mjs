/**
 * importer.mjs — 文档批量导入器（企业记忆库线，M1 后继）
 *
 * 定位：**格式转换器，不是新存储路径**——把客户存量文档（Word/Excel/Markdown/文本）
 * 统一转成对影记忆文件（md + frontmatter）写进记忆根，之后所有现有能力
 * （词面检索、向量检索、时间先验、门控、doctor）自动生效。架构不分裂。
 *
 * 格式支持与零依赖哲学一致：
 *   .md / .txt   原生支持（零依赖）
 *   .docx        可选依赖 mammoth（未装则该文件跳过并记录原因，指路安装命令）
 *   .xlsx / .xls 可选依赖 xlsx（同上）
 *
 * 切块策略：长文档按二级结构切块——markdown 按标题、纯文本按空行段落聚合
 * 至约 CHUNK_CHARS（默认 500），每块写成一个记忆文件（标题进 frontmatter title，
 * 源文件名与块序进 frontmatter source，时间取源文件 mtime）。
 * 单块阈值内的短文档整篇导入，不切块。
 */
import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { canWrite } from "./authz.mjs";

export const CHUNK_CHARS = 500;
const MD_LIKE = new Set([".md", ".markdown", ".txt"]);
const DOCX_LIKE = new Set([".docx"]);
const XLSX_LIKE = new Set([".xlsx", ".xls"]);

/** 递归扫描目录，返回 { path, ext, mtime } 列表（跳过隐藏目录与 node_modules）。 */
export function scanDocs(sourceDir) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      const ext = extname(name).toLowerCase();
      if (MD_LIKE.has(ext) || DOCX_LIKE.has(ext) || XLSX_LIKE.has(ext)) {
        out.push({ path: full, ext, mtime: st.mtimeMs, size: st.size });
      }
    }
  };
  walk(sourceDir);
  return out;
}

/** docx → 纯文本。mammoth 是可选依赖，未装抛可行动错误。 */
export async function docxToText(path) {
  let mammoth;
  try {
    mammoth = await import("mammoth");
  } catch {
    throw new Error(`importer: 解析 ${basename(path)} 需要 Word 支持——npm i mammoth（可选依赖，不装则 .docx 被跳过）`);
  }
  const { value } = await mammoth.extractRawText({ path });
  return value;
}

/** xlsx → 纯文本（每个 sheet 一段：表名 + 逐行 TSV）。xlsx 是可选依赖。 */
export async function xlsxToText(path) {
  let XLSX;
  try {
    XLSX = await import("xlsx");
  } catch {
    throw new Error(`importer: 解析 ${basename(path)} 需要 Excel 支持——npm i xlsx（可选依赖，不装则 .xlsx/.xls 被跳过）`);
  }
  const wb = XLSX.readFile(path);
  const parts = [];
  for (const name of wb.SheetNames) {
    parts.push(`## ${name}`);
    const rows = XLSX.utils.sheet_to_csv(wb.Sheets[name]).split("\n");
    parts.push(...rows.filter(r => r.trim()));
  }
  return parts.join("\n");
}

/** 读任意支持格式为纯文本。返回 { text, ext } 或 null（不支持的扩展名）。 */
export async function readDoc(entry) {
  if (MD_LIKE.has(entry.ext)) return { text: readFileSync(entry.path, "utf8"), ext: entry.ext };
  if (entry.ext === ".docx") return { text: await docxToText(entry.path), ext: entry.ext };
  if (XLSX_LIKE.has(entry.ext)) return { text: await xlsxToText(entry.path), ext: entry.ext };
  return null;
}

/**
 * 切块：markdown 按标题行切；纯文本按空行段落聚合到 CHUNK_CHARS 上限。
 * 返回 [{ title, body }]。单块阈值内的短文本返回单块（标题取首个 # 行或文件名）。
 */
export function chunkText(text, fallbackTitle, chunkChars = CHUNK_CHARS) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const mdTitle = lines.find(l => l.startsWith("# "))?.replace(/^#\s+/, "").trim();
  const isMarkdown = lines.some(l => /^#{1,6}\s/.test(l));

  if (!isMarkdown) {
    // 纯文本：空行分段，段落聚合到 chunkChars
    const paras = [];
    let buf = [];
    const flush = () => { if (buf.join("\n").trim()) paras.push(buf.join("\n").trim()); buf = []; };
    for (const line of lines) {
      if (!line.trim()) flush();
      else {
        buf.push(line);
        if (buf.join("\n").length >= chunkChars) flush();
      }
    }
    flush();
    if (paras.length <= 1) return [{ title: fallbackTitle, body: paras[0] ?? "" }];
    return paras.map((body, i) => ({ title: `${fallbackTitle} · ${i + 1}`, body }));
  }

  // markdown：按标题切块，长块再按 chunkChars 段落聚合拆分
  const sections = [];
  let cur = { title: mdTitle ?? fallbackTitle, lines: [] };
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      if (cur.lines.join("\n").trim()) sections.push({ ...cur });
      const level = m[1].length;
      cur = { title: level <= 2 ? m[2].trim() : `${cur.title} / ${m[2].trim()}`.slice(0, 80), lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.lines.join("\n").trim()) sections.push(cur);
  // 长节再拆
  const out = [];
  for (const sec of sections) {
    const body = sec.lines.join("\n").trim();
    if (body.length <= chunkChars) { out.push({ title: sec.title, body }); continue; }
    const paras = body.split(/\n\s*\n/);
    let acc = [];
    for (const p of paras) {
      if (acc.join("\n\n").length + p.length > chunkChars && acc.length) {
        out.push({ title: accTitle(sec.title, out.length), body: acc.join("\n\n") });
        acc = [];
      }
      acc.push(p);
    }
    if (acc.join("\n\n").trim()) out.push({ title: accTitle(sec.title, out.length), body: acc.join("\n\n") });
  }
  return out.length ? out : [{ title: fallbackTitle, body: text.trim() }];
}
const accTitle = (title, i) => `${title}（续 ${i + 1}）`;

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "doc";
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 批量导入：sourceDir 下所有支持文档 → 切块 → 写成记忆 md 到 memoryRoot。
 * @param {object} opts
 *   subdir:      写入记忆根下的子目录（默认写根；企业分库时传库名对应目录）
 *   chunkChars:  切块上限（默认 500）
 *   authz:       { user, libName, config } 提供时做写权限校验——canWrite 不过则整体拒绝（默认拒绝），
 *                并通过 opts.onDenied 回调（或抛错）告知。审计由调用方经 AuditLog 记录。
 * @returns {imported, chunks, skipped: [{path, reason}]}
 *   imported = 成功转换的源文档数；chunks = 写出的记忆文件数。
 */
export async function importTo(memoryRoot, sourceDir, opts = {}) {
  const az = opts.authz;
  if (az && !canWrite(az.user, az.libName, az.config)) {
    throw new Error(`importer: 用户 ${az.user} 无库 ${az.libName} 的写权限（默认拒绝）`);
  }
  const entries = scanDocs(sourceDir);
  const skipped = [];
  let imported = 0, chunks = 0;
  const importRoot = opts.subdir ? join(memoryRoot, opts.subdir) : memoryRoot;
  mkdirSync(importRoot, { recursive: true });
  for (const entry of entries) {
    let text;
    try {
      const r = await readDoc(entry);
      if (!r) { skipped.push({ path: entry.path, reason: "不支持的格式" }); continue; }
      text = r.text;
    } catch (error) {
      skipped.push({ path: entry.path, reason: error.message });
      continue;
    }
    if (!text.trim()) { skipped.push({ path: entry.path, reason: "空文档" }); continue; }
    const fallbackTitle = basename(entry.path, extname(entry.path));
    const blocks = chunkText(text, fallbackTitle, opts.chunkChars);
    const date = isoDate(entry.mtime);
    const rel = relative(sourceDir, entry.path);
    const stem = safeName(rel.replace(extname(entry.path), ""));
    blocks.forEach((block, i) => {
      const name = blocks.length > 1 ? `${stem}--${String(i + 1).padStart(2, "0")}.md` : `${stem}.md`;
      const fm = [
        "---",
        `title: ${JSON.stringify(block.title)}`,
        `date: ${JSON.stringify(`${date} (导入自 ${rel}${blocks.length > 1 ? ` #${i + 1}` : ""})`)}`,
        "---",
        "",
      ].join("\n");
      writeFileSync(join(importRoot, name), fm + block.body + "\n", "utf8");
      chunks += 1;
    });
    imported += 1;
  }
  return { imported, chunks, skipped };
}

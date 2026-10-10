#!/usr/bin/env node
/**
 * audit.mjs — 开源脱敏验收（16-17 号验收门的自动化执行件）
 *
 * 扫描本仓库全部待发布文件，命中任一禁忌模式即报错退出（CI 可挂）。
 * 用法：node scripts/audit.mjs   （退出码 0=干净 1=有命中）
 */
import fs from "node:fs";
import path from "node:path";

const SKIP = new Set(["node_modules", ".git", ".venv"]);
const SCAN_EXT = new Set([".md", ".mjs", ".json", ".html", ".css"]);

// 禁忌模式：任何命中都说明私有内容泄漏进了公开仓
const FORBIDDEN = [
  // 人名/身份（私有版角色与关系）
  [/那刻夏/i, "私有角色名「那刻夏」"],
  [/灵泽/i, "私有角色名「灵泽」"],
  [/anaxagoras/i, "私有角色英文名"],
  [/anaxa/i, "私有角色名变体"],
  [/天青/i, "私有角色名「天青」"],
  // 联系方式
  [/3442802943@qq\.com/, "私有邮箱"],
  [/anaxagoras0519@agent\.qq\.com/, "私有发信账号"],
  [/skema720@/, "私有邮箱"],
  // 本机路径/基础设施
  [/D:[\\/]+Users[\\/]+那刻夏zcode/i, "本机绝对路径"],
  [/C:[\\/]+Users[\\/]+15657/i, "本机用户目录"],
  [/127\.0\.0\.1:87\d\d/, "内网端口细节(如需示例请用占位符)"],
  // 私有项目内部引用
  [/duiying-work/, "私有快照目录名"],
  [/packupandgo|提桶跑路/, "私有工程代号"],
  [/socks5h:\/\/127\.0\.0\.1/, "私有代理配置"],
  [/git credential fill/, "私有凭据获取方式"],
];

const hits = [];
function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) yield* walk(p); }
    else if (SCAN_EXT.has(path.extname(e.name))) yield p;
  }
}

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
for (const file of walk(repoRoot)) {
  if (path.basename(file) === "audit.mjs") continue; // 本脚本自身含禁忌模式样本
  let content;
  try { content = fs.readFileSync(file, "utf8"); } catch { continue; }
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const [re, label] of FORBIDDEN) {
      if (re.test(lines[i])) {
        hits.push({ file: path.relative(repoRoot, file), line: i + 1, label, text: lines[i].trim().slice(0, 60) });
      }
    }
  }
}

if (hits.length) {
  console.error(`[audit] ✖ 发现 ${hits.length} 处脱敏违规：\n`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.label}\n    ${h.text}`);
  console.error(`\n修复后再发布。`);
  process.exit(1);
} else {
  console.log(`[audit] ✔ 全仓脱敏验收通过（${FORBIDDEN.length} 类禁忌模式 × 全部文件，零命中）`);
}

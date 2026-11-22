#!/usr/bin/env node
/**
 * hooks/company-sync.mjs — 把公司文档拉进一个授权根。
 *
 * 给定时任务、CI，或上浮钩子的可选前置步骤调用。默认只拉取，不回写公司系统。
 * 适配器由配置加载（内置 fixture 或 directory，或本地模块路径），不必改 engine/。
 *
 * stdin JSON（可缺省）覆盖同名环境变量：
 *   {"adapter":"fixture","root":"/path/to/memory","since":"2026-04-01T00:00:00.000Z","source":"/path/to/company-source"}
 * 环境变量：DUIYING_COMPANY_ADAPTER、DUIYING_COMPANY_ROOT、DUIYING_COMPANY_SINCE、DUIYING_COMPANY_SOURCE。
 * 失败默认 stderr 一行并 exit 0，不阻塞对话。DUIYING_COMPANY_SYNC_STRICT=1 时改为 exit 1。
 * 水位存在授权根的 .duiying-company-sync.json。since 缺省时用这份水位做增量。
 */
import { flagEnabled } from "../engine/lib.mjs";
import { loadAdapter } from "../adapters/load.mjs";

function configFrom(env, overlay) {
  const cfg = {
    adapter: env.DUIYING_COMPANY_ADAPTER || "",
    root: env.DUIYING_COMPANY_ROOT || "",
    since: env.DUIYING_COMPANY_SINCE || undefined,
    source: env.DUIYING_COMPANY_SOURCE || undefined,
    strict: flagEnabled(env.DUIYING_COMPANY_SYNC_STRICT, false),
    options: {},
  };
  if (overlay && typeof overlay === "object" && !Array.isArray(overlay)) {
    if (overlay.adapter != null && String(overlay.adapter).trim() !== "") cfg.adapter = String(overlay.adapter);
    if (overlay.root != null && String(overlay.root).trim() !== "") cfg.root = String(overlay.root);
    if (overlay.since != null && String(overlay.since).trim() !== "") cfg.since = String(overlay.since);
    if (overlay.source != null && String(overlay.source).trim() !== "") cfg.source = String(overlay.source);
    if (typeof overlay.strict === "boolean") cfg.strict = overlay.strict;
    else if (overlay.strict != null) cfg.strict = flagEnabled(String(overlay.strict), cfg.strict);
    if (overlay.options && typeof overlay.options === "object" && !Array.isArray(overlay.options)) {
      cfg.options = overlay.options;
    }
  }
  return cfg;
}

export function companySyncConfigFromEnv(env = process.env) {
  return configFrom(env, null);
}

/** 供上浮钩子调用：只看环境变量，不读 stdin（stdin 是用户消息）。 */
export function runCompanySyncFromEnv() {
  return runCompanySync(companySyncConfigFromEnv());
}

export async function runCompanySync(config = {}) {
  const adapter = await loadAdapter(config.adapter, {
    ...(config.options || {}),
    ...(config.source ? { source: config.source } : {}),
  });
  const since = config.since != null && String(config.since).trim() !== "" ? String(config.since).trim() : undefined;
  return adapter.sync({ root: config.root, since });
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  return await new Promise(resolve => {
    let buf = "";
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      resolve(value);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { buf += chunk; });
    process.stdin.on("end", () => finish(buf));
    process.stdin.on("error", () => finish(buf));
    setTimeout(() => finish(buf), 1500);
  });
}

async function main() {
  let strict = flagEnabled(process.env.DUIYING_COMPANY_SYNC_STRICT, false);
  try {
    const raw = await readStdin();
    let overlay = null;
    if (raw.trim()) overlay = JSON.parse(raw);
    const cfg = configFrom(process.env, overlay);
    strict = cfg.strict;
    const result = await runCompanySync(cfg);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(`company-sync: ${msg}\n`);
    if (strict) process.exitCode = 1;
  }
}

const invoked = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("hooks/company-sync.mjs");
if (invoked) {
  main().then(
    () => process.exit(process.exitCode || 0),
    () => process.exit(0),
  );
}

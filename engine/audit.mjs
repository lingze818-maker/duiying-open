/**
 * audit.mjs — 审计日志（企业记忆库线 M2）
 *
 * 体制内刚需：谁在什么时候查了什么/写了什么。JSONL 追加写，一行一条事件。
 * 只追加不读取（读取是管理员工具的事，本模块保持单一职责）。
 * 事件不含查询全文的命中内容——只记「谁、何时、动作、查了什么词、动了哪个库」，
 * 命中明细属于用户隐私，不上审计（审计是安全工具，不是监视工具）。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export class AuditLog {
  constructor(path) {
    this.path = path;
  }

  /** 追加一条事件。事件字段自由，但约定：{ at, user, action, libs?, query? }。落盘失败抛出（审计失败=操作失败）。 */
  append(event) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n";
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, line, "utf8");
    return this;
  }

  /** 语义糖：记录一次检索。query 记词不记命中——命中明细不进审计。 */
  logSearch(user, query, libs) {
    return this.append({ user, action: "search", query: String(query).slice(0, 200), libs });
  }

  /** 语义糖：记录一次写库（导入/追加）。 */
  logWrite(user, lib, detail = {}) {
    return this.append({ user, action: "write", lib, ...detail });
  }
}

/**
 * authz.mjs — 分库权限：身份 → 可读库列表 → 查前组装（企业记忆库线 M2 核心）
 *
 * 安全模型（权限讨论定稿）：
 * - **权限在检索之前，不在之后**：未授权的库根本不进 roots——不是查出来再过滤，
 *   是压根不查。泄漏面为零：引擎哪怕有 bug 也接触不到没被授权的数据。
 * - 一库一权限域；公共库（readers: ["*"]）是全员可见的默认层。
 * - 引擎零改动：服务层（API/CLI）用本模块把身份解析成库列表，再组装 roots 传给 search()。
 *
 * 配置是 JSON（零依赖一致；YAML 支持留给部署层转换）：
 * {
 *   "libs":  { "common":  { "readers": ["*"], "writers": ["admin"] },
 *              "finance": { "readers": ["group:finance"], "writers": ["group:finance-lead"] } },
 *   "users": { "zhang": { "groups": ["finance"], "libs": ["common", "finance"] },
 *              "admin": { "groups": ["admin"],  "libs": ["*"] } }
 * }
 *
 * 语义约定（两道闸）：
 * - 闸 1 显式清单：users[id].libs 列出用户应见的库（支持 "*" 通配全部）；
 * - 闸 2 库 readers：库自己的许可列表（支持 "*" / 用户 id / "group:组名"）。
 *   两道闸都过才可读——显式清单里列了但 readers 不允许的库不读，防配置笔误放权。
 * - 用户 id 不在 users 里：只剩 readers 含 "*" 的库（匿名只见公共层）。
 */
export const WILDCARD = "*";

/** 用户的主集合：用户 id 本身 + 所属组。许可列表按集合命中判定。 */
export function userPrincipals(userId, config) {
  const groups = config.users?.[userId]?.groups ?? [];
  return new Set([userId, ...groups]);
}

/** 许可列表判定：["*"] 放行一切；"group:组名" 剥前缀后命中主集合；裸 id 直接命中主集合。 */
export function allowedBy(principals, list) {
  if (!Array.isArray(list)) return false;
  return list.some(entry => {
    if (entry === WILDCARD) return true;
    if (entry.startsWith("group:")) return principals.has(entry.slice(6));
    return principals.has(entry);
  });
}

/** 闸 1：用户的显式库清单是否提及某库。规则：
 *  - 显式清单含 "*"：提及一切（管理员全库意图，跳过闸 2 readers——"*" 是明确的信任标记不是笔误）；
 *  - 显式清单列名/列组：提及该库（仍需过闸 2 readers——防笔误放权）；
 *  - 用户未登记（显式清单缺省）：仅视为提及 readers 含 "*" 的库（匿名默认只见公共层）。 */
function mentionedInExplicit(explicitLibs, libName, principals, libCfg) {
  if (explicitLibs.includes(WILDCARD)) return true;
  if (explicitLibs.length === 0) {
    return Array.isArray(libCfg?.readers) && libCfg.readers.includes(WILDCARD);
  }
  if (explicitLibs.includes(libName)) return true;
  return explicitLibs.some(l => l.startsWith("group:") && principals.has(l.slice(6)));
}

/**
 * 身份 → 可读库列表（库名数组，排序）。
 * 两道闸：显式清单提及 + 库 readers 允许（"*" 显式通配跳过闸 2）。
 * 未登记用户只剩公共层（readers 含 "*" 的库）。
 */
export function resolveUserLibs(userId, config) {
  const principals = userPrincipals(userId, config);
  const explicit = config.users?.[userId]?.libs ?? [];
  const out = [];
  for (const [name, cfg] of Object.entries(config.libs ?? {})) {
    if (!mentionedInExplicit(explicit, name, principals, cfg)) continue;
    if (!explicit.includes(WILDCARD) && !allowedBy(principals, cfg.readers)) continue;
    out.push(name);
  }
  return out.sort();
}

/** 身份 → 可读根的绝对路径列表（供 search({ roots }) 直接消费）。未映射/不存在的库静默跳过。 */
export function resolveUserRoots(userId, config, libPaths) {
  return resolveUserLibs(userId, config)
    .map(name => libPaths?.[name])
    .filter(p => typeof p === "string" && p);
}

/** 写权限判定：库 writers 允许 → true。库不存在或列表不命中 → false（默认拒绝）。 */
export function canWrite(userId, libName, config) {
  const principals = userPrincipals(userId, config);
  const cfg = config.libs?.[libName];
  return !!cfg && allowedBy(principals, cfg.writers);
}

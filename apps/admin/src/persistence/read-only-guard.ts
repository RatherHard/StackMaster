/**
 * 只读语句护栏(D-MP-5 分支 A;只读面零写的**第一重**机检)。
 *
 * 管理面数据面不复用 `apps/session-api` 任何实现(app→app 依赖会把信任域 2
 * 与信任域 4 的构建图耦合,违背独立部署与 verifier 先例,D-API-135),
 * 因此"零写"不能靠"复用一个已知只读的模块"来保证——必须由本包自己提供
 * 可机检的结构保证,共三重:
 *
 *  1. **端口面**:`AdminReadStore` 只有读取方法(写方法不存在于类型上);
 *  2. **语句面(本模块)**:每一条进入 PG 适配器的 SQL 都必须先过
 *     `assertReadOnlySql` —— 首关键字 ∈ {SELECT, WITH},且全句不得出现任何
 *     写 / DDL / 授权关键字(整词匹配)。任何一次越界即抛
 *     `ReadOnlyViolationError`(fail-closed:可疑语句不执行);
 *  3. **授权面**:管理面连接角色 `admin_ro` 在库层只有五个表的 SELECT
 *     (compose/admin-db-init.sql 的最小授权面),写面在库层确定性拒绝——
 *     与角色属性断言(非 superuser / 非 bypassrls)同批。
 *
 * 三重彼此独立:任何一重失效,另外两重仍把写面折叠为"不可达"。
 */

/** 合法只读语句首关键字(SELECT / WITH ... SELECT;CTE 亦为只读面)。 */
const READ_ONLY_LEADING_KEYWORDS: readonly string[] = ["SELECT", "WITH"];

/**
 * 禁用关键字(整词)。覆盖写面(DML)、DDL、授权面、以及会改变库状态或
 * 读取服务端文件面的语句族(`COPY` / `DO` / `CALL` / `VACUUM` / `LOCK`…)。
 * 整词匹配使 `updated_at` / `created_at` / `signer_key_id` 这类含子串的
 * 列名不被误伤(它们本就不是关键字)。
 */
const FORBIDDEN_KEYWORDS: readonly string[] = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "MERGE",
  "ALTER",
  "CREATE",
  "DROP",
  "GRANT",
  "REVOKE",
  "COPY",
  "DO",
  "CALL",
  "VACUUM",
  "ANALYZE",
  "REINDEX",
  "CLUSTER",
  "REFRESH",
  "COMMENT",
  "SECURITY",
  "LOCK",
  "SET",
  "RESET",
  "DISCARD",
  "LISTEN",
  "NOTIFY",
  "PREPARE",
  "EXECUTE",
  "DECLARE",
  "FETCH",
];

/** 只读语句违规(可疑 SQL 不执行;fail-closed)。 */
export class ReadOnlyViolationError extends Error {
  constructor(readonly reason: string) {
    super(`admin 只读面拒绝执行非只读语句:${reason}`);
    this.name = "ReadOnlyViolationError";
  }
}

/** 单行归一:折叠注释与多余空白,便于关键字整词判定。 */
function normalize(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 断言语句只读;返回归一化后的语句(调用方可直接用返回值执行,避免
 * "校验一份、执行另一份"的 TOCTOU 形态)。
 */
export function assertReadOnlySql(sql: string): string {
  const normalized = normalize(sql);
  if (normalized === "") {
    throw new ReadOnlyViolationError("语句为空");
  }
  const leading = normalized.split(" ")[0]?.toUpperCase() ?? "";
  if (!READ_ONLY_LEADING_KEYWORDS.includes(leading)) {
    throw new ReadOnlyViolationError(`首关键字 ${leading} 不在只读允许集`);
  }
  const upper = normalized.toUpperCase();
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`).test(upper)) {
      throw new ReadOnlyViolationError(`出现禁用关键字 ${keyword}`);
    }
  }
  return normalized;
}

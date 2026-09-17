/**
 * 凭证 × 租户绑定(D-MP-5 分支 A;与 O-MP-6 同源形态,D-API-134)。
 *
 * 定案形态(与 WP-78 宿主面 `SESSION_API_HOST_TENANTS` 同源):
 *  - 管理面凭证绑定**租户集合** = `ADMIN_TENANTS`(逗号分隔白名单);
 *  - 租户**只能**由「凭证绑定集合 + 查询参数在集合内子选」确定:
 *    查询参数不得决定租户,只允许在白名单内子选;任何请求体字段都不参与
 *    租户推导(6.2「不接受请求体自报身份」——本服务的路由全部是 GET,
 *    结构上不存在请求体,该约束由方法面结构性保证);
 *  - 白名单缺失或为空 ⇒ **整体 fail-closed**:所有数据查询返回 404 同形
 *    (不是 403,也不是空列表——空列表会把"没有绑定租户"与"该租户没有
 *    数据"混淆,且给枚举者提供区分信号);
 *  - 跨租户 / 不存在**同形态**:未绑定租户与"库中不存在"返回同一个 404,
 *    枚举者无法区分三种情形(未绑定 / 无数据 / 数据在别的租户)。
 */

/** 租户解析结果:命中绑定集合才是合法租户;否则整体 404 同形。 */
export type TenantResolution =
  | { readonly kind: "resolved"; readonly tenantId: string }
  | { readonly kind: "not_found" };

/** 单一解析结果常量(零差异响应面)。 */
const NOT_FOUND: TenantResolution = { kind: "not_found" };

export class AdminTenantBinding {
  readonly #tenants: readonly string[];
  readonly #bound: ReadonlySet<string>;

  constructor(tenants: readonly string[]) {
    this.#tenants = [...tenants];
    this.#bound = new Set(this.#tenants);
  }

  /** 绑定租户条数(只进指标 gauge 的**数量**,标识符不进任何标签)。 */
  get size(): number {
    return this.#tenants.length;
  }

  /** 数据面是否整体可用(白名单为空 ⇒ 整体 404 同形,fail-closed)。 */
  get effective(): boolean {
    return this.#tenants.length > 0;
  }

  isBound(tenantId: string): boolean {
    return this.#bound.has(tenantId);
  }

  /**
   * 解析本次查询的租户。
   *
   * @param requested 查询参数 `tenant`(可选)。仅在绑定集合内有效。
   *  - 白名单为空 ⇒ 恒 `not_found`(整体 fail-closed);
   *  - 未提供 + 恰绑定一个租户 ⇒ 该租户(单租户部署的零仪式形态);
   *  - 未提供 + 绑定多个租户 ⇒ `not_found`(**不**回显"必须指定"这类
   *    会泄漏白名单基数的提示;也不回退到"第一个租户"——静默选租户即
   *    静默改变查询作用域,是跨租户读的经典入口);
   *  - 提供了但不在集合内 ⇒ `not_found`(跨租户与不存在同形态,防枚举)。
   */
  resolve(requested: string | undefined): TenantResolution {
    if (!this.effective) {
      return NOT_FOUND;
    }
    if (requested === undefined || requested === "") {
      const single = this.#tenants.length === 1 ? this.#tenants[0] : undefined;
      return single === undefined ? NOT_FOUND : { kind: "resolved", tenantId: single };
    }
    if (!this.#bound.has(requested)) {
      return NOT_FOUND;
    }
    return { kind: "resolved", tenantId: requested };
  }
}

/**
 * 字段分类清单(契约的数据分类元数据;WP-2 起建,WP-3 扩充)。
 *
 * 分类唯一依据:docs/contracts/数据分类与秘密零驻留清单.md 第四、五、六章(冻结)。
 * 本清单随 JSON Schema 一并由生成管线落盘(schema/classification.json),
 * 供 CI 的字段白名单机检(ZR-P1 / I-1)直接引用——机检条目必须引用
 * 该清单与 WP-1 文档条目 ID,保持单一来源。
 *
 * 纪律:任何新增跨域字段必须先在 WP-1 文档完成分类与硬门槛论证,
 * 再回填本清单与 Schema(WP-1 §1.3 契约变更流程)。
 * 注意:rootClass 为 server-only 的根 Schema(ProjectionPolicy)是
 * "Schema 存在不等于可下发"的载体——它登记在此仅为让落盘 JSON Schema
 * 携带 x-sm-class 标签,其 Schema 不从包入口导出(见 server-only 子路径)。
 */

/** WP-1 §1.1 的三类分类标签。 */
export type SmClass = "public" | "boundary" | "server-only";

export interface SchemaClassification {
  /** 根 Schema 整体分类,写入 JSON Schema 的 x-sm-class。 */
  readonly rootClass: SmClass;
  /** 顶层字段 → 分类(WP-1 §6 信封字段分类表)。 */
  readonly fieldClasses: Readonly<Record<string, SmClass>>;
}

export const SCHEMA_CLASSIFICATIONS = {
  "action-request": {
    rootClass: "boundary",
    fieldClasses: {
      protocolVersion: "boundary",
      sessionId: "boundary",
      clientSeq: "boundary",
      baseRevision: "boundary",
      idempotencyKey: "boundary",
      action: "boundary",
    },
  },
  "action-response": {
    rootClass: "public",
    fieldClasses: {
      requestId: "public",
      revision: "public",
      status: "public",
      projectionDelta: "public",
      publicEvents: "public",
      userVisibleError: "public",
    },
  },
  "verdict-result": {
    rootClass: "public",
    fieldClasses: {},
  },
  "verdict-query-response": {
    rootClass: "public",
    fieldClasses: {
      submissionId: "public",
      revision: "public",
      status: "public",
      verdict: "public",
      decidedAt: "public",
    },
  },
  "host-scores-response": {
    // 宿主成绩同步只读接口的响应载荷(中期 M3 WP-78,D-API-122 ~ D-API-126):
    // 整体 PUBLIC —— 信封只有批量记录数组与游标两个顶层字段,逐条记录的值
    // 来源全部是公开面(11 值裁决字面 / 契约定位字段 / 落库时刻 / 游标主键),
    // 零判题明细、零租户回显(论证:WP-1 清单 §6.11)。
    rootClass: "public",
    fieldClasses: {
      items: "public",
      nextCursor: "public",
    },
  },
  "launch-ticket-request": {
    // 启动票据签发请求载荷(分发改版 WP-90,D-LT-1 ~ D-LT-3):整体 BOUNDARY
    // —— 两份载荷是**跨边界**形态(平台后端 ↔ 服务端),且内容属「集成方自报
    // 的导航参数」,服务端按其重新校验、绝不采信为授权。逐字段分类与硬门槛
    // 论证:WP-1 清单 §6.12(租户**不在**请求体 —— 只由宿主凭证 ×
    // SESSION_API_HOST_TENANTS 白名单派生,故无 tenantId 分类位)。
    rootClass: "boundary",
    fieldClasses: {
      challengeId: "boundary",
      version: "boundary",
    },
  },
  "launch-ticket-response": {
    // 启动票据签发响应载荷(分发改版 WP-90,D-LT-1 ~ D-LT-3):整体 BOUNDARY
    // —— 跨边界(服务端 → 平台后端 → 学习者浏览器),逐字段值来源 =
    // 服务端生成的绝对地址 + 服务端时钟,零判题秘密派生;票据值只在
    // launchUrl 内(不另回票据字段)、不携带 protocolVersion、不回显租户
    // (论证:WP-1 清单 §6.12)。
    rootClass: "boundary",
    fieldClasses: {
      launchUrl: "boundary",
      expiresAt: "boundary",
    },
  },
  "public-state-projection": {
    rootClass: "public",
    fieldClasses: {
      revision: "public",
      visibleRegions: "public",
      visibleRegisters: "public",
      callStackSummary: "public",
      controlFlow: "public",
      semanticHighlights: "public",
      status: "public",
    },
  },
  "projection-delta": {
    rootClass: "public",
    fieldClasses: {
      revision: "public",
      dirtyRanges: "public",
      changedRegisters: "public",
      controlFlow: "public",
      status: "public",
      callStackSummary: "public",
      semanticHighlights: "public",
    },
  },
  "public-error": {
    rootClass: "public",
    fieldClasses: {
      code: "public",
      message: "public",
      addressHex: "public",
      explanation: "public",
    },
  },
  /*
   * 「embed-message」/「embed-token-claims」分类条目已随嵌入协议面 **2026-09-19
   * 物理删除**(WP-96;D-API-153 第 5 项 / D-LT-1)。退役登记见
   * docs/contracts/数据分类与秘密零驻留清单.md §6.4 与 §6.5(v1 段)——该清单
   * **只增不改**,故退役标注留在文档侧;本清单与落盘注册表是机器消费面,
   * 不保留已无 Schema 的条目(保留会让生成管线断言「有分类无注册」失败)。
   */
  "session-command-request": {
    rootClass: "boundary",
    fieldClasses: {
      protocolVersion: "boundary",
      command: "boundary",
      payload: "boundary",
    },
  },
  "session-command-response": {
    rootClass: "public",
    fieldClasses: {
      command: "public",
      payload: "public",
    },
  },
  "session-credential-claims": {
    rootClass: "boundary",
    fieldClasses: {
      sessionId: "boundary",
      tenantId: "boundary",
      userId: "boundary",
      challengeId: "boundary",
      challengeVersion: "boundary",
      jti: "boundary",
      expiresAt: "boundary",
    },
  },
  "launch-grant-claims": {
    // 启动授权凭证 claims(分发改版 WP-90 / D-LT-5 实施细化 5a;v1.21 增补):
    // 换票产物,证明「该浏览器被授予 (tenant, challengeId, version) 的入场权」;
    // **恰六字段,无 sessionId / embedSessionId**(授权凭证 ≠ 会话凭证的结构性
    // 表达,故与 §6.6 各自独立、不做 shape 复用)。分类论证与 §6.6 同源
    // (BOUNDARY:claims 对持票方无秘密性;防伪造靠签名,防重放靠 jti 单次
    // 消费 + 过期 + 题目绑定;解析器不给浏览器)。
    rootClass: "boundary",
    fieldClasses: {
      tenantId: "boundary",
      userId: "boundary",
      challengeId: "boundary",
      challengeVersion: "boundary",
      jti: "boundary",
      expiresAt: "boundary",
    },
  },
  "wss-frame": {
    rootClass: "boundary",
    fieldClasses: {
      protocolVersion: "boundary",
      type: "boundary",
      sessionId: "boundary",
      seq: "boundary",
      requestId: "boundary",
      payload: "boundary",
    },
  },
  "debug-frame": {
    rootClass: "boundary",
    fieldClasses: {
      protocolVersion: "boundary",
      type: "boundary",
      sessionId: "boundary",
      seq: "boundary",
      requestId: "boundary",
      payload: "boundary",
    },
  },
  "debug-variant-bundle": {
    rootClass: "server-only",
    fieldClasses: {
      schemaVersion: "server-only",
      engineProcessProtocolVersion: "server-only",
      challengeId: "server-only",
      challengeContentVersion: "server-only",
      vmProfileVersion: "server-only",
      aslrEnabled: "server-only",
      derivation: "server-only",
      memoryRegions: "server-only",
      registers: "server-only",
      canarySlots: "server-only",
    },
  },
  "projection-policy": {
    rootClass: "server-only",
    fieldClasses: {
      visibleRegions: "server-only",
      visibleObjects: "server-only",
      visibleRegisters: "server-only",
      maxBytesPerRange: "server-only",
      errorDetailLevel: "server-only",
    },
  },
} as const satisfies Readonly<Record<string, SchemaClassification>>;

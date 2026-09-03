/**
 * 字段分类清单(契约的数据分类元数据;WP-2 起建,WP-3 扩充)。
 *
 * 分类唯一依据:docs/数据分类与秘密零驻留清单.md 第四、五、六章(冻结)。
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

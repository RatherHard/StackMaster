/**
 * Zod → JSON Schema 2020-12 产出管线(WP-2 建线,WP-3 扩面;计划书 5.6 / ADR-5)。
 *
 * - JSON Schema 是 TS 与 Rust 的共同权威:本脚本产出的文件提交入库,
 *   供 Rust 侧 serde + schemars 消费(WP-6 完成 Rust 消费冒烟验证);
 * - 每个根 Schema 生成一个自包含文件(reused: "inline",无任何 $ref),
 *   便于 Rust 校验器与 schemars 独立解析;
 * - 消费公开注册表 + server-only 注册表(后者产物打 x-sm-class: server-only,
 *   Schema 存在不等于可下发,WP-1 §五);
 * - 附带 schema/classification.json:字段分类清单(WP-1 §4–§6),供 CI 的
 *   ZR-P1 / I-1 机检直接引用;
 * - test/schema-drift.test.ts 断言入库文件与本管线输出一致,防止双端漂移。
 *
 * superRefine 纪律(实验结论,见任务 #1):refinement 对 z.toJSONSchema 透明,
 * 不进落盘产物——跨字段规则由本管线以等价 if/then 显式注入(见下方
 * ACTION_RESPONSE_REJECTED_COUPLING),无法表达求和 / 跨 Schema 比较的规则
 * 则由 golden fixture 的违规反例承接(语义文档 §六)。
 *
 * 运行:先 `pnpm build`,再 `pnpm --filter @stackmaster/protocol generate`。
 * 本模块依赖 node:fs,刻意不从包入口(index.ts)导出,浏览器构建图不可达。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z, type ZodType } from "zod";
import { PROTOCOL_PACKAGE_VERSION, SESSION_ACTION_PROTOCOL_VERSION } from "../version.js";
import { allSchemaEntries, assertRegistriesMatchClassifications } from "../server-only/schema-registry.js";
import { classificationOf, type SchemaName } from "./registry.js";

const SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";

/**
 * 会话动作协议 JSON Schema 的 $id 命名空间(仅作标识符,不承诺可解析)。
 * 版本段从协议版本常量派生:破坏性变更递增版本时,$id 目录随之切换
 * (语义文档 §5.2 的 v2 落新目录纪律由此机检兜底)。
 */
export const SESSION_ACTION_SCHEMA_BASE_ID = `https://stackmaster.dev/schemas/session-action/v${SESSION_ACTION_PROTOCOL_VERSION}`;

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUTPUT_DIR = join(PACKAGE_ROOT, "schema");
const MANIFEST_FILE_NAME = "classification.json";

/**
 * ActionResponse 的 rejected 跨字段耦合(WP-2 移交,WP-3 冻结):
 * status === "rejected" 时 userVisibleError 必有、projectionDelta 恒 null、
 * publicEvents 恒空(拒绝动作不产生投影与事件,且必须可解释)。
 * TS 侧等价规则在 ActionResponseSchema.superRefine;本常量是其 JSON Schema
 * 形态——两侧必须同步修改(语义文档 §六)。
 */
const ACTION_RESPONSE_REJECTED_COUPLING = {
  if: {
    properties: { status: { const: "rejected" } },
    required: ["status"],
  },
  then: {
    required: ["userVisibleError"],
    properties: {
      projectionDelta: { const: null },
      publicEvents: { maxItems: 0 },
    },
  },
} as const;

export type JsonSchemaDocument = Record<string, unknown>;

/** 生成单个根 Schema 文档(自包含,携带 $schema / $id / title / x-sm-class)。 */
export function generateSchemaDocument(
  schema: ZodType,
  entryName: SchemaName,
  title: string,
): JsonSchemaDocument {
  const generated = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
    cycles: "throw",
    reused: "inline",
  });
  return injectCrossFieldRules(
    {
      $schema: SCHEMA_DRAFT,
      $id: `${SESSION_ACTION_SCHEMA_BASE_ID}/${entryName}.schema.json`,
      title,
      "x-sm-class": classificationOf(entryName).rootClass,
      ...generated,
    },
    entryName,
  );
}

/** 注入 TS 侧 superRefine 的 JSON Schema 等价形态(当前仅 action-response 一处)。 */
function injectCrossFieldRules(
  document: JsonSchemaDocument,
  entryName: SchemaName,
): JsonSchemaDocument {
  if (entryName !== "action-response") {
    return document;
  }
  const injected: JsonSchemaDocument = structuredClone(document);
  const existing = Array.isArray(injected.allOf) ? injected.allOf : [];
  injected.allOf = [...existing, ACTION_RESPONSE_REJECTED_COUPLING];
  return injected;
}

/** 生成字段分类清单(WP-1 §4–§6 → 机检产物)。 */
export function generateManifestDocument(): JsonSchemaDocument {
  const schemas: Record<string, JsonSchemaDocument> = {};
  for (const entry of allSchemaEntries()) {
    const { rootClass, fieldClasses } = classificationOf(entry.name);
    schemas[entry.name] = {
      file: `${entry.name}.schema.json`,
      title: entry.title,
      rootClass,
      fieldClasses,
    };
  }
  return {
    packageVersion: PROTOCOL_PACKAGE_VERSION,
    sessionActionProtocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
    note:
      "字段分类唯一依据 docs/数据分类与秘密零驻留清单.md 第四、五、六章;机检消费见 ZR-P1 / I-1。" +
      "Schema 存在不等于可下发:server-only 类型仅供后端包跨语言校验消费。",
    schemas,
  };
}

/** 生成全部落盘文件(文件名 → 内容);供生成脚本与漂移测试共用。 */
export function generateAll(): Record<string, string> {
  assertRegistriesMatchClassifications();
  const files: Record<string, string> = {};
  for (const entry of allSchemaEntries()) {
    const document = generateSchemaDocument(entry.schema, entry.name, entry.title);
    files[`${entry.name}.schema.json`] = `${JSON.stringify(document, null, 2)}\n`;
  }
  files[MANIFEST_FILE_NAME] = `${JSON.stringify(generateManifestDocument(), null, 2)}\n`;
  return files;
}

function main(): void {
  const files = generateAll();
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(join(OUTPUT_DIR, fileName), content, "utf8");
  }
  process.stdout.write(`已生成 ${Object.keys(files).length} 个文件 → ${OUTPUT_DIR}\n`);
}

/* 作为脚本直接执行时落盘;被测试导入时无副作用。 */
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main();
}

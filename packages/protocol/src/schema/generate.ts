/**
 * Zod → JSON Schema 2020-12 产出管线(WP-2;计划书 5.6 / ADR-5)。
 *
 * - JSON Schema 是 TS 与 Rust 的共同权威:本脚本产出的文件提交入库,
 *   供 Rust 侧 serde + schemars 消费(WP-6 完成 Rust 消费冒烟验证);
 * - 每个根 Schema 生成一个自包含文件(reused: "inline",无任何 $ref),
 *   便于 Rust 校验器与 schemars 独立解析;
 * - 附带 schema/classification.json:字段分类清单(WP-1 §6),供 CI 的
 *   ZR-P1 / I-1 机检直接引用;
 * - test/schema-drift.test.ts 断言入库文件与本管线输出一致,防止双端漂移。
 *
 * 运行:先 `pnpm build`,再 `pnpm --filter @stackmaster/protocol generate`。
 * 本模块依赖 node:fs,刻意不从包入口(index.ts)导出,浏览器构建图不可达。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z, type ZodType } from "zod";
import { PROTOCOL_PACKAGE_VERSION, SESSION_ACTION_PROTOCOL_VERSION } from "../version.js";
import { classificationOf, SCHEMA_REGISTRY, type SchemaName } from "./registry.js";

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
 * provisional 子树标记路径(WP-2 安全评审 M-3 的机检化):载荷占位 Schema 在落盘
 * JSON Schema 中携带 `x-sm-provisional: true`,使"非冻结"声明从散文变成机检面
 * (drift 测试断言标记存在,Rust 消费方在落盘产物中即可识别临时子树);
 * WP-3 冻结这些类型时删除本表并整体替换 provisional.ts。
 * 路径相对根 Schema 的 `properties` 逐段下钻。
 */
const PROVISIONAL_FIELD_PATHS: Partial<Record<SchemaName, readonly (readonly string[])[]>> = {
  "action-response": [["projectionDelta"], ["publicEvents", "items"], ["userVisibleError"]],
};

export type JsonSchemaDocument = Record<string, unknown>;

/** 生成单个根 Schema 文档(自包含,携带 $schema / $id / title / x-sm-class / provisional 标记)。 */
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
  return markProvisionalSubtrees(
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

/** 给 provisional 子树注入 x-sm-provisional 标记;路径落空即抛错(契约结构漂移的早期信号)。 */
function markProvisionalSubtrees(
  document: JsonSchemaDocument,
  entryName: SchemaName,
): JsonSchemaDocument {
  const paths = PROVISIONAL_FIELD_PATHS[entryName];
  if (paths === undefined) {
    return document;
  }
  const marked: JsonSchemaDocument = structuredClone(document);
  const properties = marked.properties;
  if (typeof properties !== "object" || properties === null) {
    throw new Error(`Schema ${entryName} 无 properties,无法标记 provisional 子树`);
  }
  for (const path of paths) {
    let node: unknown = properties;
    for (const segment of path) {
      if (typeof node !== "object" || node === null) {
        throw new Error(`provisional 标记路径落空:${entryName} → ${path.join(".")}`);
      }
      node = (node as Record<string, unknown>)[segment];
    }
    if (typeof node !== "object" || node === null) {
      throw new Error(`provisional 标记路径落空:${entryName} → ${path.join(".")}`);
    }
    (node as Record<string, unknown>)["x-sm-provisional"] = true;
  }
  return marked;
}

/** 生成字段分类清单(WP-1 §6 → 机检产物)。 */
export function generateManifestDocument(): JsonSchemaDocument {
  const schemas: Record<string, JsonSchemaDocument> = {};
  for (const entry of SCHEMA_REGISTRY) {
    const { rootClass, fieldClasses } = classificationOf(entry.name);
    const provisionalFields = [
      ...new Set(
        (PROVISIONAL_FIELD_PATHS[entry.name] ?? [])
          .map((path) => path[0])
          .filter((name): name is string => name !== undefined),
      ),
    ];
    schemas[entry.name] = {
      file: `${entry.name}.schema.json`,
      title: entry.title,
      rootClass,
      fieldClasses,
      ...(provisionalFields.length > 0 ? { provisionalFields } : {}),
    };
  }
  return {
    packageVersion: PROTOCOL_PACKAGE_VERSION,
    sessionActionProtocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
    note:
      "字段分类唯一依据 docs/数据分类与秘密零驻留清单.md 第六章;机检消费见 ZR-P1 / I-1。" +
      "Schema 存在不等于可下发:server-only 类型仅供后端包跨语言校验消费。",
    schemas,
  };
}

/** 生成全部落盘文件(文件名 → 内容);供生成脚本与漂移测试共用。 */
export function generateAll(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of SCHEMA_REGISTRY) {
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

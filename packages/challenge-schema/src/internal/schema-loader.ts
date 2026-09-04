/**
 * Schema 装载器(内部模块,不导出):node:fs 读取 schema/*.json,
 * Ajv 2020-12 严格模式编译并缓存。
 *
 * 装载纪律(双包Schema语义.md §5.1):
 * - 重复键拒绝在 json-strict-parse 承接(XS-DUP-KEY);
 * - `x-sm-class` 为非校验标注关键字,注册后不影响校验语义;
 * - 公开面与私有面各自惰性编译:公开校验路径永不读取私有包 Schema,
 *   私有面仅经 ./server-only 子路径可达(不进浏览器构建图)。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { SchemaViolation } from "../common/validation.js";
import { parseJsonStrict } from "./json-strict-parse.js";

/** 构建产物与源码同仓库布局:src/internal 与 dist/internal 上两级均为包根。 */
const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schema");

const PUBLIC_DESCRIPTOR_SCHEMA_FILE = "public-descriptor.schema.json";
const PRIVATE_BUNDLE_SCHEMA_FILE = "private-bundle.schema.json";

function loadSchemaDocument(fileName: string): Record<string, unknown> {
  const text = readFileSync(join(SCHEMA_DIR, fileName), "utf8");
  return parseJsonStrict(text) as Record<string, unknown>;
}

function compileSchema(fileName: string): ValidateFunction {
  // ownProperties: true(R6):required / properties / additionalProperties 只看
  // 自有属性——继承属性(如 Object.prototype 上的 toString)不得满足 required,
  // 也不得被当作题目包字段;配合 json-strict-parse 的重复键拒绝构成入站防线。
  const ajv = new Ajv2020({ strict: true, allErrors: false, coerceTypes: false, ownProperties: true });
  ajv.addKeyword("x-sm-class");
  return ajv.compile(loadSchemaDocument(fileName));
}

let publicDescriptorValidator: ValidateFunction | undefined;

/** 公开描述包校验器(惰性编译;不触达私有包 Schema)。 */
export function getPublicDescriptorValidator(): ValidateFunction {
  if (publicDescriptorValidator === undefined) {
    publicDescriptorValidator = compileSchema(PUBLIC_DESCRIPTOR_SCHEMA_FILE);
  }
  return publicDescriptorValidator;
}

let privateBundleValidator: ValidateFunction | undefined;

/** 私有判题包校验器(仅 server-only 面可达)。 */
export function getPrivateBundleValidator(): ValidateFunction {
  if (privateBundleValidator === undefined) {
    privateBundleValidator = compileSchema(PRIVATE_BUNDLE_SCHEMA_FILE);
  }
  return privateBundleValidator;
}

/**
 * Ajv 错误对象 → 违规记录;附加属性违规补充具体属性名(可解释性)。
 * R7 错误粗化:回显的属性名与实例路径都截断——违规消息与路径是服务端
 * 诊断面,但仍不得成为超长恶意输入(如超长寄存器键)的回显通道。
 */
const MAX_ECHOED_PROPERTY_NAME = 80;
const MAX_ECHOED_PATH = 200;

function truncateEchoed(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…(截断)`;
}

export function toSchemaViolations(errors: readonly ErrorObject[]): SchemaViolation[] {
  return errors.map((error) => {
    const additionalProperty =
      typeof error.params === "object" && error.params !== null && "additionalProperty" in error.params
        ? String(error.params.additionalProperty)
        : undefined;
    const message =
      additionalProperty !== undefined
        ? `${error.message ?? "校验失败"}:${truncateEchoed(additionalProperty, MAX_ECHOED_PROPERTY_NAME)}`
        : (error.message ?? "校验失败");
    return { path: truncateEchoed(error.instancePath, MAX_ECHOED_PATH), message };
  });
}

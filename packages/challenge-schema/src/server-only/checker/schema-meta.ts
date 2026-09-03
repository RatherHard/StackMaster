/**
 * Schema 文档级元检查(XS-1 / D2-NO-HIDDEN-IN-PUBLIC):
 * 检查对象是两份 JSON Schema 文档本身(不是实例):
 *  - XS-1 根标记:x-sm-class 必须分别为 "public" / "server-only";
 *  - D2-NO-HIDDEN-IN-PUBLIC 公开 Schema 文档内不得声明任何私有顶层属性名
 *    (FORBIDDEN_PUBLIC_PROPERTIES),也不得携带 default / examples 示值
 *    (示例值是公开面的 secret 走私通道;7.1 / 13.2)。
 *
 * 输入是原始文本:文档先经 parseJsonStrict(重复键同样按违规记录,
 * 与 XS-DUP-KEY 扫描器同一落点),再深扫描键名。
 */

import { FORBIDDEN_PUBLIC_PROPERTIES } from "../../common/classification.js";
import { JsonStrictParseError, parseJsonStrict } from "../../internal/json-strict-parse.js";
import type { CheckerViolation } from "./types.js";

/** 深度收集 Schema 文档中 properties 对象声明的字段名(附 JSON 指针路径)。 */
function collectDeclaredPropertyNames(
  node: unknown,
  path: string,
  visit: (name: string, path: string) => void,
): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [name, subSchema] of Object.entries(value)) {
        visit(name, `${path}/properties/${name}`);
        collectDeclaredPropertyNames(subSchema, `${path}/properties/${name}`, visit);
      }
      continue;
    }
    collectDeclaredPropertyNames(value, `${path}/${key}`, visit);
  }
}

/** 深度查找对象键(default / examples 禁令用)。 */
function forEachObjectKey(node: unknown, path: string, visit: (key: string, path: string) => void): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    visit(key, `${path}/${key}`);
    if (Array.isArray(value)) {
      value.forEach((item, index) => forEachObjectKey(item, `${path}/${index}`, visit));
    } else {
      forEachObjectKey(value, `${path}/${key}`, visit);
    }
  }
}

function parseSchemaText(text: string, label: string, violations: CheckerViolation[]): unknown {
  try {
    return parseJsonStrict(text);
  } catch (error) {
    const detail = error instanceof JsonStrictParseError ? error.message : String(error);
    violations.push({
      ruleId: "XS-1",
      message: `${label} 不是合法 JSON:${detail}`,
    });
    return undefined;
  }
}

/** XS-1 + D2-NO-HIDDEN-IN-PUBLIC:双 Schema 文档元检查。 */
export function checkSchemaMeta(
  publicSchemaText: string,
  privateSchemaText: string,
): CheckerViolation[] {
  const violations: CheckerViolation[] = [];
  const publicSchema = parseSchemaText(publicSchemaText, "公开描述包 Schema", violations);
  const privateSchema = parseSchemaText(privateSchemaText, "私有判题包 Schema", violations);

  if (publicSchema !== undefined) {
    const rootClass = (publicSchema as Record<string, unknown>)["x-sm-class"];
    if (rootClass !== "public") {
      violations.push({
        ruleId: "XS-1",
        message: `公开描述包 Schema 根标记 x-sm-class 必须为 "public",实际 ${JSON.stringify(rootClass) ?? "undefined"}`,
        path: "/x-sm-class",
      });
    }
    collectDeclaredPropertyNames(publicSchema, "", (name, path) => {
      if (FORBIDDEN_PUBLIC_PROPERTIES.includes(name)) {
        violations.push({
          ruleId: "D2-NO-HIDDEN-IN-PUBLIC",
          message: `公开 Schema 声明了私有顶层属性名 "${name}"(禁止从公开包推导私有字段)`,
          path,
        });
      }
    });
    forEachObjectKey(publicSchema, "", (key, path) => {
      if (key === "default" || key === "examples") {
        violations.push({
          ruleId: "D2-NO-HIDDEN-IN-PUBLIC",
          message: `公开 Schema 不得携带 "${key}" 示值`,
          path,
        });
      }
    });
  }

  if (privateSchema !== undefined) {
    const rootClass = (privateSchema as Record<string, unknown>)["x-sm-class"];
    if (rootClass !== "server-only") {
      violations.push({
        ruleId: "XS-1",
        message: `私有判题包 Schema 根标记 x-sm-class 必须为 "server-only",实际 ${JSON.stringify(rootClass) ?? "undefined"}`,
        path: "/x-sm-class",
      });
    }
  }
  return violations;
}

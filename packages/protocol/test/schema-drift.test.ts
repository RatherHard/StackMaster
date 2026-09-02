/**
 * JSON Schema 生成产物测试:入库文件与生成管线输出一致(WP-2 纪律起点——
 * 防止 TS 契约与落盘 JSON Schema 漂移;Rust 侧消费冒烟在 WP-6 收口)。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateAll, SESSION_ACTION_SCHEMA_BASE_ID } from "../src/schema/generate.js";
import { SCHEMA_REGISTRY } from "../src/schema/registry.js";

const OUTPUT_DIR = join(import.meta.dirname, "..", "schema");
const SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";

describe("JSON Schema 生成产物(WP-2 落盘纪律)", () => {
  it("schema/ 目录文件与生成管线输出完全一致(防双端漂移)", () => {
    const onDisk = Object.fromEntries(
      readdirSync(OUTPUT_DIR)
        .filter((fileName) => fileName.endsWith(".json"))
        .sort()
        .map((fileName) => [fileName, readFileSync(join(OUTPUT_DIR, fileName), "utf8")]),
    );
    expect(onDisk).toEqual(generateAll());
  });

  it("每个根 Schema 自包含(无 $ref)、携带 2020-12 声明 / $id / x-sm-class", () => {
    for (const entry of SCHEMA_REGISTRY) {
      const document = JSON.parse(
        readFileSync(join(OUTPUT_DIR, `${entry.name}.schema.json`), "utf8"),
      ) as Record<string, unknown>;
      expect(document["$schema"]).toBe(SCHEMA_DRAFT);
      expect(document["$id"]).toBe(`${SESSION_ACTION_SCHEMA_BASE_ID}/${entry.name}.schema.json`);
      expect(document["x-sm-class"]).toEqual(expect.any(String));
      expect(JSON.stringify(document)).not.toContain("$ref");
    }
  });

  it("action-request 的动作判别联合包含 12 个分支", () => {
    const document = JSON.parse(
      readFileSync(join(OUTPUT_DIR, "action-request.schema.json"), "utf8"),
    ) as { properties: { action: { oneOf: unknown[] } } };
    expect(document.properties.action.oneOf).toHaveLength(12);
  });

  it("classification.json 登记了全部根 Schema 的字段分类(WP-1 §6)", () => {
    const manifest = JSON.parse(
      readFileSync(join(OUTPUT_DIR, "classification.json"), "utf8"),
    ) as { schemas: Record<string, unknown> };
    for (const entry of SCHEMA_REGISTRY) {
      expect(manifest.schemas[entry.name]).toBeDefined();
    }
  });

  it("fieldClasses 键集与 Schema 顶层 properties 键集严格一致(新增字段漏改分类即失败,WP-1 §6)", () => {
    const manifest = JSON.parse(
      readFileSync(join(OUTPUT_DIR, "classification.json"), "utf8"),
    ) as { schemas: Record<string, { fieldClasses: Record<string, unknown> }> };
    for (const entry of SCHEMA_REGISTRY) {
      const document = JSON.parse(
        readFileSync(join(OUTPUT_DIR, `${entry.name}.schema.json`), "utf8"),
      ) as { properties?: Record<string, unknown> };
      const propertyNames = Object.keys(document.properties ?? {}).sort();
      const classifiedNames = Object.keys(
        manifest.schemas[entry.name]?.fieldClasses ?? {},
      ).sort();
      expect(classifiedNames).toEqual(propertyNames);
    }
  });

  it("provisional 载荷子树携带 x-sm-provisional 标记,且非 provisional 子树不带标记(M-3 机检面)", () => {
    const response = JSON.parse(
      readFileSync(join(OUTPUT_DIR, "action-response.schema.json"), "utf8"),
    ) as { properties: Record<string, unknown> };
    const { properties } = response;
    expect(properties).toMatchObject({
      projectionDelta: { "x-sm-provisional": true },
      publicEvents: { items: { "x-sm-provisional": true } },
      userVisibleError: { "x-sm-provisional": true },
    });
    // 顶层除 projectionDelta / userVisibleError 外不得直接携带标记(publicEvents 只标 items 子树)
    const directlyMarkedTopFields = Object.entries(properties)
      .filter(([, node]) => (node as Record<string, unknown>)["x-sm-provisional"] === true)
      .map(([fieldName]) => fieldName)
      .sort();
    expect(directlyMarkedTopFields).toEqual(["projectionDelta", "userVisibleError"]);
    // 请求与结果 Schema 是完全冻结面,任何位置都不得出现 provisional 标记
    for (const name of ["action-request", "verdict-result"] as const) {
      const document = readFileSync(join(OUTPUT_DIR, `${name}.schema.json`), "utf8");
      expect(document).not.toContain("x-sm-provisional");
    }
    const manifest = JSON.parse(
      readFileSync(join(OUTPUT_DIR, "classification.json"), "utf8"),
    ) as { schemas: Record<string, { provisionalFields?: string[] }> };
    expect(manifest.schemas["action-response"]?.provisionalFields).toEqual([
      "projectionDelta",
      "publicEvents",
      "userVisibleError",
    ]);
    expect(manifest.schemas["action-request"]?.provisionalFields).toBeUndefined();
  });
});

/**
 * JSON Schema 生成产物测试:入库文件与生成管线输出一致(WP-2 建线、WP-3 扩面——
 * 防止 TS 契约与落盘 JSON Schema 漂移;Rust 侧消费冒烟在 WP-6 收口)。
 *
 * WP-3 新增机检面:
 * - 注册表遍历覆盖公开 + server-only 两侧(allSchemaEntries);
 * - rejected 跨字段耦合的 if/then 注入形态冻结(superRefine 的 JSON Schema 等价物);
 * - server-only 专属标记:仅 projection-policy.schema.json 携带 x-sm-class:
 *   "server-only";
 * - provisional 临时标记彻底退场:任何产物不得再出现 x-sm-provisional(M-3 收口)。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateAll, SESSION_ACTION_SCHEMA_BASE_ID } from "../src/schema/generate.js";
import { allSchemaEntries } from "../src/server-only/schema-registry.js";

const OUTPUT_DIR = join(import.meta.dirname, "..", "schema");
const SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema";

describe("JSON Schema 生成产物(落盘纪律)", () => {
  it("schema/ 目录文件与生成管线输出完全一致(防双端漂移)", () => {
    const onDisk = Object.fromEntries(
      readdirSync(OUTPUT_DIR)
        .filter((fileName) => fileName.endsWith(".json"))
        .sort()
        .map((fileName) => [fileName, readFileSync(join(OUTPUT_DIR, fileName), "utf8")]),
    );
    expect(onDisk).toEqual(generateAll());
  });

  it("每个根 Schema(含 server-only)自包含、携带 2020-12 声明 / $id / x-sm-class", () => {
    for (const entry of allSchemaEntries()) {
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

  it("classification.json 登记了全部根 Schema(含 server-only)的字段分类(WP-1 §6)", () => {
    const manifest = JSON.parse(
      readFileSync(join(OUTPUT_DIR, "classification.json"), "utf8"),
    ) as { schemas: Record<string, unknown> };
    for (const entry of allSchemaEntries()) {
      expect(manifest.schemas[entry.name]).toBeDefined();
    }
  });

  it("fieldClasses 键集与 Schema 顶层 properties 键集严格一致(新增字段漏改分类即失败,WP-1 §6)", () => {
    const manifest = JSON.parse(
      readFileSync(join(OUTPUT_DIR, "classification.json"), "utf8"),
    ) as { schemas: Record<string, { fieldClasses: Record<string, unknown> }> };
    for (const entry of allSchemaEntries()) {
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

  it("action-response 的 rejected 跨字段耦合以 if/then 形态注入落盘产物(superRefine 等价物)", () => {
    const document = JSON.parse(
      readFileSync(join(OUTPUT_DIR, "action-response.schema.json"), "utf8"),
    ) as { allOf?: unknown[] };
    expect(document.allOf).toEqual([
      {
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
      },
    ]);
  });

  it("server-only 标记只打在 projection-policy 上(Schema 存在不等于可下发,WP-1 §五)", () => {
    for (const entry of allSchemaEntries()) {
      const document = JSON.parse(
        readFileSync(join(OUTPUT_DIR, `${entry.name}.schema.json`), "utf8"),
      ) as { "x-sm-class": string };
      if (entry.name === "projection-policy") {
        expect(document["x-sm-class"]).toBe("server-only");
      } else {
        expect(document["x-sm-class"]).not.toBe("server-only");
      }
    }
  });

  it("provisional 临时标记已彻底退场:任何落盘产物不得再出现 x-sm-provisional(M-3 收口)", () => {
    for (const fileName of readdirSync(OUTPUT_DIR)) {
      if (!fileName.endsWith(".json")) {
        continue;
      }
      expect(readFileSync(join(OUTPUT_DIR, fileName), "utf8")).not.toContain("x-sm-provisional");
    }
    const manifest = JSON.parse(
      readFileSync(join(OUTPUT_DIR, "classification.json"), "utf8"),
    ) as { schemas: Record<string, { provisionalFields?: string[] }> };
    for (const entry of allSchemaEntries()) {
      expect(manifest.schemas[entry.name]?.provisionalFields).toBeUndefined();
    }
  });
});

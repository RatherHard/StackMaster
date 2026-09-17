/**
 * JSON Schema 生成产物测试:入库文件与生成管线输出一致(WP-2 建线、WP-3 扩面——
 * 防止 TS 契约与落盘 JSON Schema 漂移;Rust 侧消费冒烟在 WP-6 收口)。
 *
 * WP-3 新增机检面:
 * - 注册表遍历覆盖公开 + server-only 两侧(allSchemaEntries);
 * - rejected 跨字段耦合的 if/then 注入形态冻结(superRefine 的 JSON Schema 等价物);
 * - server-only 专属标记:仅 server-only 契约(projection-policy、debug-variant-bundle)
 *   携带 x-sm-class: "server-only";
 * - provisional 临时标记彻底退场:任何产物不得再出现 x-sm-provisional(M-3 收口)。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateAll } from "../src/schema/generate.js";
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
      expect(document["$id"]).toBe(`${entry.baseId}/${entry.name}.schema.json`);
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
      ) as { properties?: Record<string, unknown>; oneOf?: Array<{ properties?: Record<string, unknown> }> };
      const classifiedNames = Object.keys(
        manifest.schemas[entry.name]?.fieldClasses ?? {},
      ).sort();
      if (Array.isArray(document.oneOf)) {
        // 判别联合根(如 embed-message):无顶层 properties,字段集合在每个分支
        // 重复——每个分支的属性键集都必须与 fieldClasses 严格一致。
        expect(document.oneOf.length).toBeGreaterThan(0);
        for (const branch of document.oneOf) {
          expect(Object.keys(branch.properties ?? {}).sort()).toEqual(classifiedNames);
        }
      } else {
        expect(Object.keys(document.properties ?? {}).sort()).toEqual(classifiedNames);
      }
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

  it("server-only 标记只打在 server-only 契约上(Schema 存在不等于可下发,WP-1 §五)", () => {
    // server-only 根 Schema 清单:投影策略(WP-1 第五章)+ 调试变体镜像
    // (阶段四 WP-40,编排器 ↔ 调试 worker 进程间契约,WP-1 清单 §6.9)。
    const SERVER_ONLY_SCHEMA_NAMES = new Set(["projection-policy", "debug-variant-bundle"]);
    for (const entry of allSchemaEntries()) {
      const document = JSON.parse(
        readFileSync(join(OUTPUT_DIR, `${entry.name}.schema.json`), "utf8"),
      ) as { "x-sm-class": string };
      if (SERVER_ONLY_SCHEMA_NAMES.has(entry.name)) {
        expect(document["x-sm-class"]).toBe("server-only");
      } else {
        expect(document["x-sm-class"]).not.toBe("server-only");
      }
    }
  });

  it("debug-variant-bundle 的跨字段耦合以 if/then 形态注入落盘产物(superRefine 等价物,阶段四 WP-40)", () => {
    const document = JSON.parse(
      readFileSync(join(OUTPUT_DIR, "debug-variant-bundle.schema.json"), "utf8"),
    ) as {
      allOf?: unknown[];
      properties?: { canarySlots?: { items?: { allOf?: unknown[] } } };
    };
    // ASLR 耦合(根级):aslrEnabled=false ⇒ baseAddresses 缺席;true ⇒ draws ≥ 1。
    expect(document.allOf).toEqual([
      {
        if: {
          properties: { aslrEnabled: { const: false } },
          required: ["aslrEnabled"],
        },
        then: {
          properties: {
            derivation: { not: { required: ["baseAddresses"] } },
          },
        },
      },
      {
        if: {
          properties: { aslrEnabled: { const: true } },
          required: ["aslrEnabled"],
        },
        then: {
          properties: {
            derivation: { properties: { draws: { minimum: 1 } } },
          },
        },
      },
    ]);
    // canary 槽耦合(条目级):containsSecret=true ⇒ visibility="hidden"。
    expect(document.properties?.canarySlots?.items?.allOf).toEqual([
      {
        if: {
          properties: { containsSecret: { const: true } },
          required: ["containsSecret"],
        },
        then: {
          properties: {
            visibility: { const: "hidden" },
          },
        },
      },
    ]);
  });

  it("verdict-query-response 的 pending/verdicted 状态机耦合以 if/then 形态注入落盘产物(superRefine 等价物,阶段六 WP-60)", () => {
    const document = JSON.parse(
      readFileSync(join(OUTPUT_DIR, "verdict-query-response.schema.json"), "utf8"),
    ) as { allOf?: unknown[]; $id?: string };
    // 独立契约族版本命名空间(VERDICT_CHANNEL_PROTOCOL_VERSION 派生)。
    expect(document.$id).toBe("https://stackmaster.dev/schemas/verdict/v1/verdict-query-response.schema.json");
    // pending ⇒ verdict 与 decidedAt 整体缺席;verdicted ⇒ 两者必在。
    expect(document.allOf).toEqual([
      {
        if: {
          properties: { status: { const: "pending" } },
          required: ["status"],
        },
        then: {
          allOf: [
            { not: { required: ["verdict"] } },
            { not: { required: ["decidedAt"] } },
          ],
        },
      },
      {
        if: {
          properties: { status: { const: "verdicted" } },
          required: ["status"],
        },
        then: {
          required: ["verdict", "decidedAt"],
        },
      },
    ]);
  });

  it("host-scores-response 的终态耦合以 if/then 形态注入落盘产物(superRefine 等价物,中期 M3 WP-78)", () => {
    const document = JSON.parse(
      readFileSync(join(OUTPUT_DIR, "host-scores-response.schema.json"), "utf8"),
    ) as {
      allOf?: unknown[];
      $id?: string;
      "x-sm-class"?: string;
      properties?: Record<string, unknown>;
    };
    // 独立契约族版本命名空间(HOST_SCORES_PROTOCOL_VERSION 派生)。
    expect(document.$id).toBe(
      "https://stackmaster.dev/schemas/host-scores/v1/host-scores-response.schema.json",
    );
    // 信封恰两键(items / nextCursor),整体 PUBLIC(公开面 = 成绩批量导出面)。
    expect(Object.keys(document.properties ?? {}).sort()).toEqual([
      "items",
      "nextCursor",
    ]);
    expect(document["x-sm-class"]).toBe("public");
    // 空批 ⇒ nextCursor 恒 null(终态确定性;空页 + 非空游标 = 无限翻页回路)。
    expect(document.allOf).toEqual([
      {
        if: {
          properties: { items: { maxItems: 0 } },
          required: ["items"],
        },
        then: {
          properties: { nextCursor: { const: null } },
        },
      },
    ]);
    // 记录面在产物内联且严格闭合(additionalProperties: false;零私有列)。
    const items = document.properties?.["items"] as {
      items?: { additionalProperties?: boolean; required?: string[] };
    };
    expect(items.items?.additionalProperties).toBe(false);
    expect([...(items.items?.required ?? [])].sort()).toEqual([
      "challengeId",
      "challengeVersion",
      "decidedAt",
      "id",
      "sessionId",
      "submissionId",
      "verdict",
    ]);
    // 私有面字段名在落盘产物中零出现(零 detail / 零 reference / 零 tenantId)。
    const text = readFileSync(join(OUTPUT_DIR, "host-scores-response.schema.json"), "utf8");
    for (const forbidden of ["detail", "reference", "tenantId", "verifierRunId", "hiddenTest"]) {
      expect(text).not.toContain(forbidden);
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

/**
 * Schema 严格性与跨包一致性防漂移测试(双包Schema语义.md §六):
 * - 数值限制:Schema 内 min/max 字面量按 JSON 指针逐一对照 limits.ts 常量;
 * - 模式字面量:patterns.ts 的每个模式源串必须原样出现在对应 Schema 文档中;
 * - 词汇封闭:Schema enum 数组 ≡ vocabulary.ts 封闭集(双文件同锚);
 * - 分类清单:schema/classification.json ≡ CHALLENGE_CLASSIFICATIONS 常量,
 *   且顶层 properties 键 ≡ 字段清单常量(14 公开 / 17 私有);
 * - 共享身份字段:4 个版本/身份字段必须同时出现在两个 Schema 的 required
 *   (WP-1 §12.1;XS-ID-CORR 的 Schema 侧前提);
 * - 结构性不相交:一般命名空间(负向前瞻排除 FLAG 保留区,G2/D3)× FLAG 模式
 *   (WP-1 §12.5 v1.5)。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARCH_BITS_VALUES,
  BIT_MASK_LOGIC_OPS,
  CORE_REGISTER_NAMES,
  CUSTOM_MNEMONIC_PATTERN_SOURCE,
  GENERAL_REGISTER_NAME_PATTERN,
  GENERAL_REGISTER_NAME_PATTERN_SOURCE,
  CHALLENGE_CLASSIFICATIONS,
  CHALLENGE_ID_PATTERN_SOURCE,
  CONTROL_CHARS_BAN_PATTERN_SOURCE,
  DSL_OPCODES,
  EFFECT_PRIMITIVES,
  FLAG_REGISTER_NAME_PATTERN,
  FLAG_REGISTER_NAME_PATTERN_SOURCE,
  HEX_BYTES_PATTERN_SOURCE,
  HEX_VALUE_64_PATTERN_SOURCE,
  INTERFACE_ID_MAX,
  INTERFACE_ID_MIN,
  IR_LABEL_ID_PATTERN_SOURCE,
  MAX_BYTES_HEX_PER_RANGE,
  MAX_CONDITION_BRANCHES,
  MAX_CUSTOM_INSTRUCTIONS,
  MAX_DECLARED_SEED_PATHS,
  MAX_EFFECTS_PER_INTERFACE,
  MAX_HIDDEN_TESTS,
  MAX_HIDDEN_TEST_PAYLOAD_HEX,
  MAX_HINTS,
  MAX_INTERFACES,
  MAX_IR_INSTRUCTIONS,
  MAX_IR_LABELS,
  MAX_MEMORY_CONTAINS_BYTES,
  MAX_MEMORY_EQUALS_BYTES,
  MAX_MEMORY_REGIONS,
  MAX_MICRO_OPS_PER_INSTRUCTION,
  MAX_OPERANDS_PER_INSTRUCTION,
  MAX_PAGE_SIZE_BYTES,
  MAX_PREDICATE_EVAL_STEPS,
  MAX_PRIVATE_OBJECTS,
  MAX_PUBLIC_ERROR_MAPPINGS,
  MAX_REGION_BYTE_LENGTH,
  MAX_SEMANTIC_HIGHLIGHTS,
  MAX_STAGES,
  MAX_STAGE_INSTRUCTION_STEPS,
  MAX_STAGE_SIDE_EFFECTS,
  MAX_STAGE_TRANSITIONS,
  MAX_VISIBLE_REGISTERS,
  MAX_VM_REGISTERS,
  MAX_VIRTUAL_FILES,
  MAX_VIRTUAL_FILE_BYTES,
  MAX_WRITE_BYTES,
  MICRO_OPS,
  MIN_PAGE_SIZE_BYTES,
  OBJECT_ID_PATTERN_SOURCE,
  PAGE_SIZE_MULTIPLE_BYTES,
  PREDICATE_TYPES,
  PERMISSIONS_PATTERN_SOURCE,
  PUBLIC_DESCRIPTOR_FIELDS,
  PUBLIC_ERROR_CODES,
  PUBLIC_HEX_VALUE_64_PATTERN_SOURCE,
  PRIVATE_BUNDLE_FIELDS,
  PRIVATE_OBJECT_KINDS,
  REACHABLE_HIDDEN_TEST_RESULTS,
  REGION_KINDS,
  REVEAL_POLICIES,
  SEMANTIC_HIGHLIGHT_KINDS,
  SEMVER_PATTERN_SOURCE,
  SEED_STRATEGIES,
  SESSION_ACTION_TYPES,
  SHARED_IDENTITY_FIELDS,
  DISPLACEMENT_HEX_PATTERN_SOURCE,
  SEED_HEX_PATTERN_SOURCE,
  SEED_PATH_PATTERN_SOURCE,
  VISIBILITY_LEVELS,
  HIDDEN_TEST_KINDS,
  STAGE_SIDE_EFFECT_TYPES,
  FORBIDDEN_PUBLIC_PROPERTIES,
} from "../src/index.js";
import type { ClassificationManifest } from "../src/index.js";

const schemaDir = join(import.meta.dirname, "..", "schema");
const publicSchemaText = readFileSync(join(schemaDir, "public-descriptor.schema.json"), "utf8");
const privateSchemaText = readFileSync(join(schemaDir, "private-bundle.schema.json"), "utf8");
const publicSchema = JSON.parse(publicSchemaText) as unknown;
const privateSchema = JSON.parse(privateSchemaText) as unknown;

/** 按 `/` 分隔指针解析文档内位置(锚点路径笔误即测试失败)。 */
function resolveAt(doc: unknown, pointer: string): unknown {
  let current: unknown = doc;
  for (const segment of pointer.split("/").filter((part) => part !== "")) {
    if (current === null || typeof current !== "object") {
      throw new Error(`指针越界:${pointer}(段 ${segment} 处非对象)`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) {
    throw new Error(`指针无值:${pointer}`);
  }
  return current;
}

function expectNumberAt(doc: unknown, pointer: string, key: string, expected: number): void {
  const node = resolveAt(doc, pointer) as Record<string, unknown>;
  expect(node[key], `${pointer}/${key}`).toBe(expected);
}

function expectEnumAt(doc: unknown, pointer: string, vocabulary: readonly string[]): void {
  const values = resolveAt(doc, `${pointer}/enum`) as unknown[];
  expect([...values].sort(), pointer).toEqual([...vocabulary].sort());
}

describe("Schema 数值限制 ≡ limits.ts(路径锚定防漂移)", () => {
  it("公开 Schema 数值锚点", () => {
    expectNumberAt(publicSchema, "/properties/vmProfile/properties/registers", "maxItems", MAX_VISIBLE_REGISTERS);
    expectNumberAt(publicSchema, "/properties/memoryLayout/properties/regions", "maxItems", MAX_MEMORY_REGIONS);
    expectNumberAt(
      publicSchema,
      "/properties/memoryLayout/properties/regions/items/properties/byteLength",
      "maximum",
      MAX_REGION_BYTE_LENGTH,
    );
    expectNumberAt(
      publicSchema,
      "/properties/memoryLayout/properties/regions/items/properties/byteLength",
      "multipleOf",
      PAGE_SIZE_MULTIPLE_BYTES,
    );
    expectNumberAt(publicSchema, "/properties/vmProfile/properties/pageSizeBytes", "minimum", MIN_PAGE_SIZE_BYTES);
    expectNumberAt(publicSchema, "/properties/vmProfile/properties/pageSizeBytes", "maximum", MAX_PAGE_SIZE_BYTES);
    expectNumberAt(publicSchema, "/properties/vmProfile/properties/pageSizeBytes", "multipleOf", PAGE_SIZE_MULTIPLE_BYTES);
    expectNumberAt(publicSchema, "/properties/resourceLimits/properties/maxWriteBytesPerAction", "maximum", MAX_WRITE_BYTES);
    expectNumberAt(publicSchema, "/properties/hintLadder", "maxItems", MAX_HINTS);
    expectNumberAt(publicSchema, "/properties/publicErrorMapping", "maxItems", MAX_PUBLIC_ERROR_MAPPINGS);
    expectNumberAt(publicSchema, "/properties/initialProjection/properties/visibleRegions", "maxItems", MAX_MEMORY_REGIONS);
    expectNumberAt(
      publicSchema,
      "/properties/initialProjection/properties/visibleRegions/items/properties/bytesHex",
      "maxLength",
      MAX_BYTES_HEX_PER_RANGE,
    );
    expectNumberAt(publicSchema, "/properties/initialProjection/properties/visibleRegisters", "maxItems", MAX_VISIBLE_REGISTERS);
    expectNumberAt(publicSchema, "/properties/initialProjection/properties/semanticHighlights", "maxItems", MAX_SEMANTIC_HIGHLIGHTS);
  });

  it("私有 Schema 数值锚点", () => {
    expectNumberAt(privateSchema, "/properties/declaredSeedPublicPaths", "maxItems", MAX_DECLARED_SEED_PATHS);
    expectNumberAt(privateSchema, "/properties/initialState/properties/memoryRegions", "maxItems", MAX_MEMORY_REGIONS);
    expectNumberAt(privateSchema, "/properties/initialState/properties/registers", "maxProperties", MAX_VM_REGISTERS);
    expectNumberAt(
      privateSchema,
      "/properties/initialState/properties/memoryRegions/items/properties/contentHex",
      "maxLength",
      MAX_REGION_BYTE_LENGTH * 2,
    );
    expectNumberAt(privateSchema, "/properties/secretSinkRegisters", "maxItems", MAX_VM_REGISTERS);
    expectNumberAt(privateSchema, "/properties/secrets/properties/virtualFiles", "maxItems", MAX_VIRTUAL_FILES);
    expectNumberAt(
      privateSchema,
      "/properties/secrets/properties/virtualFiles/items/properties/content",
      "maxLength",
      MAX_VIRTUAL_FILE_BYTES,
    );
    expectNumberAt(privateSchema, "/properties/privateObjects", "maxItems", MAX_PRIVATE_OBJECTS);
    expectNumberAt(privateSchema, "/properties/judging/properties/hiddenTests", "maxItems", MAX_HIDDEN_TESTS);
    expectNumberAt(
      privateSchema,
      "/properties/judging/properties/hiddenTests/items/properties/payloadHex",
      "maxLength",
      MAX_HIDDEN_TEST_PAYLOAD_HEX,
    );
    expectNumberAt(privateSchema, "/properties/stages", "maxItems", MAX_STAGES);
    expectNumberAt(privateSchema, "/properties/stages/items/properties/transitions", "maxItems", MAX_STAGE_TRANSITIONS);
    expectNumberAt(privateSchema, "/properties/stages/items/properties/sideEffects", "maxItems", MAX_STAGE_SIDE_EFFECTS);
    expectNumberAt(
      privateSchema,
      "/properties/stages/items/properties/resourceBudget/properties/maxInstructionSteps",
      "maximum",
      MAX_STAGE_INSTRUCTION_STEPS,
    );
    expectNumberAt(
      privateSchema,
      "/properties/stages/items/properties/resourceBudget/properties/maxInstructionSteps",
      "minimum",
      1,
    );
    expectNumberAt(privateSchema, "/properties/compiledIr/properties/instructions", "maxItems", MAX_IR_INSTRUCTIONS);
    expectNumberAt(
      privateSchema,
      "/properties/compiledIr/properties/instructions/items/properties/operands",
      "maxItems",
      MAX_OPERANDS_PER_INSTRUCTION,
    );
    expectNumberAt(privateSchema, "/properties/compiledIr/properties/labels", "maxItems", MAX_IR_LABELS);
    expectNumberAt(privateSchema, "/properties/customInstructions", "maxItems", MAX_CUSTOM_INSTRUCTIONS);
    expectNumberAt(
      privateSchema,
      "/properties/customInstructions/items/properties/semantics",
      "maxItems",
      MAX_MICRO_OPS_PER_INSTRUCTION,
    );
    expectNumberAt(privateSchema, "/properties/interfaces", "maxItems", MAX_INTERFACES);
    expectNumberAt(
      privateSchema,
      "/properties/interfaces/items/properties/effects",
      "maxItems",
      MAX_EFFECTS_PER_INTERFACE,
    );
    expectNumberAt(privateSchema, "/properties/interfaces/items/properties/interfaceId", "minimum", INTERFACE_ID_MIN);
    expectNumberAt(privateSchema, "/properties/interfaces/items/properties/interfaceId", "maximum", INTERFACE_ID_MAX);
    expectNumberAt(privateSchema, "/properties/judgingConfig/properties/maxPredicateEvalSteps", "maximum", MAX_PREDICATE_EVAL_STEPS);
    expectNumberAt(privateSchema, "/$defs/predicate/oneOf/2/properties/bytesHex", "maxLength", MAX_MEMORY_EQUALS_BYTES * 2);
    expectNumberAt(privateSchema, "/$defs/predicate/oneOf/3/properties/bytesHex", "maxLength", MAX_MEMORY_CONTAINS_BYTES * 2);
    expectNumberAt(privateSchema, "/$defs/conditionL1/properties/all", "maxItems", MAX_CONDITION_BRANCHES);
    expectNumberAt(privateSchema, "/$defs/conditionL2/properties/all", "maxItems", MAX_CONDITION_BRANCHES);
    expectNumberAt(privateSchema, "/$defs/byteLength", "maximum", MAX_REGION_BYTE_LENGTH);
    expectNumberAt(privateSchema, "/$defs/regionByteLength", "maximum", MAX_REGION_BYTE_LENGTH);
    expectNumberAt(privateSchema, "/$defs/regionByteLength", "multipleOf", PAGE_SIZE_MULTIPLE_BYTES);
  });
});

describe("Schema 模式字面量 ≡ patterns.ts(源串原样出现)", () => {
  it("两个 Schema 均携带共用模式源串", () => {
    const shared = [
      GENERAL_REGISTER_NAME_PATTERN_SOURCE,
      CHALLENGE_ID_PATTERN_SOURCE,
      FLAG_REGISTER_NAME_PATTERN_SOURCE,
      HEX_BYTES_PATTERN_SOURCE,
      HEX_VALUE_64_PATTERN_SOURCE,
      OBJECT_ID_PATTERN_SOURCE,
      PERMISSIONS_PATTERN_SOURCE,
      SEMVER_PATTERN_SOURCE,
    ];
    for (const source of shared) {
      expect(publicSchemaText).toContain(JSON.stringify(source));
      expect(privateSchemaText).toContain(JSON.stringify(source));
    }
  });

  it("公开 / 私有专属模式源串各归其位", () => {
    for (const source of [CONTROL_CHARS_BAN_PATTERN_SOURCE, PUBLIC_HEX_VALUE_64_PATTERN_SOURCE]) {
      expect(publicSchemaText).toContain(JSON.stringify(source));
    }
    for (const source of [
      CUSTOM_MNEMONIC_PATTERN_SOURCE,
      DISPLACEMENT_HEX_PATTERN_SOURCE,
      IR_LABEL_ID_PATTERN_SOURCE,
      SEED_HEX_PATTERN_SOURCE,
      SEED_PATH_PATTERN_SOURCE,
    ]) {
      expect(privateSchemaText).toContain(JSON.stringify(source));
    }
  });
});

describe("Schema enum ≡ vocabulary 封闭集", () => {
  it("公开 Schema 词汇锚点", () => {
    expectEnumAt(publicSchema, "/properties/memoryLayout/properties/regions/items/properties/kind", REGION_KINDS);
    expectEnumAt(publicSchema, "/properties/allowedActions/items", SESSION_ACTION_TYPES);
    expectEnumAt(publicSchema, "/properties/hintLadder/items/properties/revealPolicy", REVEAL_POLICIES);
    expectEnumAt(publicSchema, "/properties/publicErrorMapping/items/properties/errorCode", PUBLIC_ERROR_CODES);
    expectEnumAt(
      publicSchema,
      "/properties/initialProjection/properties/semanticHighlights/items/properties/kind",
      SEMANTIC_HIGHLIGHT_KINDS,
    );
  });

  it("私有 Schema 词汇锚点", () => {
    expectEnumAt(privateSchema, "/properties/seedPolicy/properties/strategy", SEED_STRATEGIES);
    expectEnumAt(privateSchema, "/properties/privateObjects/items/properties/kind", PRIVATE_OBJECT_KINDS);
    expectEnumAt(privateSchema, "/properties/privateObjects/items/properties/visibility", VISIBILITY_LEVELS);
    expectEnumAt(privateSchema, "/properties/judging/properties/hiddenTests/items/properties/kind", HIDDEN_TEST_KINDS);
    expectEnumAt(
      privateSchema,
      "/properties/judging/properties/hiddenTests/items/properties/expectedResult",
      REACHABLE_HIDDEN_TEST_RESULTS,
    );
    // G4:op 为双形态 anyOf(基线小写枚举 ∪ 大写助记符模式),词汇锚定基线分支。
    expectEnumAt(
      privateSchema,
      "/properties/compiledIr/properties/instructions/items/properties/op/anyOf/0",
      DSL_OPCODES,
    );
    expectEnumAt(privateSchema, "/$defs/regionKind", REGION_KINDS);
    expectEnumAt(privateSchema, "/$defs/sessionAction", SESSION_ACTION_TYPES);
  });

  it("vmProfile.archBits enum ≡ ARCH_BITS_VALUES(G1 位宽冻结枚举,数值面)", () => {
    const values = resolveAt(
      publicSchema,
      "/properties/vmProfile/properties/archBits/enum",
    ) as unknown[];
    expect([...values]).toEqual([...ARCH_BITS_VALUES]);
  });

  it("谓词判别式 oneOf ≡ PREDICATE_TYPES", () => {
    const oneOf = resolveAt(privateSchema, "/$defs/predicate/oneOf") as Array<{
      properties: { type: { const: string } };
    }>;
    const discriminators = oneOf.map((branch) => branch.properties.type.const);
    expect([...discriminators].sort()).toEqual([...PREDICATE_TYPES].sort());
  });

  it("微算子判别式 oneOf ≡ MICRO_OPS(G4/D4 封闭集,直线语义)", () => {
    const oneOf = resolveAt(privateSchema, "/$defs/microOp/oneOf") as Array<{
      properties: { op: { const: string } };
    }>;
    const discriminators = oneOf.map((branch) => branch.properties.op.const);
    expect([...discriminators].sort()).toEqual([...MICRO_OPS].sort());
  });

  it("接口效果判别式 oneOf ≡ EFFECT_PRIMITIVES(G4/D4 封闭集)", () => {
    const oneOf = resolveAt(privateSchema, "/$defs/interfaceEffect/oneOf") as Array<{
      properties: { effect: { const: string } };
    }>;
    const discriminators = oneOf.map((branch) => branch.properties.effect.const);
    expect([...discriminators].sort()).toEqual([...EFFECT_PRIMITIVES].sort());
  });

  it("bit_mask 位逻辑 enum ≡ BIT_MASK_LOGIC_OPS", () => {
    expectEnumAt(
      privateSchema,
      "/$defs/microOp/oneOf/5/properties/logic",
      BIT_MASK_LOGIC_OPS,
    );
  });
});

describe("分类清单与字段清单防漂移", () => {
  it("classification.json ≡ CHALLENGE_CLASSIFICATIONS 常量", () => {
    const manifest = JSON.parse(
      readFileSync(join(schemaDir, "classification.json"), "utf8"),
    ) as ClassificationManifest;

    expect(manifest).toEqual(CHALLENGE_CLASSIFICATIONS);
  });

  it("公开 Schema 顶层 properties ≡ PUBLIC_DESCRIPTOR_FIELDS(14 字段)", () => {
    const keys = Object.keys(resolveAt(publicSchema, "/properties") as Record<string, unknown>);
    expect([...keys].sort()).toEqual([...PUBLIC_DESCRIPTOR_FIELDS].sort());
  });

  it("私有 Schema 顶层 properties ≡ PRIVATE_BUNDLE_FIELDS(19 字段)", () => {
    const keys = Object.keys(resolveAt(privateSchema, "/properties") as Record<string, unknown>);
    expect([...keys].sort()).toEqual([...PRIVATE_BUNDLE_FIELDS].sort());
  });

  it("禁用属性集 = 私有顶层 − 4 共享身份字段,且与公开清单不相交", () => {
    const derived = PRIVATE_BUNDLE_FIELDS.filter(
      (name) => !(SHARED_IDENTITY_FIELDS as readonly string[]).includes(name),
    );
    expect([...FORBIDDEN_PUBLIC_PROPERTIES].sort()).toEqual([...derived].sort());
    for (const name of FORBIDDEN_PUBLIC_PROPERTIES) {
      expect(PUBLIC_DESCRIPTOR_FIELDS).not.toContain(name);
    }
  });
});

describe("共享身份字段(WP-1 §12.1 四类版本/身份字段)", () => {
  it("4 个共享身份字段同时出现在两个 Schema 的 required", () => {
    for (const [label, schema] of [
      ["公开", publicSchema],
      ["私有", privateSchema],
    ] as const) {
      const required = resolveAt(schema, "/required") as unknown[];
      for (const field of SHARED_IDENTITY_FIELDS) {
        expect(required, `${label} Schema required`).toContain(field);
      }
    }
  });

  it("challengeContentVersion / vmProfileVersion 两包同为 SEMVER 模式(身份形态一致)", () => {
    for (const field of ["challengeContentVersion", "vmProfileVersion"]) {
      const publicNode = resolveAt(publicSchema, `/properties/${field}`) as Record<string, unknown>;
      expect(publicNode["pattern"], `公开 /properties/${field}`).toBe(SEMVER_PATTERN_SOURCE);

      const privateNode = resolveAt(privateSchema, `/properties/${field}`) as Record<string, unknown>;
      expect(privateNode["$ref"], `私有 /properties/${field}`).toBe("#/$defs/semver");
    }
    const semverDef = resolveAt(privateSchema, "/$defs/semver") as Record<string, unknown>;
    expect(semverDef["pattern"]).toBe(SEMVER_PATTERN_SOURCE);
  });
});

describe("结构性不相交(G2/D3 双命名空间保留模型,WP-1 §12.5 v1.5)", () => {
  it("一般命名空间与 FLAG 保留区不相交;核心三寄存器与自由命名匹配一般模式", () => {
    expect(GENERAL_REGISTER_NAME_PATTERN.test("FLAG0")).toBe(false);
    expect(FLAG_REGISTER_NAME_PATTERN.test("RAX")).toBe(false);
    for (const name of CORE_REGISTER_NAMES) {
      expect(GENERAL_REGISTER_NAME_PATTERN.test(name), name).toBe(true);
      expect(FLAG_REGISTER_NAME_PATTERN.test(name), name).toBe(false);
    }
    // 自由命名面(R_MYDATA / CTRL 为验收绿灯样例);不属任何命名空间的键拒绝。
    expect(GENERAL_REGISTER_NAME_PATTERN.test("R_MYDATA")).toBe(true);
    expect(GENERAL_REGISTER_NAME_PATTERN.test("CTRL")).toBe(true);
    expect(GENERAL_REGISTER_NAME_PATTERN.test("rsp")).toBe(false);
    expect(FLAG_REGISTER_NAME_PATTERN.test("rsp")).toBe(false);
    // 一般名长度界:恰 16 字符通过,17 字符拒绝。
    expect(GENERAL_REGISTER_NAME_PATTERN.test("R".repeat(16))).toBe(true);
    expect(GENERAL_REGISTER_NAME_PATTERN.test("R".repeat(17))).toBe(false);
  });

  it("副作用类型封闭集非空且仅含 grant_virtual_file(v1 封闭面)", () => {
    expect([...STAGE_SIDE_EFFECT_TYPES]).toEqual(["grant_virtual_file"]);
  });
});

/**
 * M10/WP-80 出题者积木声明面:视图 / 工具链 / 编译面行为测试(TDD)。
 *
 * 覆盖三条契约:
 *  1. **零声明零变化**(回归护栏):未声明 `authorBlocks` 时,积木定义、
 *     工具箱分类、编译行为与既有形态**逐字相同**——既有 29 块与 10 个分类
 *     不动,动态块类型不在场;
 *  2. **声明即注入**:声明集在工具箱末尾追加「题目积木」分类,动态块类型
 *     `payload_author_<id>` 登记,槽位 = Number 表达式输入;缺声明 / 换绑
 *     不改写既有定义(登记面幂等);
 *  3. **编译面**:动态块展开为模板声明的公开动作序列(槽位地址 / 数值两种
 *     取值形态),`allowedActions` 裁剪保留(`unauthorized_action` 携带该积木
 *     `blockId`),未知模板报 `unknown_block_type`,槽位缺输入报
 *     `missing_input`。
 *
 * 依赖纪律:本包是浏览器包,不 import challenge-schema ⇒ 声明面形状以
 * 公开 Schema 黄金样例(`packages/challenge-schema/test/fixtures/
 * public-descriptor/author-blocks.json`)**逐字段手工镜像**在本文件常量中,
 * 两侧漂移由 challenge-schema 侧 strictness 测试与 fixture 清单显式锚定。
 */
import { describe, expect, it } from "vitest";
import type { ActionObject } from "@stackmaster/protocol";

import {
  PAYLOAD_AUTHOR_BLOCK_TYPE_PREFIX,
  PAYLOAD_START_BLOCK_TYPE,
  PAYLOAD_TOOLBOX_CATEGORIES,
  authorBlockIdFromType,
  authorBlockSlotInputName,
  authorBlockType,
  buildAuthorBlockCategory,
  buildAuthorBlockDefinitions,
  buildPayloadBlockDefinitions,
  buildPayloadToolbox,
  buildPayloadToolboxCategories,
  isAuthorBlockType,
  registerPayloadBlocks,
  type PayloadAuthorBlockDecl,
} from "../../src/payload/compiler/blocks.js";
import { PAYLOAD_DEFAULT_ALLOWED_ACTIONS, compilePayload } from "../../src/payload/compiler/compile.js";
import type {
  BlocklySerializedBlockState,
  BlocklySerializedState,
  PayloadStep,
} from "../../src/payload/compiler/types.js";

// ── 声明面样例(逐字段镜像公开 Schema 黄金样例 author-blocks.json)──────────

const DECLARATIONS: readonly PayloadAuthorBlockDecl[] = [
  {
    id: "overwrite-return",
    displayText: "覆写返回地址",
    interfaceId: 512,
    slots: [
      { key: "target", label: "目标地址", kind: "address" },
      { key: "padding", label: "填充长度", kind: "length" },
    ],
    actions: [
      { type: "write_bytes", args: { addressHex: { slot: "target" }, bytesHex: "4141414141414141" } },
      { type: "push", args: { valueHex: { slot: "padding" } } },
      { type: "call", args: { targetHex: { slot: "target" } } },
    ],
  },
  {
    id: "mark-and-step",
    displayText: "打标记并单步",
    interfaceId: 768,
    slots: [],
    actions: [
      { type: "create_checkpoint", args: { label: "payload 检查点" } },
      { type: "step", args: {} },
    ],
  },
];

// ── 序列化状态助手(与 compile.test.ts 同形的最小实现)────────────────────

let nextBlockId = 0;

function block(
  type: string,
  options: { fields?: Record<string, string>; inputs?: Record<string, unknown> } = {},
): BlocklySerializedBlockState {
  nextBlockId += 1;
  return {
    type,
    id: `wp80-${nextBlockId}`,
    ...(options.fields === undefined ? {} : { fields: options.fields }),
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
  };
}

function value(blockSpec: BlocklySerializedBlockState): Record<string, unknown> {
  return { block: blockSpec };
}

function linkedProgram(...statements: BlocklySerializedBlockState[]): BlocklySerializedState {
  const start = block(PAYLOAD_START_BLOCK_TYPE);
  let tail: { block: BlocklySerializedBlockState } | undefined;
  for (const statement of [...statements].reverse()) {
    tail = tail === undefined ? { block: statement } : { block: { ...statement, next: tail } };
  }
  return {
    blocks: {
      languageVersion: 0,
      blocks: tail === undefined ? [start] : [{ ...start, next: tail }],
    },
  };
}

function actionOf(step: PayloadStep | undefined): ActionObject {
  if (step === undefined || step.kind !== "action") {
    throw new Error(`期望动作步骤,实际:${JSON.stringify(step)}`);
  }
  return step.action;
}

// ── 1. 零声明零变化(回归护栏)────────────────────────────────────────────

describe("M10/WP-80 未声明积木模板时的零行为变化(回归护栏)", () => {
  it("积木定义面:缺省调用与显式空声明集产出逐字相同的定义数组", () => {
    const implicit = buildPayloadBlockDefinitions();
    const explicit = buildPayloadBlockDefinitions([]);

    expect(explicit).toEqual(implicit);
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(implicit));
  });

  it("工具箱分类面:缺省调用不含「题目积木」分类且分类集合逐字不变", () => {
    const implicit = buildPayloadToolboxCategories();
    const explicit = buildPayloadToolboxCategories([]);

    expect(explicit).toEqual(implicit);
    expect(implicit).toEqual([...PAYLOAD_TOOLBOX_CATEGORIES]);
    expect(implicit.map((category) => category.name)).not.toContain("题目积木");
  });

  it("工具箱定义面:缺省 contents ≡ 内建分类(动态块类型零出现)", () => {
    const toolbox = buildPayloadToolbox();

    expect(toolbox.contents).toHaveLength(PAYLOAD_TOOLBOX_CATEGORIES.length);
    const types = toolbox.contents.flatMap((category) =>
      category.contents.map((entry) => entry.type),
    );
    expect(types.some((type) => isAuthorBlockType(type))).toBe(false);
  });

  it("定义面:未声明时动态块类型名不进任何动态定义(纯函数不缓存声明)", () => {
    expect(buildAuthorBlockDefinitions(DECLARATIONS)).toHaveLength(DECLARATIONS.length);
    expect(buildAuthorBlockDefinitions([])).toEqual([]);
    expect(buildAuthorBlockCategory([])).toBeNull();
  });
});

// ── 2. 声明即注入 ─────────────────────────────────────────────────────────

describe("M10/WP-80 声明积木模板后的注入面", () => {
  it("动态块类型名 = payload_author_<id>,且可反向解析回模板 id", () => {
    expect(authorBlockType("overwrite-return")).toBe("payload_author_overwrite-return");
    expect(PAYLOAD_AUTHOR_BLOCK_TYPE_PREFIX).toBe("payload_author_");
    expect(isAuthorBlockType("payload_author_overwrite-return")).toBe(true);
    expect(isAuthorBlockType(PAYLOAD_START_BLOCK_TYPE)).toBe(false);
    expect(authorBlockIdFromType("payload_author_overwrite-return")).toBe("overwrite-return");
    expect(authorBlockIdFromType("payload_start")).toBeNull();
  });

  it("动态块定义:展示文本 + 槽位标签构成 message0,槽位各占一个 Number 值输入", () => {
    const definitions = buildAuthorBlockDefinitions(DECLARATIONS);
    const first = definitions[0] as Record<string, unknown>;

    expect(first["type"]).toBe("payload_author_overwrite-return");
    expect(first["message0"]).toBe("覆写返回地址 目标地址 %1 填充长度 %2");
    expect(first["args0"]).toEqual([
      { type: "input_value", name: "SLOT_TARGET", check: "Number", align: "RIGHT" },
      { type: "input_value", name: "SLOT_PADDING", check: "Number", align: "RIGHT" },
    ]);
    expect(first["previousStatement"]).toBeNull();
    expect(first["nextStatement"]).toBeNull();
    expect(authorBlockSlotInputName("target")).toBe("SLOT_TARGET");
    // 零槽位模板:message0 = 展示文本,args0 为空(下界形态)。
    const second = definitions[1] as Record<string, unknown>;
    expect(second["message0"]).toBe("打标记并单步");
    expect(second["args0"]).toEqual([]);
  });

  it("工具箱分类:声明集在末尾追加「题目积木」分类,内建分类与顺序不动", () => {
    const categories = buildPayloadToolboxCategories(DECLARATIONS);

    expect(categories).toHaveLength(PAYLOAD_TOOLBOX_CATEGORIES.length + 1);
    expect(categories.slice(0, PAYLOAD_TOOLBOX_CATEGORIES.length)).toEqual([
      ...PAYLOAD_TOOLBOX_CATEGORIES,
    ]);
    const authorCategory = categories[categories.length - 1];
    expect(authorCategory?.name).toBe("题目积木");
    expect(authorCategory?.contents).toEqual([
      { kind: "block", type: "payload_author_overwrite-return" },
      { kind: "block", type: "payload_author_mark-and-step" },
    ]);
  });

  it("登记面幂等:重复登记同一声明集不抛错(增量按类型去重)", () => {
    expect(() => {
      registerPayloadBlocks(DECLARATIONS);
      registerPayloadBlocks(DECLARATIONS);
      registerPayloadBlocks();
    }).not.toThrow();
  });
});

// ── 3. 编译面:声明积木 → 12 公开动作 ─────────────────────────────────────

describe("M10/WP-80 声明积木的编译面(展开为公开动作序列)", () => {
  it("槽位填充后逐条展开为动作序列(地址槽 → addressHex,数值槽 → valueHex)", () => {
    const result = compilePayload(
      linkedProgram(
        block("payload_author_overwrite-return", {
          inputs: {
            SLOT_TARGET: value(block("payload_num", { fields: { N: "0x7fff0000" } })),
            SLOT_PADDING: value(block("payload_num", { fields: { N: "64" } })),
          },
        }),
      ),
      { authorBlocks: DECLARATIONS },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.program.steps).toHaveLength(3);
    expect(actionOf(result.program.steps[0])).toEqual({
      type: "write_bytes",
      args: { addressHex: "0x7fff0000", bytesHex: "4141414141414141" },
    });
    expect(actionOf(result.program.steps[1])).toEqual({
      type: "push",
      args: { valueHex: "0x40" },
    });
    expect(actionOf(result.program.steps[2])).toEqual({
      type: "call",
      args: { targetHex: "0x7fff0000" },
    });
  });

  it("零槽位模板展开:字面量参数位原样透传,零参动作 args 为空对象", () => {
    const result = compilePayload(linkedProgram(block("payload_author_mark-and-step")), {
      authorBlocks: DECLARATIONS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.program.steps.map((step) => actionOf(step))).toEqual([
      { type: "create_checkpoint", args: { label: "payload 检查点" } },
      { type: "step", args: {} },
    ]);
  });

  it("allowedActions 裁剪保留:未授权动作不产出步骤且报 unauthorized_action(携带该积木 blockId)", () => {
    const authorBlockNode = block("payload_author_mark-and-step");
    const result = compilePayload(linkedProgram(authorBlockNode), {
      authorBlocks: DECLARATIONS,
      allowedActions: ["step"],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const unauthorized = result.errors.find((error) => error.code === "unauthorized_action");
    expect(unauthorized?.message).toContain("create_checkpoint");
    expect(unauthorized?.blockId).toBe(authorBlockNode.id);
  });

  it("缺省 allowedActions 下 12 公开动作内的声明动作全数通过(缺省裁剪面同内建)", () => {
    expect(PAYLOAD_DEFAULT_ALLOWED_ACTIONS).toContain("call");
    const result = compilePayload(
      linkedProgram(
        block("payload_author_overwrite-return", {
          inputs: {
            SLOT_TARGET: value(block("payload_num", { fields: { N: "4096" } })),
            SLOT_PADDING: value(block("payload_num", { fields: { N: "8" } })),
          },
        }),
      ),
      { authorBlocks: DECLARATIONS },
    );

    expect(result.ok).toBe(true);
  });

  it("槽位输入未连接:确定性报 missing_input(不静默取 0)", () => {
    const result = compilePayload(
      linkedProgram(block("payload_author_overwrite-return", { inputs: { SLOT_TARGET: value(block("payload_num", { fields: { N: "4096" } })) } })),
      { authorBlocks: DECLARATIONS },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.map((error) => error.code)).toContain("missing_input");
  });

  it("未声明该模板:动态块类型命中前缀但不在声明集 ⇒ unknown_block_type(可解释)", () => {
    const result = compilePayload(linkedProgram(block("payload_author_not-declared")), {
      authorBlocks: DECLARATIONS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.map((error) => error.code)).toContain("unknown_block_type");
    expect(result.errors[0]?.message).toContain("payload_author_not-declared");
  });

  it("未传声明集时动态块类型不可加载:序列化状态以 unknown_block_type 拒载", () => {
    const result = compilePayload(linkedProgram(block("payload_author_overwrite-return")));

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors[0]?.code).toBe("unknown_block_type");
  });
});

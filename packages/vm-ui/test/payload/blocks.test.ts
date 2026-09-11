/**
 * Payload 积木定义与工具箱测试(WP-F6 / FE-PB-02 / FE-PB-03 / FE-PB-05/06):
 * 全部积木定义携带中文 tooltip(悬停提示)、工具箱分类齐备、定义可在无头
 * workspace 中实例化(序列化 JSON 输入路径,不依赖 Blockly DOM 渲染)。
 */
import { describe, expect, it } from "vitest";
import * as Blockly from "blockly";

import {
  PAYLOAD_BLOCK_DEFINITIONS,
  PAYLOAD_START_BLOCK_TYPE,
  PAYLOAD_TOOLBOX_CATEGORIES,
  registerPayloadBlocks,
} from "../../src/payload/compiler/blocks.js";
import type { BlocklySerializedState } from "../../src/payload/compiler/types.js";

describe("积木定义(FE-PB-02 / FE-PB-06)", () => {
  it("每块积木都携带非空中文 tooltip(悬停提示)", () => {
    expect(PAYLOAD_BLOCK_DEFINITIONS.length).toBeGreaterThan(0);
    for (const definition of PAYLOAD_BLOCK_DEFINITIONS) {
      expect(definition.type, "积木定义缺 type").toBeTypeOf("string");
      expect(definition.tooltip, `积木 ${String(definition.type)} 缺 tooltip`).toBeTypeOf("string");
      expect(String(definition.tooltip).length, `积木 ${String(definition.type)} tooltip 为空`).toBeGreaterThan(4);
    }
  });

  it("工具箱覆盖 FE-PB-02 八类 + 会话动作分类;起始积木不进工具箱(FE-PB-03 唯一)", () => {
    const names = PAYLOAD_TOOLBOX_CATEGORIES.map((category) => category.name);
    // FE-PB-02 八类。
    for (const required of ["变量", "列表", "分支", "循环", "函数", "运算与赋值", "字符串", "断点"]) {
      expect(names, `缺分类:${required}`).toContain(required);
    }
    // 主控定案映射增设:会话动作(12 动作教学落点)。
    expect(names).toContain("会话动作");
    // 起始积木唯一入口:工具箱不含。
    const toolboxTypes = PAYLOAD_TOOLBOX_CATEGORIES.flatMap((category) =>
      category.contents.map((content) => content.type),
    );
    expect(toolboxTypes).not.toContain(PAYLOAD_START_BLOCK_TYPE);
  });
});

describe("积木定义可实例化(无头 workspace,序列化 JSON 输入)", () => {
  it("登记后,含全部工具箱积木与起始积木的序列化状态可加载", () => {
    registerPayloadBlocks();
    const types = PAYLOAD_TOOLBOX_CATEGORIES.flatMap((category) =>
      category.contents.map((content) => content.type),
    );
    const state: BlocklySerializedState = {
      blocks: {
        languageVersion: 0,
        blocks: [
          { type: PAYLOAD_START_BLOCK_TYPE, id: "start" },
          ...types.map((type, index) => ({ type, id: `b${index}` })),
        ],
      },
    };
    const workspace = new Blockly.Workspace();
    try {
      Blockly.serialization.workspaces.load(state as never, workspace);
      expect(workspace.getTopBlocks(false).length).toBe(types.length + 1);
    } finally {
      workspace.dispose();
    }
  });

  it("重复登记是幂等的(编译器与 UI 共享定义源)", () => {
    expect(() => registerPayloadBlocks()).not.toThrow();
    expect(() => registerPayloadBlocks()).not.toThrow();
  });
});

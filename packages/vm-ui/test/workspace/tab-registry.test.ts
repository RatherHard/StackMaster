/**
 * 标签页类型注册表行为测试(WP-F5;WP-F8 扩充):默认登记序、debug =
 * 指令视图真工厂(FE-IN-01 替换占位)、ED 组件面五类挂接、可扩展登记
 * (WP-F6 挂点)、覆盖更新语义。
 */
import { describe, expect, it } from "vitest";

import {
  CALL_STACK_TAB_TYPE,
  CHECKPOINTS_TAB_TYPE,
  DEBUG_TAB_TYPE,
  FREE_TAB_TYPE,
  MEMORY_DIFF_TAB_TYPE,
  PAYLOAD_TAB_TYPE,
  REGISTERS_TAB_TYPE,
  STACK_TAB_TYPE,
  STRUCTURE_TAB_TYPE,
  TIMELINE_TAB_TYPE,
  WorkspaceTabTypeRegistry,
  createDefaultTabTypeRegistry,
  defaultTabTypeRegistry,
} from "../../src/workspace/tab-registry.js";
import { SmInstructionView } from "../../src/views/instruction/sm-instruction-view.js";
import { SmStructureView } from "../../src/views/ed/sm-structure-view.js";
import { SmCallStack } from "../../src/views/ed/sm-call-stack.js";
import { SmMemoryDiff } from "../../src/views/ed/sm-memory-diff.js";
import { SmTimeline } from "../../src/views/ed/sm-timeline.js";
import { SmCheckpoints } from "../../src/views/ed/sm-checkpoints.js";

describe("标签页类型注册表:默认登记(WP-F5 四类 + WP-F6 payload + WP-F8 ED)", () => {
  it("登记十类,登记序稳定(工作区四视图 + payload + ED 组件面)", () => {
    const registry = createDefaultTabTypeRegistry();
    expect(registry).toBeInstanceOf(WorkspaceTabTypeRegistry);
    expect(registry.list().map((descriptor) => descriptor.type)).toEqual([
      STACK_TAB_TYPE,
      FREE_TAB_TYPE,
      REGISTERS_TAB_TYPE,
      PAYLOAD_TAB_TYPE,
      DEBUG_TAB_TYPE,
      STRUCTURE_TAB_TYPE,
      CALL_STACK_TAB_TYPE,
      MEMORY_DIFF_TAB_TYPE,
      TIMELINE_TAB_TYPE,
      CHECKPOINTS_TAB_TYPE,
    ]);
  });

  it("stack / free / registers / payload / debug 带内容工厂,展示名与 FE 口径一致", () => {
    const registry = createDefaultTabTypeRegistry();
    expect(registry.hasFactory(STACK_TAB_TYPE)).toBe(true);
    expect(registry.hasFactory(FREE_TAB_TYPE)).toBe(true);
    expect(registry.hasFactory(REGISTERS_TAB_TYPE)).toBe(true);
    expect(registry.hasFactory(PAYLOAD_TAB_TYPE)).toBe(true);
    expect(registry.hasFactory(DEBUG_TAB_TYPE)).toBe(true);
    expect(registry.get(STACK_TAB_TYPE)?.label).toBe("栈视图");
    expect(registry.get(FREE_TAB_TYPE)?.label).toBe("自由视图");
    expect(registry.get(REGISTERS_TAB_TYPE)?.label).toBe("寄存器视图");
    expect(registry.get(PAYLOAD_TAB_TYPE)?.label).toBe("Payload 搭建");
    expect(registry.get(DEBUG_TAB_TYPE)?.label).toBe("指令视图");
  });

  it("debug 类型(F8)= 指令视图真工厂:替换 F5 占位,工厂产出 SmInstructionView 并注数据源", () => {
    const registry = createDefaultTabTypeRegistry();
    const dataSource = null; // 工厂上下文数据源面(视图自行消费)。
    const content = registry.get(DEBUG_TAB_TYPE)?.createContent?.({ dataSource });
    expect(content).toBeInstanceOf(SmInstructionView);
    expect((content as SmInstructionView).dataSource).toBeNull();
  });

  it("ED 组件面五类带工厂:组件实例产出(属性由工作区组合根注入)", () => {
    const registry = createDefaultTabTypeRegistry();
    expect(registry.get(STRUCTURE_TAB_TYPE)?.createContent?.({ dataSource: null })).toBeInstanceOf(SmStructureView);
    expect(registry.get(CALL_STACK_TAB_TYPE)?.createContent?.({ dataSource: null })).toBeInstanceOf(SmCallStack);
    expect(registry.get(MEMORY_DIFF_TAB_TYPE)?.createContent?.({ dataSource: null })).toBeInstanceOf(SmMemoryDiff);
    expect(registry.get(TIMELINE_TAB_TYPE)?.createContent?.({ dataSource: null })).toBeInstanceOf(SmTimeline);
    expect(registry.get(CHECKPOINTS_TAB_TYPE)?.createContent?.({ dataSource: null })).toBeInstanceOf(SmCheckpoints);
  });
});

describe("标签页类型注册表:可扩展结构(开放 string 类型键)", () => {
  it("register 追加新类型即可枚举与取用", () => {
    const registry = createDefaultTabTypeRegistry();
    registry.register({ type: "custom-extra", label: "自定义" });

    expect(registry.has("custom-extra")).toBe(true);
    expect(registry.list().at(-1)?.type).toBe("custom-extra");
  });

  it("同名重复登记 = 覆盖更新且保持登记序位置", () => {
    const registry = createDefaultTabTypeRegistry();
    registry.register({ type: STACK_TAB_TYPE, label: "栈视图(改)" });

    expect(registry.get(STACK_TAB_TYPE)?.label).toBe("栈视图(改)");
    expect(registry.list().map((descriptor) => descriptor.type)[0]).toBe(STACK_TAB_TYPE);
  });

  it("生产默认单例与新建实例相互独立(测试隔离)", () => {
    const registry = createDefaultTabTypeRegistry();
    registry.register({ type: "custom-extra", label: "自定义" });

    expect(defaultTabTypeRegistry.has("custom-extra")).toBe(false);
  });
});

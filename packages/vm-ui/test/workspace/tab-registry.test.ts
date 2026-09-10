/**
 * 标签页类型注册表行为测试(WP-F5):默认四类登记、debug 占位无工厂、
 * 可扩展登记(WP-F6 挂点)、覆盖更新语义。
 */
import { describe, expect, it } from "vitest";

import {
  DEBUG_TAB_TYPE,
  FREE_TAB_TYPE,
  REGISTERS_TAB_TYPE,
  STACK_TAB_TYPE,
  WorkspaceTabTypeRegistry,
  createDefaultTabTypeRegistry,
  defaultTabTypeRegistry,
} from "../../src/workspace/tab-registry.js";

describe("标签页类型注册表:默认登记(WP-F5 四类)", () => {
  it("登记 stack / free / registers / debug 四类,登记序稳定", () => {
    const registry = createDefaultTabTypeRegistry();
    expect(registry).toBeInstanceOf(WorkspaceTabTypeRegistry);
    expect(registry.list().map((descriptor) => descriptor.type)).toEqual([
      STACK_TAB_TYPE,
      FREE_TAB_TYPE,
      REGISTERS_TAB_TYPE,
      DEBUG_TAB_TYPE,
    ]);
  });

  it("stack / free / registers 带内容工厂,展示名与 FE 口径一致", () => {
    const registry = createDefaultTabTypeRegistry();
    expect(registry.hasFactory(STACK_TAB_TYPE)).toBe(true);
    expect(registry.hasFactory(FREE_TAB_TYPE)).toBe(true);
    expect(registry.hasFactory(REGISTERS_TAB_TYPE)).toBe(true);
    expect(registry.get(STACK_TAB_TYPE)?.label).toBe("栈视图");
    expect(registry.get(FREE_TAB_TYPE)?.label).toBe("自由视图");
    expect(registry.get(REGISTERS_TAB_TYPE)?.label).toBe("寄存器视图");
  });

  it("debug 仅登记占位不实现:无工厂 + 空态文案指向 WP-F8", () => {
    const registry = createDefaultTabTypeRegistry();
    expect(registry.has(DEBUG_TAB_TYPE)).toBe(true);
    expect(registry.hasFactory(DEBUG_TAB_TYPE)).toBe(false);
    expect(registry.get(DEBUG_TAB_TYPE)?.placeholderNote).toContain("WP-F8");
  });
});

describe("标签页类型注册表:可扩展结构(WP-F6 挂点)", () => {
  it("register 追加新类型即可枚举与取用", () => {
    const registry = createDefaultTabTypeRegistry();
    registry.register({ type: "payload", label: "Payload 搭建" });

    expect(registry.has("payload")).toBe(true);
    expect(registry.list().at(-1)?.type).toBe("payload");
  });

  it("同名重复登记 = 覆盖更新且保持登记序位置", () => {
    const registry = createDefaultTabTypeRegistry();
    registry.register({ type: STACK_TAB_TYPE, label: "栈视图(改)" });

    expect(registry.get(STACK_TAB_TYPE)?.label).toBe("栈视图(改)");
    expect(registry.list().map((descriptor) => descriptor.type)[0]).toBe(STACK_TAB_TYPE);
  });

  it("生产默认单例与新建实例相互独立(测试隔离)", () => {
    const registry = createDefaultTabTypeRegistry();
    registry.register({ type: "payload", label: "Payload 搭建" });

    expect(defaultTabTypeRegistry.has("payload")).toBe(false);
  });
});

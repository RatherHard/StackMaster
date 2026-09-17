/**
 * 公开入口装配测试(WP-F2 起;WP-F5 扩充):index.ts 导出面健全性——视图 /
 * 宿主消费的公共 API 面冻结在此(防意外漏导出 / 改名)。
 */
import { describe, expect, it } from "vitest";
import * as vmUi from "../src/index.js";

describe("公开入口导出面", () => {
  it("会话客户端 / 存储 / 错误面 / 传输层全部导出", () => {
    expect(vmUi.SessionClient).toBeTypeOf("function");
    expect(vmUi.ProjectionStore).toBeTypeOf("function");
    expect(vmUi.SessionClientError).toBeTypeOf("function");
    expect(vmUi.SessionCommandError).toBeTypeOf("function");
    expect(vmUi.BrowserWebSocketAdapter).toBeTypeOf("function");
    expect(vmUi.resolveWebSocketUrl).toBeTypeOf("function");
    expect(vmUi.WSS_CHANNEL_PATH).toBe("/sessions/channel");
  });

  it("双档数据源与共享渲染原语全部导出", () => {
    expect(vmUi.ProjectionDataSource).toBeTypeOf("function");
    expect(vmUi.DebugDataSource).toBeTypeOf("function");
    expect(vmUi.ROW_BYTES).toBe(8);
    expect(vmUi.SPECIAL_DISPLAY_PLACEHOLDER).toBeTypeOf("string");
    expect(vmUi.renderSpecialDisplayCell).toBeTypeOf("function");
    expect(vmUi.normalizeValueHex).toBeTypeOf("function");
    expect(vmUi.enumerateRowSpans).toBeTypeOf("function");
    expect(vmUi.parseAddressHex).toBeTypeOf("function");
  });

  it("WP-F3/F4 视图组件与原语全部导出(工作区集成消费面)", () => {
    expect(vmUi.SmByteView).toBeTypeOf("function");
    expect(vmUi.SmVmaList).toBeTypeOf("function");
    expect(vmUi.SmRegisterView).toBeTypeOf("function");
    expect(vmUi.SmJumpChain).toBeTypeOf("function");
    expect(vmUi.crossAnnotateRegisters).toBeTypeOf("function");
    expect(vmUi.renderRegisterAnnotationCell).toBeTypeOf("function");
    expect(vmUi.resolveJumpChain).toBeTypeOf("function");
    expect(vmUi.visibleRunAt).toBeTypeOf("function");
    expect(vmUi.COPY_SUCCESS_TEXT).toBeTypeOf("string");
    expect(vmUi.JUMP_CHAIN_HORIZONTAL_LIMIT).toBe(3);
  });

  it("WP-F5 工作区容器 / 菜单 / 注册表 / 模型 / 组合页全部导出", () => {
    expect(vmUi.SmWorkspace).toBeTypeOf("function");
    expect(vmUi.SmWorkspaceMenu).toBeTypeOf("function");
    expect(vmUi.SmByteTab).toBeTypeOf("function");
    expect(vmUi.SmRegisterAnnotation).toBeTypeOf("function");
    expect(vmUi.WorkspaceTabTypeRegistry).toBeTypeOf("function");
    expect(vmUi.defaultTabTypeRegistry).toBeInstanceOf(vmUi.WorkspaceTabTypeRegistry);
    expect(vmUi.WorkspaceLayoutModel).toBeTypeOf("function");
    // WP-71(D-MP-1 固定窗口集):窗口集绑定 + 不变量机检入面;开 / 关生命周期
    // 与「类型名 + 序号」标题退场(公共 API 面零关闭入口)。
    expect(vmUi.WorkspaceLayoutModel.prototype.bindWindows).toBeTypeOf("function");
    expect(vmUi.WorkspaceLayoutModel.prototype.focusWindow).toBeTypeOf("function");
    expect(vmUi.isWindowSetComplete).toBeTypeOf("function");
    expect(vmUi.SmWorkspace.prototype.focusWindow).toBeTypeOf("function");
    const layoutPrototype = vmUi.WorkspaceLayoutModel.prototype as unknown as Record<string, unknown>;
    const workspacePrototype = vmUi.SmWorkspace.prototype as unknown as Record<string, unknown>;
    expect(layoutPrototype["openTab"]).toBeUndefined();
    expect(layoutPrototype["closeTab"]).toBeUndefined();
    expect(workspacePrototype["openTab"]).toBeUndefined();
    expect(workspacePrototype["closeTab"]).toBeUndefined();
    expect((vmUi as unknown as Record<string, unknown>)["formatTabTitle"]).toBeUndefined();
    expect(vmUi.STACK_TAB_TYPE).toBe("stack");
    expect(vmUi.FREE_TAB_TYPE).toBe("free");
    expect(vmUi.REGISTERS_TAB_TYPE).toBe("registers");
    expect(vmUi.DEBUG_TAB_TYPE).toBe("debug");
    expect(vmUi.PAYLOAD_TAB_TYPE).toBe("payload");
  });

  it("WP-F6 payload 编译器 / 执行器 / 组件 / 积木定义派生面(WP-83 惰性化后)", async () => {
    // WP-83:Blockly 承载面(sm-payload-tab / compiler blocks / compile)不再静态
    // 再导出——静态再导出会把约 904 kB 的 Blockly 引擎放回首屏静态图(实测
    // 1,396.71 → 450.53 kB);值面改经惰性取回后判定(断言项与惰性化前逐条一致)。
    expect(vmUi.loadPayloadEngine).toBeTypeOf("function");
    expect(vmUi.PayloadStepExecutor).toBeTypeOf("function");
    expect(vmUi.createPublicEvalEnvironment).toBeTypeOf("function");
    expect(vmUi.createEmptyEvalEnvironment).toBeTypeOf("function");
    const [tabModule, compileModule, blocksModule] = await Promise.all([
      vmUi.loadPayloadEngine(),
      import("../src/payload/compiler/compile.js"),
      import("../src/payload/compiler/blocks.js"),
    ]);
    expect(tabModule.SmPayloadTab).toBeTypeOf("function");
    expect(compileModule.compilePayload).toBeTypeOf("function");
    expect(compileModule.PAYLOAD_MAX_EXPANDED_ACTIONS).toBe(256);
    expect(compileModule.PAYLOAD_MAX_CALL_DEPTH).toBe(32);
    expect(compileModule.PAYLOAD_MAX_EVAL_STEPS).toBe(4096);
    // 12 动作裁剪口径:缺省 allowedActions = 全动作 − run_to_event。
    expect(compileModule.PAYLOAD_DEFAULT_ALLOWED_ACTIONS).not.toContain("run_to_event");
    expect(compileModule.PAYLOAD_DEFAULT_ALLOWED_ACTIONS).toHaveLength(11);
    expect(blocksModule.registerPayloadBlocks).toBeTypeOf("function");
    expect(blocksModule.PAYLOAD_START_BLOCK_TYPE).toBe("payload_start");
    expect(blocksModule.PAYLOAD_TOOLBOX_CATEGORIES.length).toBeGreaterThanOrEqual(9);
  });

  it("WP-F8 调试档:调试通道客户端 / DebugDataSource / 指令视图 / ED 组件全部导出", () => {
    // 调试通道客户端与装配面(独立端点独立协议版本,ADR-DC1 条款 1)。
    expect(vmUi.DebugChannelClient).toBeTypeOf("function");
    expect(vmUi.DebugChannelClientError).toBeTypeOf("function");
    expect(vmUi.resolveDebugChannelUrl).toBeTypeOf("function");
    expect(vmUi.DEBUG_CHANNEL_PATH).toBe("/sessions/debug-channel");
    expect(vmUi.createDebugDataSource).toBeTypeOf("function");
    // 指令视图(FE-IN-01~08,调试档独有)。
    expect(vmUi.SmInstructionView).toBeTypeOf("function");
    expect(vmUi.pausedReasonText("breakpoint")).toContain("断点");
    // ED 教学组件面(WP-F9 组件 × WP-F8 挂接)。
    expect(vmUi.SmStructureView).toBeTypeOf("function");
    expect(vmUi.SmCallStack).toBeTypeOf("function");
    expect(vmUi.SmMemoryDiff).toBeTypeOf("function");
    expect(vmUi.SmTimeline).toBeTypeOf("function");
    expect(vmUi.SmCheckpoints).toBeTypeOf("function");
    expect(vmUi.SmHintLadder).toBeTypeOf("function");
    expect(vmUi.SmErrorExplainer).toBeTypeOf("function");
    expect(vmUi.buildTimeline).toBeTypeOf("function");
    expect(vmUi.computeByteDiff).toBeTypeOf("function");
    expect(vmUi.validateCheckpointLabel("x")).toBeNull();
    // ED 标签页类型键。
    expect(vmUi.STRUCTURE_TAB_TYPE).toBe("structure");
    expect(vmUi.CALL_STACK_TAB_TYPE).toBe("call-stack");
    expect(vmUi.MEMORY_DIFF_TAB_TYPE).toBe("memory-diff");
    expect(vmUi.TIMELINE_TAB_TYPE).toBe("timeline");
    expect(vmUi.CHECKPOINTS_TAB_TYPE).toBe("checkpoints");
  });
});

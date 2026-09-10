/**
 * 公开入口装配测试(WP-F2):index.ts 导出面健全性——视图 / 宿主消费的
 * 公共 API 面冻结在此(防意外漏导出 / 改名)。
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

  it("视图组件导出保留(WP-F1 面)", () => {
    expect(vmUi.SmWorkspace).toBeTypeOf("function");
  });
});

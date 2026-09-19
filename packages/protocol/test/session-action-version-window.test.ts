/**
 * 会话动作协议 v1 / v2 版本窗口契约测试(分发改版 WP-90 / D-LT-5 第 2 条)。
 *
 * 本套件把「**两版可表达、且形状按版本分离**」这件事变成契约级红灯语料:
 *
 * - **版本面**:`SESSION_ACTION_PROTOCOL_VERSION = 2`、受理集合 = `[2, 1]`
 *   (窗口期),`…/schemas/session-action/v2/` 命名空间随常量派生;
 * - **两版各自只接受本版本字面量**:v2 面拒 v1 载荷、v1 面拒 v2 载荷
 *   (服务端「版本 → Schema 注册表」按版本独立校验;合成宽松字面量会让版本
 *   判定形同虚设);
 * - **形状差异只在 create_session**:动作请求 / 传输帧在 v1 → v2 之间形状零变化,
 *   差异唯在信封 `protocolVersion` 字面量(故 v1 面是形状的冻结副本);
 * - **三份 v1 冻结面都由契约包提供**:两个服务端注册表在装配期断言「受理集合中
 *   每个版本都有已注册 Schema」,缺一即拒绝启动 ⇒ 契约包必须导出
 *   `ActionRequestV1Schema` / `WssFrameV1Schema` / `SessionCommandRequestV1Schema`
 *   (v1 fixture 目录 `action-request-v1` / `wss-frame-v1` /
 *   `session-command-request-v1` 是它们的 golden 锚点)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionRequestSchema, ActionRequestV1Schema } from "../src/session-action/action-request.js";
import { WssFrameSchema, WssFrameV1Schema } from "../src/transport/wss-frame.js";
import {
  SESSION_ACTION_PROTOCOL_PREVIOUS_VERSION,
  SESSION_ACTION_PROTOCOL_VERSION,
  SESSION_ACTION_SCHEMA_BASE_ID,
  SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS,
} from "../src/version.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures");

function loadFixture(...segments: readonly string[]): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, ...segments), "utf8")) as unknown;
}

const V1_ACTION = loadFixture("action-request-v1", "valid", "01-step-v1.json");
const V2_ACTION = loadFixture("action-request", "valid", "call.json");
const V1_FRAME = loadFixture("wss-frame-v1", "valid", "01-action-frame-v1.json");
const V2_FRAME = loadFixture("wss-frame", "valid", "01-action-frame.json");

describe("会话动作协议 v2 与 N-1 窗口(D-LT-5)", () => {
  it("版本面:v2 生效,受理集合承载 [2, 1],$id 命名空间切到 v2", () => {
    expect(SESSION_ACTION_PROTOCOL_VERSION).toBe(2);
    expect(SESSION_ACTION_PROTOCOL_PREVIOUS_VERSION).toBe(1);
    expect([...SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS]).toEqual([2, 1]);
    expect(SESSION_ACTION_SCHEMA_BASE_ID).toBe(
      "https://stackmaster.dev/schemas/session-action/v2",
    );
  });

  it("窗口期受理集合每个版本都有契约包提供的冻结 Schema(服务端装配期自检的前提)", () => {
    // 服务端(session-contract.ts / frame-contract.ts)在装配期对受理集合逐版本
    // 断言「已注册 Schema」;本断言锁的是契约包这一侧:两版都必须有导出面。
    for (const version of SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS) {
      const actionSchema = version === 2 ? ActionRequestSchema : ActionRequestV1Schema;
      const frameSchema = version === 2 ? WssFrameSchema : WssFrameV1Schema;
      expect(actionSchema.shape.protocolVersion.safeParse(version).success).toBe(true);
      // 帧信封与内层动作载荷必须同版(逐版本构造,不做跨版拼接)。
      const frame = {
        ...(V1_FRAME as Record<string, unknown>),
        protocolVersion: version,
        payload: { ...(V1_ACTION as Record<string, unknown>), protocolVersion: version },
      };
      expect(frameSchema.safeParse(frame).success).toBe(true);
    }
  });

  it("动作请求:v1 冻结面接受 v1 样例、拒绝 v2 样例;v2 面反之(形状按版本分离)", () => {
    expect(ActionRequestV1Schema.safeParse(V1_ACTION).success).toBe(true);
    expect(ActionRequestSchema.safeParse(V2_ACTION).success).toBe(true);
    expect(ActionRequestV1Schema.safeParse(V2_ACTION).success).toBe(false);
    expect(ActionRequestSchema.safeParse(V1_ACTION).success).toBe(false);
  });

  it("动作请求形状在 v1 → v2 之间零变化(差异唯在 protocolVersion 字面量)", () => {
    expect(Object.keys(ActionRequestV1Schema.shape).sort()).toEqual(
      Object.keys(ActionRequestSchema.shape).sort(),
    );
    // v1 样例只改版本字面量 ⇒ 必须被 v2 面接受(两版除版本外无形状差异)。
    const v1AsV2 = { ...(V1_ACTION as Record<string, unknown>), protocolVersion: 2 };
    expect(ActionRequestSchema.safeParse(v1AsV2).success).toBe(true);
    // v2 样例只改版本字面量(动作归一为同一动作)⇒ 必须被 v1 面接受。
    const v2AsV1 = {
      ...(V2_ACTION as Record<string, unknown>),
      protocolVersion: 1,
      action: { type: "step", args: {} },
    };
    expect(ActionRequestV1Schema.safeParse(v2AsV1).success).toBe(true);
  });

  it("传输帧:帧与内层动作载荷的版本字面量必须同版(v1 面 / v2 面各自独立)", () => {
    expect(WssFrameV1Schema.safeParse(V1_FRAME).success).toBe(true);
    expect(WssFrameSchema.safeParse(V2_FRAME).success).toBe(true);
    expect(WssFrameV1Schema.safeParse(V2_FRAME).success).toBe(false);
    expect(WssFrameSchema.safeParse(V1_FRAME).success).toBe(false);
    // 帧版本与载荷版本错位即拒(v2 帧 + v1 载荷)。
    const mixed = {
      ...(V2_FRAME as Record<string, unknown>),
      payload: { ...(V1_ACTION as Record<string, unknown>), protocolVersion: 1 },
    };
    expect(WssFrameSchema.safeParse(mixed).success).toBe(false);
  });

  it("v1 冻结面只经窗口期存在:受理集合回落为单元素时该面即应一并删除(登记性断言)", () => {
    // 本断言固定「窗口期」这一事实:若有人在窗口结束前把集合改回 [2],
    // v1 面就失去了存在理由(此测试随之失败,提醒同批删除 v1 面与常量)。
    expect(SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS).toContain(
      SESSION_ACTION_PROTOCOL_PREVIOUS_VERSION,
    );
    expect(SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS).toHaveLength(2);
  });
});

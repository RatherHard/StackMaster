/**
 * DebugFrame 契约测试(阶段四 WP-40:调试通道传输信封冻结的可测面;
 * 调试通道协议语义文档 §八,WP-1 清单 §6.8)。
 *
 * 红灯样例覆盖:未知消息类型(心跳不设应用层帧,D-API-6 同款红灯)、版本漂移
 * (连接级锚定同款自建)、type ↔ payload 错位(方向检查载体)、窗口超上限、
 * 检索模式奇数 hex、attach 缺起点、信封与载荷未知字段、序号形态。
 * 方向集测试承接嵌入协议 V-6 同纪律(互斥且完备)。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEBUG_CLIENT_TO_SERVER_TYPES,
  DEBUG_MESSAGE_TYPES,
  DEBUG_SERVER_TO_CLIENT_TYPES,
  type DebugMessageType,
  DebugFrameSchema,
} from "../src/transport/debug-frame.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "debug-frame");

interface FixtureCase {
  readonly name: string;
  readonly payload: unknown;
}

function loadFixtures(kind: "valid" | "invalid"): readonly FixtureCase[] {
  const dir = join(FIXTURE_DIR, kind);
  return readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => ({
      name: fileName,
      payload: JSON.parse(readFileSync(join(dir, fileName), "utf8")) as unknown,
    }));
}

describe("DebugFrame 契约(阶段四 WP-40)", () => {
  it.each(loadFixtures("valid"))("接受典型样例 $name", ({ payload }) => {
    expect(DebugFrameSchema.safeParse(payload).success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    expect(DebugFrameSchema.safeParse(payload).success).toBe(false);
  });

  it("消息类型恰为 12 值封闭枚举(5 请求 + 6 展示 + 1 错误;扩展 = 调试协议版本演进)", () => {
    expect([...DEBUG_MESSAGE_TYPES].sort()).toEqual(
      [
        "debug_attach",
        "debug_window",
        "debug_step",
        "debug_run_to_breakpoint",
        "debug_search",
        "debug_attached",
        "debug_window_data",
        "debug_paused",
        "debug_search_results",
        "debug_instruction_stream",
        "debug_function_table",
        "error",
      ].sort(),
    );
  });

  it("方向集互斥且完备(接收端方向检查;V-6 同纪律)", () => {
    const client = DEBUG_CLIENT_TO_SERVER_TYPES as readonly DebugMessageType[];
    const server = DEBUG_SERVER_TO_CLIENT_TYPES as readonly DebugMessageType[];
    expect([...client, ...server].sort()).toEqual([...DEBUG_MESSAGE_TYPES].sort());
    for (const type of client) {
      expect(server).not.toContain(type);
    }
  });

  it("每个帧类型至少有 1 个正例 fixture(帧族全覆盖)", () => {
    const covered = new Set<string>();
    for (const frame of loadFixtures("valid")) {
      const parsed = DebugFrameSchema.parse(frame.payload) as { type: string };
      covered.add(parsed.type);
    }
    for (const type of DEBUG_MESSAGE_TYPES) {
      expect(covered).toContain(type);
    }
  });

  it("信封字段 ⊆ 8.2 基线六字段,必选五字段恒在(requestId 可选)", () => {
    const envelopeFields = ["payload", "protocolVersion", "requestId", "seq", "sessionId", "type"];
    for (const frame of loadFixtures("valid")) {
      const parsed = DebugFrameSchema.parse(frame.payload) as Record<string, unknown>;
      const keys = Object.keys(parsed).sort();
      for (const key of keys) {
        expect(envelopeFields).toContain(key);
      }
      for (const requiredField of ["payload", "protocolVersion", "seq", "sessionId", "type"]) {
        expect(keys).toContain(requiredField);
      }
    }
  });

  it("版本常量冻结:调试通道协议版本 = 1 且受理集合为 [1](独立于会话动作协议,既有通道零改动)", async () => {
    const version = await import("../src/version.js");
    expect(version.DEBUG_CHANNEL_PROTOCOL_VERSION).toBe(1);
    expect([...version.SUPPORTED_DEBUG_CHANNEL_PROTOCOL_VERSIONS]).toEqual([1]);
    expect(version.DEBUG_SCHEMA_BASE_ID).toBe("https://stackmaster.dev/schemas/debug/v1");
    // 既有通道零改动自证:会话动作协议版本常量原值不动。
    expect(version.SESSION_ACTION_PROTOCOL_VERSION).toBe(1);
  });
});

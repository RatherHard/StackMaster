/**
 * WssFrame 契约测试(阶段三 WP-0:WSS 传输信封冻结的可测面;语义文档 §九,
 * WP-1 清单 §6.7)。
 *
 * 红灯样例覆盖:未知消息类型(心跳不设应用层帧,D-API-6 红灯)、版本不符、
 * type ↔ payload 错位、序号形态、信封篡改、会话标识缺失与字符集违规。
 * 方向集测试承接嵌入协议 V-6 同纪律(互斥且完备)。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WSS_CLIENT_TO_SERVER_TYPES,
  WSS_MESSAGE_TYPES,
  WssFrameSchema,
  WSS_SERVER_TO_CLIENT_TYPES,
  type WssMessageType,
} from "../src/transport/wss-frame.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "wss-frame");

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

describe("WssFrame 契约(阶段三 WP-0)", () => {
  it.each(loadFixtures("valid"))("接受典型样例 $name", ({ payload }) => {
    expect(WssFrameSchema.safeParse(payload).success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    expect(WssFrameSchema.safeParse(payload).success).toBe(false);
  });

  it("消息类型恰为三值封闭枚举(载荷全部复用冻结契约,零新增载荷面)", () => {
    expect([...WSS_MESSAGE_TYPES].sort()).toEqual(["action", "action_response", "error"].sort());
  });

  it("方向集互斥且完备(接收端方向检查;V-6 同纪律)", () => {
    const client = WSS_CLIENT_TO_SERVER_TYPES as readonly WssMessageType[];
    const server = WSS_SERVER_TO_CLIENT_TYPES as readonly WssMessageType[];
    for (const type of client) {
      expect(client.filter((t) => t === type)).toHaveLength(1);
    }
    expect([...client, ...server].sort()).toEqual([...WSS_MESSAGE_TYPES].sort());
    for (const type of client) {
      expect(server).not.toContain(type);
    }
  });

  it("信封字段 ⊆ 8.2 基线六字段,必选五字段恒在(requestId 可选)", () => {
    const envelopeFields = ["payload", "protocolVersion", "requestId", "seq", "sessionId", "type"];
    for (const frame of loadFixtures("valid")) {
      const parsed = WssFrameSchema.parse(frame.payload) as Record<string, unknown>;
      const keys = Object.keys(parsed).sort();
      for (const key of keys) {
        expect(envelopeFields).toContain(key);
      }
      for (const requiredField of ["payload", "protocolVersion", "seq", "sessionId", "type"]) {
        expect(keys).toContain(requiredField);
      }
    }
  });
});

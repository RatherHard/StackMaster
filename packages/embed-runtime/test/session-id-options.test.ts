/**
 * esid 生成(熵下限与编码)与构造选项解析(D-API-77 clamp / 装配拒绝)。
 */
import { describe, expect, it } from "vitest";

import {
  EmbedSessionIdSchema,
  MAX_EMBED_HEIGHT_PX,
} from "@stackmaster/protocol";

import {
  bytesToBase64Url,
  generateEmbedSessionId,
  HANDSHAKE_TIMEOUT_MS_DEFAULT,
  HELLO_MAX_RETRIES_DEFAULT,
  HEIGHT_CHANGED_MAX_PER_SECOND_DEFAULT,
  CONTROL_MESSAGE_MAX_PER_SECOND_DEFAULT,
  validateEmbedSessionId,
  VIOLATION_COUNTER_KEYS,
} from "../src/index.js";
import {
  deterministicRandomBytes,
  startHarness,
  UNAVAILABLE_REASONS,
} from "./helpers/fakes.js";
import { EmbedInvalidOptionError } from "../src/errors.js";

describe("esid 生成(session-id)", () => {
  it("16 字节 → base64url 恰 22 字符,满足协议 Schema,且多次生成互不相同", () => {
    const random = deterministicRandomBytes();
    const seen = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      const esid = generateEmbedSessionId(random);
      expect(esid).toHaveLength(22);
      expect(EmbedSessionIdSchema.safeParse(esid).success).toBe(true);
      seen.add(esid);
    }
    expect(seen.size).toBe(8);
  });

  it("bytesToBase64Url 黄金值(无填充 base64url)", () => {
    expect(bytesToBase64Url(new Uint8Array([0, 0, 0]))).toBe("AAAA");
    expect(bytesToBase64Url(new Uint8Array([255, 255, 255]))).toBe("____");
    expect(bytesToBase64Url(new Uint8Array([105]))).toBe("aQ");
    expect(bytesToBase64Url(new Uint8Array([0, 89, 0]))).toBe("AFkA");
  });

  it("validateEmbedSessionId:过短 / 非法字符集 → EmbedInvalidOptionError", () => {
    expect(() => validateEmbedSessionId("short")).toThrow(EmbedInvalidOptionError);
    expect(() => validateEmbedSessionId("A".repeat(21))).toThrow(EmbedInvalidOptionError);
    expect(() => validateEmbedSessionId(`${"A".repeat(11)}/${"A".repeat(11)}`)).toThrow(
      EmbedInvalidOptionError,
    );
    expect(validateEmbedSessionId("A".repeat(22))).toBe("A".repeat(22));
  });
});

describe("构造选项解析(D-API-77 默认值与 clamp)", () => {
  it("默认参数面:10000 / 30 / 10 / 3 / 100000 与受理集 [1]", () => {
    const h = startHarness();
    const params = h.session.getResolvedParameters();
    expect(params.handshakeTimeoutMs).toBe(HANDSHAKE_TIMEOUT_MS_DEFAULT);
    expect(params.heightChangedMaxPerSecond).toBe(HEIGHT_CHANGED_MAX_PER_SECOND_DEFAULT);
    expect(params.controlMessageMaxPerSecond).toBe(CONTROL_MESSAGE_MAX_PER_SECOND_DEFAULT);
    expect(params.helloMaxRetries).toBe(HELLO_MAX_RETRIES_DEFAULT);
    expect(params.maxHeightPx).toBe(MAX_EMBED_HEIGHT_PX);
    expect(params.supportedVersions).toEqual([1]);
    expect(params.grantableCapabilities).toEqual(["theme", "language", "auto_resize"]);
    expect(params.opaqueOrigin).toBe(false);
    h.session.dispose();
  });

  it("clamp 边界值:1–120 / 0–10 区间(D-API-77)", () => {
    const h = startHarness({
      heightChangedMaxPerSecond: 0,
      controlMessageMaxPerSecond: 999,
      helloMaxRetries: 99,
    });
    expect(h.session.getResolvedParameters().heightChangedMaxPerSecond).toBe(1);
    expect(h.session.getResolvedParameters().controlMessageMaxPerSecond).toBe(120);
    expect(h.session.getResolvedParameters().helloMaxRetries).toBe(10);
    h.session.dispose();
  });

  it("config 缺失 / pluginOrigin 缺失 → 装配拒绝", () => {
    expect(() => startHarness({ config: undefined as never })).toThrow(EmbedInvalidOptionError);
    expect(() => startHarness({ pluginOrigin: "" })).toThrow(EmbedInvalidOptionError);
  });

  it("显式 sessionId 合法值生效;能力授予集只含冻结枚举成员", () => {
    const h = startHarness({ sessionId: "explicit-session-id-22ch" });
    expect(h.session.getEmbedSessionId()).toBe("explicit-session-id-22ch");
    expect(() => startHarness({ grantableCapabilities: [" teleport" as never] })).toThrow(
      EmbedInvalidOptionError,
    );
    h.session.dispose();
  });

  it("不可用原因枚举完整(handshake-timeout / version-negotiation-failed / disposed)", () => {
    expect(UNAVAILABLE_REASONS).toEqual([
      "handshake-timeout",
      "version-negotiation-failed",
      "disposed",
    ]);
  });

  it("违规计数键与规则编号一一对应(可读出诊断面)", () => {
    expect(VIOLATION_COUNTER_KEYS).toMatchObject({
      v1OriginMismatch: "v1-origin-mismatch",
      v1pSourceMismatch: "v1p-source-mismatch",
      v2Oversized: "v2-oversized",
      v2NonJson: "v2-non-json",
      v3UnsupportedVersion: "v3-unsupported-version",
      v4SchemaInvalid: "v4-schema-invalid",
      v5SessionMismatch: "v5-session-mismatch",
      v6WrongDirection: "v6-wrong-direction",
      v7StaleSeq: "v7-stale-seq",
      v8CapabilityViolation: "v8-capability-violation",
      v10RateLimit: "v10-rate-limit",
      stateHelloAfterReady: "state-hello-after-ready",
      unavailableDrop: "unavailable-drop",
    });
  });
});

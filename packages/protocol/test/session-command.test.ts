/**
 * SessionCommandRequest / SessionCommandResponse 契约测试(阶段三 WP-0:会话级
 * 命令 Schema 冻结的可测面;语义文档 §5.1 / §九,WP-1 清单 §6.5)。
 *
 * 红灯样例覆盖:未知命令、自报身份(6.2 第 1 条:请求体零身份字段)、信封
 * 篡改、版本不符、题目版本非语义化、嵌入会话熵下限、载荷 ↔ 命令错位;响应侧:
 * SERVER_ONLY 载荷注入(seedState)、响应携带版本字段(§5.2 红灯)、裁决引用
 * 下发(SERVER_ONLY 禁令)、投影 revision 耦合(superRefine)。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SessionCommandRequestSchema,
  SESSION_COMMANDS,
} from "../src/session-command/session-command-request.js";
import { SessionCommandResponseSchema } from "../src/session-command/session-command-response.js";
import { SESSION_ACTION_PROTOCOL_VERSION } from "../src/version.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures");

interface FixtureCase {
  readonly name: string;
  readonly payload: unknown;
}

function loadFixtures(contract: string, kind: "valid" | "invalid"): readonly FixtureCase[] {
  const dir = join(FIXTURE_DIR, contract, kind);
  return readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => ({
      name: fileName,
      payload: JSON.parse(readFileSync(join(dir, fileName), "utf8")) as unknown,
    }));
}

describe("SessionCommandRequest 契约(阶段三 WP-0)", () => {
  it.each(loadFixtures("session-command-request", "valid"))(
    "接受典型样例 $name",
    ({ payload }) => {
      expect(SessionCommandRequestSchema.safeParse(payload).success).toBe(true);
    },
  );

  it.each(loadFixtures("session-command-request", "invalid"))(
    "拒绝非法样例 $name",
    ({ payload }) => {
      expect(SessionCommandRequestSchema.safeParse(payload).success).toBe(false);
    },
  );

  it("命令集恰为语义文档 §5.1 的五命令(封闭枚举,不得增删)", () => {
    expect([...SESSION_COMMANDS].sort()).toEqual(
      [
        "close_session",
        "create_session",
        "list_checkpoints",
        "submit",
        "sync_projection",
      ].sort(),
    );
  });

  it("请求信封统一携带 protocolVersion 且锚定当前协议版本(N-1 窗口由服务端双版本受理)", () => {
    expect(SESSION_ACTION_PROTOCOL_VERSION).toBe(1);
    for (const command of SESSION_COMMANDS) {
      const result = SessionCommandRequestSchema.safeParse({
        protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
        command,
        payload: command === "create_session" ? undefined : { sessionId: "s-x" },
      });
      expect(result.success).toBe(command !== "create_session");
    }
  });

  it("create_session 请求不携带任何身份字段(身份只来自认证上下文,6.2 第 1 条)", () => {
    const result = SessionCommandRequestSchema.safeParse({
      protocolVersion: 1,
      command: "create_session",
      payload: {
        challengeId: "stack-smash-101",
        challengeVersion: "1.0.0",
        embedSessionId: "3xK9mQ7pL2vN8wRtY5uB1a",
        embedToken: "token-material",
        tenantId: "tenant-A",
        userId: "user-B",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("SessionCommandResponse 契约(阶段三 WP-0)", () => {
  it.each(loadFixtures("session-command-response", "valid"))(
    "接受典型样例 $name",
    ({ payload }) => {
      expect(SessionCommandResponseSchema.safeParse(payload).success).toBe(true);
    },
  );

  it.each(loadFixtures("session-command-response", "invalid"))(
    "拒绝非法样例 $name",
    ({ payload }) => {
      expect(SessionCommandResponseSchema.safeParse(payload).success).toBe(false);
    },
  );

  it("响应不携带版本字段(§5.2:信封按请求版本解释;红灯)", () => {
    const result = SessionCommandResponseSchema.safeParse({
      protocolVersion: 1,
      command: "close_session",
      payload: { revision: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("submit 响应恰为 submissionId + revision(裁决引用 SERVER_ONLY,不下发)", () => {
    const result = SessionCommandResponseSchema.safeParse({
      command: "submit",
      payload: { submissionId: "sub-x", revision: 3, actionLog: [] },
    });
    expect(result.success).toBe(false);
  });

  it("投影 revision 与载荷 revision 耦合(superRefine;JSON Schema 结构外规则)", () => {
    const base = {
      visibleRegions: [],
      visibleRegisters: [],
      callStackSummary: [],
      controlFlow: {
        currentInstruction: { addressHex: "0x401000", text: "push rbp" },
        pausedOn: null,
      },
      semanticHighlights: [],
      status: "running",
    } as const;
    const aligned = SessionCommandResponseSchema.safeParse({
      command: "sync_projection",
      payload: { revision: 7, projection: { ...base, revision: 7 } },
    });
    const drifted = SessionCommandResponseSchema.safeParse({
      command: "sync_projection",
      payload: { revision: 7, projection: { ...base, revision: 6 } },
    });
    expect(aligned.success).toBe(true);
    expect(drifted.success).toBe(false);
  });
});

/**
 * SessionCommandRequest / SessionCommandResponse 契约测试(阶段三 WP-0:会话级
 * 命令 Schema 冻结的可测面;语义文档 §5.1 / §九,WP-1 清单 §6.5。
 * **v2 增补(分发改版 WP-90 / D-LT-5)**:create_session 载荷收为恰两键、
 * `embedToken` / `embedSessionId` 退场。
 * **N-1 窗口关闭(2026-09-19,随 WP-96)**:v1 冻结面已物理删除,受理集合回落
 * 单元素 —— 窗口期受理的形态现在必须被拒(回归机检见
 * `session-action-version-window.test.ts`);本文件另承担
 * 「`create_session` 分支 payload 是具体对象类型而非 `unknown`」的**类型层断言**
 * (D-LT-5 四·补.3 第 3 条的类型参数缺口修法的判定面)。
 *
 * 红灯样例覆盖:未知命令、自报身份(6.2 第 1 条:请求体零身份字段)、信封
 * 篡改、版本不符、题目版本非语义化、载荷 ↔ 命令错位(`embedToken` /
 * `embedSessionId` 作为多余键被拒);响应侧:SERVER_ONLY 载荷注入(seedState)、
 * 响应携带版本字段(§5.2 红灯)、裁决引用下发(SERVER_ONLY 禁令)、投影
 * revision 耦合(superRefine)。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CreateSessionRequestPayloadSchema,
  SessionCommandRequestSchema,
  SESSION_COMMANDS,
  type CreateSessionCommandPayload,
  type SessionCommandRequest,
} from "../src/session-command/session-command-request.js";
import { SessionCommandResponseSchema } from "../src/session-command/session-command-response.js";
import {
  SESSION_ACTION_PROTOCOL_VERSION,
  SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS,
} from "../src/version.js";

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

  it("请求信封统一携带 protocolVersion 且只接受本版本字面量(窗口已关闭,受理集合单元素)", () => {
    expect(SESSION_ACTION_PROTOCOL_VERSION).toBe(2);
    expect(SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS).toEqual([
      SESSION_ACTION_PROTOCOL_VERSION,
    ]);
    for (const command of SESSION_COMMANDS) {
      const result = SessionCommandRequestSchema.safeParse({
        protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
        command,
        payload: command === "create_session" ? undefined : { sessionId: "s-x" },
      });
      expect(result.success).toBe(command !== "create_session");
    }
    // 上一版本字面量(窗口期受理的 v1)现在被拒:版本判定不因窗口史而放宽。
    expect(
      SessionCommandRequestSchema.safeParse({
        protocolVersion: 1,
        command: "sync_projection",
        payload: { sessionId: "s-x" },
      }).success,
    ).toBe(false);
  });

  /**
   * **类型层断言(D-LT-5 四·补.3 第 3 条)**:`create_session` 分支的 `payload`
   * 必须是**具体对象类型**,不得退化为 `unknown`。
   *
   * 若 `sessionCommandRequestSchemaForVersion` 的形参退回 `z.ZodType`
   * (无类型参数),`payload` 即成为 `unknown` ⇒ 下面的字段读取会编译失败 ⇒
   * `pnpm --filter @stackmaster/protocol typecheck` 转红。这就是该修法的机检锚
   * (运行期断言只是陪衬:类型断言在编译期生效)。
   */
  it("类型面:create_session 分支 payload 是具体对象类型(非 unknown)", () => {
    const request: SessionCommandRequest = {
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      command: "create_session",
      payload: { challengeId: "stack-smash-101", challengeVersion: "1.0.0" },
    };
    expect(request.command).toBe("create_session");
    if (request.command === "create_session") {
      // 编译期:unknown 无法读取字段;能读到即说明类型具体。
      const challengeVersion: string = request.payload.challengeVersion;
      expect(challengeVersion).toBe("1.0.0");
      // 类型别名同款(导出面也不许退化成 unknown)。
      const typed: CreateSessionCommandPayload = request.payload;
      expect(Object.keys(typed).sort()).toEqual(["challengeId", "challengeVersion"]);
      // unknown 上做属性访问会编译失败;这里断言"具体类型上不存在的键"同样编译失败。
      // @ts-expect-error embedToken 在 v2 载荷类型上不存在(类型面即退场表达)
      void request.payload.embedToken;
    }
  });

  it("v2 create_session 载荷恰两键(challengeId / challengeVersion)", () => {
    expect(Object.keys(CreateSessionRequestPayloadSchema.shape).sort()).toEqual([
      "challengeId",
      "challengeVersion",
    ]);
  });

  it("embedToken / embedSessionId 退场:出现在载荷即被拒(strictObject)", () => {
    for (const [field, value] of [
      ["embedToken", "token-material"],
      ["embedSessionId", "3xK9mQ7pL2vN8wRtY5uB1a"],
    ] as const) {
      expect(
        SessionCommandRequestSchema.safeParse({
          protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
          command: "create_session",
          payload: {
            challengeId: "stack-smash-101",
            challengeVersion: "1.0.0",
            [field]: value,
          },
        }).success,
      ).toBe(false);
    }
  });

  it("create_session 请求不携带任何身份字段(身份只来自认证上下文,6.2 第 1 条)", () => {
    const result = SessionCommandRequestSchema.safeParse({
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      command: "create_session",
      payload: {
        challengeId: "stack-smash-101",
        challengeVersion: "1.0.0",
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

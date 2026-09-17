/**
 * 服务端可派生三类的派生口径(单元测试;WP-82)。
 *
 * 断言面:题目开始(`sessions` 创建事件)/ 通过(`verdicts` 成绩方向)/
 * 回退次数(`action_log` 的 `undo` 动作)三类逐条口径、「提示使用」无派生
 * 路径、以及采集行的零学习者标识与确定性。
 */

import { describe, expect, it } from "vitest";

import {
  COLLECTIBLE_TEACHING_EVENT_KINDS,
  TEACHING_DERIVATION_VERSION,
  deriveChallengeStartedEvents,
  derivePassedEvents,
  deriveTeachingEvents,
  deriveUndoEvents,
  digestSessionSubject,
} from "../../src/teaching/index.js";
import type {
  AuthoritativeTeachingRows,
  AuthoritativeVerdictRow,
} from "../../src/teaching/index.js";

const TENANT = "tenant-derive";
const SESSION = "sess-derive-aaaaaaaa";
const STARTED_AT = "2026-09-17T10:00:00.000Z";

function authoritativeRows(overrides: Partial<AuthoritativeTeachingRows> = {}): AuthoritativeTeachingRows {
  return {
    sessions: [
      {
        sessionId: SESSION,
        challengeId: "sm-ch01-write-basics",
        challengeVersion: "1.0.0",
        createdAt: STARTED_AT,
      },
      {
        sessionId: "sess-derive-bbbbbbbb",
        challengeId: "sm-ch03-frame-layout",
        challengeVersion: "1.0.0",
        createdAt: "2026-09-17T10:05:00.000Z",
      },
    ],
    passedVerdicts: [
      {
        verdictId: "8f14e45f-ceea-4a1e-9c1e-2b0b0a1b2c3d",
        sessionId: SESSION,
        verdict: "success",
        challengeId: "sm-ch01-write-basics",
        challengeVersion: "1.0.0",
        createdAt: "2026-09-17T10:02:30.000Z",
      },
    ],
    undos: [
      {
        actionLogId: "42",
        sessionId: SESSION,
        challengeId: "sm-ch01-write-basics",
        challengeVersion: "1.0.0",
        createdAt: "2026-09-17T10:01:00.000Z",
      },
      {
        actionLogId: "43",
        sessionId: SESSION,
        challengeId: "sm-ch01-write-basics",
        challengeVersion: "1.0.0",
        createdAt: "2026-09-17T10:01:30.000Z",
      },
    ],
    truncated: false,
    ...overrides,
  };
}

describe("题目开始(源:sessions 创建事件)", () => {
  it("每会话行恰一个事件,时刻取创建时刻、计数恒 1", () => {
    const events = deriveChallengeStartedEvents(TENANT, authoritativeRows().sessions);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "challenge_started",
      occurredAt: STARTED_AT,
      challengeId: "sm-ch01-write-basics",
      challengeVersion: "1.0.0",
      eventCount: 1,
      derivation: TEACHING_DERIVATION_VERSION,
    });
  });

  it("空权威面 ⇒ 空事件(不产生占位行)", () => {
    expect(deriveChallengeStartedEvents(TENANT, [])).toEqual([]);
  });
});

describe("通过(源:verdicts 成绩方向)", () => {
  it("只派生 success 方向;其余 10 值一律不派生(双层过滤)", () => {
    const rows: AuthoritativeVerdictRow[] = [
      {
        verdictId: "11111111-1111-4111-8111-111111111111",
        sessionId: SESSION,
        verdict: "wrong_answer",
        challengeId: "sm-ch01-write-basics",
        challengeVersion: "1.0.0",
        createdAt: STARTED_AT,
      },
      {
        verdictId: "8f14e45f-ceea-4a1e-9c1e-2b0b0a1b2c3d",
        sessionId: SESSION,
        verdict: "success",
        challengeId: "sm-ch01-write-basics",
        challengeVersion: "1.0.0",
        createdAt: STARTED_AT,
      },
    ];
    const events = derivePassedEvents(TENANT, rows);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("passed");
    expect(events[0]?.sourceRef).toBe("verdict:8f14e45f-ceea-4a1e-9c1e-2b0b0a1b2c3d");
  });

  it("题目身份取源行(会话创建时锚定的版本),非调用方推断", () => {
    const events = derivePassedEvents(TENANT, authoritativeRows().passedVerdicts);
    expect(events[0]?.challengeId).toBe("sm-ch01-write-basics");
    expect(events[0]?.challengeVersion).toBe("1.0.0");
    expect(events[0]?.occurredAt).toBe("2026-09-17T10:02:30.000Z");
  });
});

describe("回退次数(源:action_log 的 undo 动作计数)", () => {
  it("每个 undo 权威行恰一个事件(计数口径 = 已接受回退动作数)", () => {
    const events = deriveUndoEvents(TENANT, authoritativeRows().undos);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.kind)).toEqual(["undo", "undo"]);
    expect(events.map((event) => event.sourceRef)).toEqual(["action:42", "action:43"]);
    expect(events.every((event) => event.eventCount === 1)).toBe(true);
  });

  it("零 undo 动作 ⇒ 零事件(不以 0 计数行充数)", () => {
    expect(deriveUndoEvents(TENANT, [])).toEqual([]);
  });
});

describe("零学习者标识(采集行形态)", () => {
  it("会话摘要 = 64 位 hex,且不含原始会话标识(不可反解面)", () => {
    const digest = digestSessionSubject(TENANT, SESSION);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(SESSION);
    expect(digest).not.toContain(SESSION);
    expect(SESSION).not.toContain(digest);
  });

  it("同一租户同一会话摘要稳定(幂等锚的前提)", () => {
    expect(digestSessionSubject(TENANT, SESSION)).toBe(digestSessionSubject(TENANT, SESSION));
  });

  it("摘要租户作用域绑定:不同租户的同一会话 ID 摘要不同(不构成跨租户关联面)", () => {
    expect(digestSessionSubject("tenant-a", SESSION)).not.toBe(
      digestSessionSubject("tenant-b", SESSION),
    );
  });

  it("采集行不含 user_id / 原始 session_id / 租户字段,键集冻结", () => {
    const events = deriveTeachingEvents(TENANT, authoritativeRows());
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(
        [
          "challengeId",
          "challengeVersion",
          "derivation",
          "eventCount",
          "kind",
          "occurredAt",
          "sourceRef",
          "subjectDigest",
        ].sort(),
      );
    }
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain(SESSION);
    expect(serialized).not.toContain("tenant-derive");
  });

  it("源锚不含原始会话标识文本(三类前缀逐条)", () => {
    const events = deriveTeachingEvents(TENANT, authoritativeRows());
    const prefixes = new Set(events.map((event) => event.sourceRef.split(":")[0]));
    expect([...prefixes].sort()).toEqual(["action", "session", "verdict"]);
    for (const event of events) {
      expect(event.sourceRef).not.toContain(SESSION);
    }
  });
});

describe("派生确定性与种类封闭", () => {
  it("同输入两次派生逐字段相同(I-4 确定性)", () => {
    const first = deriveTeachingEvents(TENANT, authoritativeRows());
    const second = deriveTeachingEvents(TENANT, authoritativeRows());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("派生种类恒落 v1 可采集三值(hint_used 无派生路径)", () => {
    const events = deriveTeachingEvents(TENANT, authoritativeRows());
    for (const event of events) {
      expect(COLLECTIBLE_TEACHING_EVENT_KINDS as readonly string[]).toContain(event.kind);
    }
    expect(events.some((event) => (event.kind as string) === "hint_used")).toBe(false);
  });

  it("时刻非法 ⇒ 确定性失败(不静默产出错误时刻)", () => {
    expect(() =>
      deriveChallengeStartedEvents(TENANT, [
        {
          sessionId: SESSION,
          challengeId: "sm-ch01-write-basics",
          challengeVersion: "1.0.0",
          createdAt: "not-a-timestamp",
        },
      ]),
    ).toThrow(/ISO 8601/);
  });
});

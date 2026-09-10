/**
 * 端口内存实现测试(ports.ts / memory.ts;D-API-18):
 *  - TokenIssuanceStore:原子单次消费 / 吊销 / TTL;
 *  - CredentialRevocationStore:存在即拒绝 / TTL 出键;
 *  - AuditSink:append-only(不可变视图)+ 七类事件全可观察。
 */

import { describe, expect, it } from "vitest";

import {
  InMemoryAuditSink,
  InMemoryCredentialRevocationStore,
  InMemoryTokenIssuanceStore,
} from "../../src/auth/index.js";
import type { IssuedEmbedTokenRecord } from "../../src/auth/index.js";
import {
  AUDIT_EVENT_KINDS,
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_TENANT_ID,
  TEST_USER_ID,
  makeEmbedSessionId,
} from "../helpers/auth-rig.js";

/** 断言用固定时刻(epoch 毫秒)。 */
const AT = 1_725_000_000_000;

function record(overrides?: Partial<IssuedEmbedTokenRecord>): IssuedEmbedTokenRecord {
  return {
    jti: overrides?.jti ?? "jti-test-0001",
    tenantId: overrides?.tenantId ?? TEST_TENANT_ID,
    userId: overrides?.userId ?? TEST_USER_ID,
    challengeId: overrides?.challengeId ?? TEST_CHALLENGE_ID,
    challengeVersion: overrides?.challengeVersion ?? TEST_CHALLENGE_VERSION,
    embedSessionId: overrides?.embedSessionId ?? makeEmbedSessionId(),
    issuedAt: overrides?.issuedAt ?? 1000,
    expiresAt: overrides?.expiresAt ?? 61_000,
  };
}

describe("InMemoryTokenIssuanceStore", () => {
  it("put 后 consume 返回记录;同一 jti 第二次 consume 返回 null(原子单次消费)", async () => {
    const store = new InMemoryTokenIssuanceStore();
    const stored = record();
    await store.put(stored, 60);
    await expect(store.consume("jti-test-0001")).resolves.toEqual(stored);
    await expect(store.consume("jti-test-0001")).resolves.toBeNull();
  });

  it("未知 jti consume 返回 null(未签发 / 已消费 / 已吊销 / 过期同形)", async () => {
    const store = new InMemoryTokenIssuanceStore();
    await expect(store.consume("never-issued")).resolves.toBeNull();
  });

  it("revoke 删除即吊销:先 consume-able 后 null;重复 revoke 返回 false(幂等)", async () => {
    const store = new InMemoryTokenIssuanceStore();
    await store.put(record(), 60);
    await expect(store.revoke("jti-test-0001")).resolves.toBe(true);
    await expect(store.consume("jti-test-0001")).resolves.toBeNull();
    await expect(store.revoke("jti-test-0001")).resolves.toBe(false);
  });

  it("TTL 过期:注入时钟越过有效期后 consume 返回 null(自然失效)", async () => {
    let now = 1000;
    const store = new InMemoryTokenIssuanceStore({ now: () => now });
    await store.put(record({ issuedAt: now, expiresAt: now + 60_000 }), 60);
    now = 61_000; // 越过有效期(TTL 60 s 自 1000 起,61000 即死)
    await expect(store.consume("jti-test-0001")).resolves.toBeNull();
    // 未过期的记录照常消费。
    now = 62_000;
    await store.put(record({ jti: "jti-test-0002", issuedAt: now, expiresAt: now + 60_000 }), 60);
    await expect(store.consume("jti-test-0002")).resolves.toBeDefined();
  });
});

describe("InMemoryCredentialRevocationStore", () => {
  it("revoke 后 isRevoked 为 true;TTL 到期后自然出键", async () => {
    let now = 1000;
    const store = new InMemoryCredentialRevocationStore({ now: () => now });
    await store.revoke("jti-cred-1", 30);
    expect(await store.isRevoked("jti-cred-1")).toBe(true);
    now = 31_000;
    expect(await store.isRevoked("jti-cred-1")).toBe(false);
  });

  it("未吊销的 jti isRevoked 恒为 false", async () => {
    const store = new InMemoryCredentialRevocationStore();
    expect(await store.isRevoked("never-revoked")).toBe(false);
  });
});

describe("InMemoryAuditSink(append-only;审计最小写入面)", () => {
  it("七类事件全部可追加并按序可观察", async () => {
    const sink = new InMemoryAuditSink();
    const actor = { tenantId: TEST_TENANT_ID, userId: TEST_USER_ID };
    for (const kind of AUDIT_EVENT_KINDS) {
      await sink.append({ kind, at: AT, actor, detail: { seq: sink.size } });
    }
    const events = sink.snapshot();
    expect(events.map((event) => event.kind)).toEqual([...AUDIT_EVENT_KINDS]);
    expect(events.every((event) => event.at === AT)).toBe(true);
    expect(sink.size).toBe(AUDIT_EVENT_KINDS.length);
  });

  it("append-only:快照为不可变视图(深冻结),变更尝试抛 TypeError,且不影响后续追加", async () => {
    const sink = new InMemoryAuditSink();
    const actor = { tenantId: TEST_TENANT_ID, userId: TEST_USER_ID };
    await sink.append({ kind: "create_session", at: AT, actor, sessionId: "sess-1", detail: { k: "v" } });
    const snapshot = sink.snapshot();

    expect(() => {
      (snapshot as unknown as { push(event: unknown): unknown }).push({
        kind: "submit",
        at: AT,
        actor,
      });
    }).toThrow(TypeError);
    const first = snapshot[0];
    expect(first).toBeDefined();
    expect(() => {
      (first as { at: number }).at = 0;
    }).toThrow(TypeError);
    const detail = first?.detail;
    expect(detail).toBeDefined();
    expect(() => {
      (detail as { k: string }).k = "tampered";
    }).toThrow(TypeError);

    // 追加端口没有更新 / 删除形态:事件数只增不减。
    await sink.append({ kind: "submit", at: AT, actor, sessionId: "sess-1" });
    expect(sink.size).toBe(2);
  });

  it("detail 只承载非秘密标量(类型面约束;零凭证材料语料)", async () => {
    const sink = new InMemoryAuditSink();
    await sink.append({
      kind: "embed_token_issued",
      at: AT,
      actor: { tenantId: TEST_TENANT_ID, userId: TEST_USER_ID },
      detail: { jti: "jti-1", ttlSeconds: 3600, challengeVersion: "1.2.3" },
    });
    const raw = JSON.stringify(sink.snapshot());
    // 值级语料检查:不允许出现任何 token / 签名材料形态(JWT 三段结构)。
    expect(raw).not.toMatch(/ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  });
});

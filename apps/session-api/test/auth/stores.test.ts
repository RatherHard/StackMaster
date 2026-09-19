/**
 * 端口内存实现测试(ports.ts / memory.ts;D-API-18):
 *  - LaunchGrantStore:原子单次消费(取删一体)/ TTL 自然失效;
 *  - CredentialRevocationStore:存在即拒绝 / TTL 出键;
 *  - AuditSink:append-only(不可变视图)+ 冻结十值全可观察。
 *
 * **2026-09-19(WP-96)**:`InMemoryTokenIssuanceStore`(embed token 签发记录,
 * 键域 `token:{jti}`)已随嵌入协议面**物理删除** ⇒ 原 `describe` 块的五个
 * 用例整体**改为启动授权凭证内存实现**(`InMemoryLaunchGrantStore`):被测
 * 端口语义(取删一体的原子单次消费 / 未知 jti 同形返回 null / TTL 自然失效 /
 * 记录副本隔离)逐条同构且逐条保留。唯一**删除**的是"`revoke` 删除即吊销"
 * 用例 —— 授权凭证的记录面**没有** `revoke` 方法(该端口形状只有 put /
 * consume,D-LT-5 5a;吊销语义在本族不存在,故该用例失去被测对象)。
 */

import { describe, expect, it } from "vitest";

import {
  InMemoryAuditSink,
  InMemoryCredentialRevocationStore,
  InMemoryLaunchGrantStore,
} from "../../src/auth/index.js";
import type { IssuedLaunchGrantRecord } from "../../src/auth/index.js";
import {
  AUDIT_EVENT_KINDS,
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_TENANT_ID,
  TEST_USER_ID,
} from "../helpers/auth-rig.js";

/** 断言用固定时刻(epoch 毫秒)。 */
const AT = 1_725_000_000_000;

function record(overrides?: Partial<IssuedLaunchGrantRecord>): IssuedLaunchGrantRecord {
  return {
    jti: overrides?.jti ?? "jti-test-0001",
    tenantId: overrides?.tenantId ?? TEST_TENANT_ID,
    userId: overrides?.userId ?? TEST_USER_ID,
    challengeId: overrides?.challengeId ?? TEST_CHALLENGE_ID,
    challengeVersion: overrides?.challengeVersion ?? TEST_CHALLENGE_VERSION,
    issuedAt: overrides?.issuedAt ?? 1000,
    expiresAt: overrides?.expiresAt ?? 61_000,
  };
}

describe("InMemoryLaunchGrantStore", () => {
  it("put 后 consume 返回记录;同一 jti 第二次 consume 返回 null(原子单次消费)", async () => {
    const store = new InMemoryLaunchGrantStore();
    const stored = record();
    await store.put(stored, 60);
    await expect(store.consume("jti-test-0001")).resolves.toEqual(stored);
    await expect(store.consume("jti-test-0001")).resolves.toBeNull();
  });

  it("未知 jti consume 返回 null(未签发 / 已消费 / 已过期同形)", async () => {
    const store = new InMemoryLaunchGrantStore();
    await expect(store.consume("never-issued")).resolves.toBeNull();
  });

  it("存储副本隔离:调用方持有的引用后续变更不影响已写入的签发记录", async () => {
    const store = new InMemoryLaunchGrantStore();
    const stored = record();
    await store.put(stored, 60);
    // 篡改调用方引用(记录面的权威锚 = 存储内的副本)。
    (stored as { tenantId: string }).tenantId = "tenant-other";
    const consumed = await store.consume("jti-test-0001");
    expect(consumed?.tenantId).toBe(TEST_TENANT_ID);
  });

  it("TTL 过期:注入时钟越过有效期后 consume 返回 null(自然失效)", async () => {
    let now = 1000;
    const store = new InMemoryLaunchGrantStore({ now: () => now });
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
  it("冻结十值事件全部可追加并按序可观察", async () => {
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
    // 用**活跃**写入方的 kind(create_session);`embed_token_issued` 属冻结集合
    // 但现无写入方(2026-09-19 随 WP-96),detail 纪律与 kind 无关。
    await sink.append({
      kind: "create_session",
      at: AT,
      actor: { tenantId: TEST_TENANT_ID, userId: TEST_USER_ID },
      detail: { jti: "jti-1", ttlSeconds: 3600, challengeVersion: "1.2.3" },
    });
    const raw = JSON.stringify(sink.snapshot());
    // 值级语料检查:不允许出现任何 token / 签名材料形态(JWT 三段结构)。
    expect(raw).not.toMatch(/ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  });
});

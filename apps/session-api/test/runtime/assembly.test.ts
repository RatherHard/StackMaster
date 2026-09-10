/**
 * 运行时装配面单元测试:
 *  - Redis token 存储薄适配器(KeyValueStore → WP-2 端口;D-API-33):
 *    原子单次消费仲裁、删除即吊销、吊销键域、损坏载荷 fail-closed;
 *  - clientSeq 单会话预算(协议 §4.4):触顶确定性拒绝;
 *  - checkpoint 恢复点落库钩子(显式 checkpoint 触发;密文静止断言)。
 *
 * 适配器载体用内存 KeyValueStore(与 RedisKeyValueStore 的 GETDEL 语义
 * 同构:deleteIfPresent = 原子取删);Redis 载体本身由 WP-3 集成测试覆盖。
 */
import { describe, expect, it } from "vitest";

import {
  KeyValueCredentialRevocationStore,
  KeyValueTokenIssuanceStore,
} from "../../src/runtime/redis-token-stores.js";
import { MemoryKeyValueStore } from "../../src/persistence/index.js";
import { TEST_TENANT_ID, buildSessionTestRig } from "../routes/helpers/session-rig.js";
import type { IssuedEmbedTokenRecord } from "../../src/auth/ports.js";

const record: IssuedEmbedTokenRecord = {
  jti: "jti-0001",
  tenantId: "tenant-alpha",
  userId: "user-42",
  challengeId: "chal-stack-escape",
  challengeVersion: "1.2.3",
  embedSessionId: "embed-session-0001",
  issuedAt: 1_000,
  expiresAt: 61_000,
};

describe("KeyValueTokenIssuanceStore(原子单次消费,D-API-18/33)", () => {
  it("put → consume 返回记录;再次 consume 返回 null(单次语义)", async () => {
    const kv = new MemoryKeyValueStore();
    const store = new KeyValueTokenIssuanceStore(kv);
    await store.put(record, 60);
    expect(await store.consume(record.jti)).toEqual(record);
    expect(await store.consume(record.jti)).toBeNull();
  });

  it("consume 的原子仲裁:删除失败(并发抢先)即 null,不得退化为读后删", async () => {
    const kv = new MemoryKeyValueStore();
    const store = new KeyValueTokenIssuanceStore(kv);
    await store.put(record, 60);
    // 模拟并发方抢先 GETDEL:deleteIfPresent 被外部调用后,本方必须 null。
    expect(await kv.deleteIfPresent(`token:${record.jti}`)).toBe(true);
    await store.put(record, 60);
    const first = await store.consume(record.jti);
    expect(first).toEqual(record);
    // 键域命名:token:{jti}(与 WP-2 端口语义同键名)。
    expect(await kv.get(`token:${record.jti}`)).toBeNull();
  });

  it("revoke(删除即吊销):吊销后 consume 为 null;返回是否确有删除(幂等)", async () => {
    const kv = new MemoryKeyValueStore();
    const store = new KeyValueTokenIssuanceStore(kv);
    await store.put(record, 60);
    expect(await store.revoke(record.jti)).toBe(true);
    expect(await store.revoke(record.jti)).toBe(false);
    expect(await store.consume(record.jti)).toBeNull();
  });

  it("存储载荷损坏:按'无有效记录'处理(fail-closed,拒绝消费)", async () => {
    const kv = new MemoryKeyValueStore();
    const store = new KeyValueTokenIssuanceStore(kv);
    await kv.set(`token:${record.jti}`, "{not-json", 60);
    expect(await store.consume(record.jti)).toBeNull();
    await kv.set(`token:${record.jti}`, JSON.stringify({ jti: record.jti }), 60);
    expect(await store.consume(record.jti)).toBeNull();
  });

  it("TTL 过期:consume 返回 null(记录自然失效)", async () => {
    let nowMs = 1_000;
    const kv = new MemoryKeyValueStore(() => nowMs);
    const store = new KeyValueTokenIssuanceStore(kv);
    await store.put(record, 60);
    nowMs += 61_000;
    expect(await store.consume(record.jti)).toBeNull();
  });
});

describe("KeyValueCredentialRevocationStore(会话凭证吊销键域)", () => {
  it("revoke → isRevoked true;未吊销 / TTL 过期 → false", async () => {
    let nowMs = 1_000;
    const kv = new MemoryKeyValueStore(() => nowMs);
    const store = new KeyValueCredentialRevocationStore(kv);
    expect(await store.isRevoked("jti-x")).toBe(false);
    await store.revoke("jti-x", 60);
    expect(await store.isRevoked("jti-x")).toBe(true);
    nowMs += 61_000;
    expect(await store.isRevoked("jti-x")).toBe(false);
  });
});

describe("clientSeq 单会话预算(协议 §4.4;触顶确定性拒绝)", () => {
  it("预算内动作照常执行;触顶后确定性拒绝,恢复路径 = 重新 create_session", async () => {
    const rig = await buildSessionTestRig({ env: { SESSION_API_MAX_CLIENT_SEQ_PER_SESSION: "2" } });
    await rig.registerChallenge();
    const issued = await rig.issueEmbedToken();
    const created = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        command: "create_session",
        protocolVersion: 1,
        payload: {
          challengeId: "chal-stack-escape",
          challengeVersion: "1.2.3",
          embedSessionId: issued.claims.embedSessionId,
          embedToken: issued.token,
        },
      },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = (created.json() as { payload: { sessionId: string } }).payload.sessionId;
    const action = {
      type: "write_bytes",
      args: { addressHex: "0x7FFFF000", bytesHex: "deadbeef" },
    } as const;

    expect((await rig.manager.applyAction(sessionId, TEST_TENANT_ID, action)).revision).toBe(1);
    expect((await rig.manager.applyAction(sessionId, TEST_TENANT_ID, action)).revision).toBe(2);

    let first: unknown;
    let second: unknown;
    try {
      await rig.manager.applyAction(sessionId, TEST_TENANT_ID, action);
      expect.unreachable("触顶必须确定性拒绝");
    } catch (error) {
      first = error;
    }
    try {
      await rig.manager.applyAction(sessionId, TEST_TENANT_ID, action);
      expect.unreachable("触顶后的一切请求继续确定性拒绝");
    } catch (error) {
      second = error;
    }
    expect((first as Error).name).toBe("ClientSeqBudgetExhausted");
    expect((second as Error).name).toBe("ClientSeqBudgetExhausted");
    expect((first as Error).message).toBe((second as Error).message);
    // 恢复路径:重新 create_session(jti 单次消费,新 token)→ 预算重置。
    const reissued = await rig.issueEmbedToken();
    const recreated = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        command: "create_session",
        protocolVersion: 1,
        payload: {
          challengeId: "chal-stack-escape",
          challengeVersion: "1.2.3",
          embedSessionId: reissued.claims.embedSessionId,
          embedToken: reissued.token,
        },
      },
    });
    expect(recreated.statusCode).toBe(201);
  });
});

describe("checkpoint 恢复点落库钩子(显式 checkpoint 触发;D-API-25)", () => {
  it("create_checkpoint 接受回执 → 密文落库 + 快照锚推进;幂等去重", async () => {
    const rig = await buildSessionTestRig();
    await rig.registerChallenge();
    const issued = await rig.issueEmbedToken();
    const created = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        command: "create_session",
        protocolVersion: 1,
        payload: {
          challengeId: "chal-stack-escape",
          challengeVersion: "1.2.3",
          embedSessionId: issued.claims.embedSessionId,
          embedToken: issued.token,
        },
      },
    });
    const sessionId = (created.json() as { payload: { sessionId: string } }).payload.sessionId;

    await rig.manager.applyAction(sessionId, TEST_TENANT_ID, {
      type: "create_checkpoint",
      args: { label: "cp-1" },
    });
    const rows = await rig.snapshots.listBySession(sessionId, TEST_TENANT_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin).toBe("explicit_checkpoint");
    expect(rows[0]?.checkpointId).toBe("fake-checkpoint-1");
    // 密文静止:落库 blob 以 SMEN 魔数起始(明文零驻留)。
    const blob = rows[0]?.ciphertext;
    expect([blob?.[0], blob?.[1], blob?.[2], blob?.[3]]).toEqual([0x53, 0x4d, 0x45, 0x4e]);
    // 明文语料扫描零命中(密文断言的存储面锚点)。
    const raw = Buffer.from(blob ?? []).toString("latin1");
    expect(raw).not.toContain("checkpoint");
    // 快照锚推进(sessions 行)。
    const row = await rig.sessions.findSession(sessionId, TEST_TENANT_ID);
    expect(row?.latestSnapshotId).toBe(rows[0]?.id);

    // 停机冲刷幂等:已落库恢复点不重复落库(flushAll 去重)。
    await rig.manager.flushAll();
    expect(await rig.snapshots.listBySession(sessionId, TEST_TENANT_ID)).toHaveLength(1);
  });
});

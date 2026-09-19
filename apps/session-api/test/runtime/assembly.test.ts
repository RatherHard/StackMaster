/**
 * 运行时装配面单元测试:
 *  - Redis 凭证吊销薄适配器(KeyValueStore → WP-2 端口;D-API-33):
 *    吊销键域、删除即吊销、过期即失活;
 *    **2026-09-19(WP-96)**:`KeyValueTokenIssuanceStore` 与
 *    `IssuedEmbedTokenRecord` 随嵌入协议面**物理删除**,故其
 *    「原子单次消费」describe 块同批移除 —— 单次消费语义现由启动授权凭证
 *    端口(`launchGrant:{jti}`)承载;
 *  - clientSeq 单会话预算(协议 §4.4):触顶确定性拒绝;
 *  - checkpoint 恢复点落库钩子(显式 checkpoint 触发;密文静止断言)。
 *
 * 适配器载体用内存 KeyValueStore(与 RedisKeyValueStore 的 GETDEL 语义
 * 同构:deleteIfPresent = 原子取删);Redis 载体本身由 WP-3 集成测试覆盖。
 */
import { describe, expect, it } from "vitest";

import { KeyValueCredentialRevocationStore } from "../../src/runtime/redis-token-stores.js";
import { MemoryKeyValueStore } from "../../src/persistence/index.js";
import { TEST_TENANT_ID, buildSessionTestRig } from "../routes/helpers/session-rig.js";

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
    const { response: created, sessionId } = await rig.createSession();
    expect(created.statusCode).toBe(201);
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
    // 恢复路径:重新 create_session(启动授权凭证 jti 单次消费,新凭证)→ 预算重置。
    const recreated = await rig.createSession();
    expect(recreated.response.statusCode).toBe(201);
  });
});

describe("checkpoint 恢复点落库钩子(显式 checkpoint 触发;D-API-25)", () => {
  it("create_checkpoint 接受回执 → 密文落库 + 快照锚推进;幂等去重", async () => {
    const rig = await buildSessionTestRig();
    await rig.registerChallenge();
    const { sessionId } = await rig.createSession();

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

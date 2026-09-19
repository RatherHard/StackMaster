/**
 * 启动票据存储端口的内存同构实现(WP-91;D-LT-2「绑定 / 单次消费 / 有效期」行)。
 *
 * 机检 ④「单次消费原子性」的**内存替身**版(真实 Redis 版见
 * `test/persistence/redis.integration.test.ts`,容器门控)。两版都必须在场:
 * 内存版证明**端口语义**,真机版证明 **Lua 在 Redis 执行模型下的原子性** ——
 * 后者不可被任何 TS 假实现替代。
 *
 * 本文件同时钉死两个**非直觉但关键**的语义:
 *  1. **绑定不符不消费**(无副作用)——否则拿到票据的人故意用错 URL 打开一次
 *     即可把合法持有者的票据烧掉(可用性攻击面);
 *  2. **四种「无有效记录」形态同形返回 null** —— 未签发 / 已消费 / 已过期 /
 *     绑定不符。响应面要求三态**逐字节一致**(D-LT-2「换票路由」行),
 *     端口面若区分它们就等于把枚举信号泄漏给攻击者(安全红线 9.2)。
 */

import { describe, expect, it } from "vitest";
import {
  MemoryLaunchTicketStore,
  PersistenceError,
  REDIS_DEGRADE_POLICY,
} from "../../src/persistence/index.js";
import type { LaunchTicketBinding } from "../../src/persistence/index.js";

/** 可控应用时钟(毫秒纪元;与 MemoryLaunchTicketStore 的 Clock 口径一致)。 */
function fixedClock(startSeconds: number): { now: () => number; advance: (s: number) => void } {
  let currentMs = startSeconds * 1000;
  return {
    now: () => currentMs,
    advance: (seconds: number) => {
      currentMs += seconds * 1000;
    },
  };
}

const TENANT = "tenant-alpha";
const CHALLENGE = "ch-stack-frame";
const VERSION = "1.2.0";

function binding(expiresAt: number, overrides: Partial<LaunchTicketBinding> = {}): LaunchTicketBinding {
  return { tenantId: TENANT, challengeId: CHALLENGE, version: VERSION, expiresAt, ...overrides };
}

describe("MemoryLaunchTicketStore(端口语义的参考实现)", () => {
  it("签发 → 换票:取回**完整绑定**,租户来自记录而非 URL", async () => {
    const clock = fixedClock(1_800_000_000);
    const store = new MemoryLaunchTicketStore(clock.now);
    const expiresAt = 1_800_000_000 + 300;
    await store.put("tok-happy", binding(expiresAt), 300);

    const redeemed = await store.consume("tok-happy", { challengeId: CHALLENGE, version: VERSION });
    expect(redeemed).toEqual(binding(expiresAt));
    // ★ tenantId **只能**从记录取回 —— 换票入参里根本没有这个字段
    //   (LaunchTicketRedemptionKey 恰两键),这是 6.2「身份不由 URL / body
    //   派生」在类型层的结构性表达。
    expect(redeemed?.tenantId).toBe(TENANT);
  });

  it("绑定不符 ⇒ 返回 null 且**不消费**(票据仍在,合法持有者随后可正常换票)", async () => {
    const clock = fixedClock(1_800_000_000);
    const store = new MemoryLaunchTicketStore(clock.now);
    await store.put("tok-binding", binding(1_800_000_300), 300);

    expect(await store.consume("tok-binding", { challengeId: "ch-other", version: VERSION })).toBeNull();
    expect(await store.consume("tok-binding", { challengeId: CHALLENGE, version: "9.9.9" })).toBeNull();
    expect(await store.consume("tok-binding", { challengeId: "ch-other", version: "9.9.9" })).toBeNull();

    // ★ 三次错配之后票据**依然有效**(这是可用性保护,不是宽松)。
    expect(await store.consume("tok-binding", { challengeId: CHALLENGE, version: VERSION })).not.toBeNull();
    // 正确消费之后才真的失效。
    expect(await store.consume("tok-binding", { challengeId: CHALLENGE, version: VERSION })).toBeNull();
  });

  it("单次消费:第二次换票与「不存在」同形返回 null(不幂等,D-LT-2「幂等」行)", async () => {
    const clock = fixedClock(1_800_000_000);
    const store = new MemoryLaunchTicketStore(clock.now);
    await store.put("tok-once", binding(1_800_000_300), 300);
    expect(await store.consume("tok-once", { challengeId: CHALLENGE, version: VERSION })).not.toBeNull();
    expect(await store.consume("tok-once", { challengeId: CHALLENGE, version: VERSION })).toBeNull();
  });

  it("TTL 到期 ⇒ 与「不存在」同形返回 null", async () => {
    const clock = fixedClock(1_800_000_000);
    const store = new MemoryLaunchTicketStore(clock.now);
    await store.put("tok-ttl", binding(1_800_000_300), 300);

    clock.advance(299);
    expect(await store.consume("tok-ttl", { challengeId: CHALLENGE, version: VERSION })).not.toBeNull();

    await store.put("tok-ttl2", binding(1_800_000_300), 300);
    clock.advance(301); // 越过 TTL
    expect(await store.consume("tok-ttl2", { challengeId: CHALLENGE, version: VERSION })).toBeNull();
  });

  it("★ 机检 ④:并发两次换票**恰一次**成功(单次消费原子性)", async () => {
    const clock = fixedClock(1_800_000_000);
    const store = new MemoryLaunchTicketStore(clock.now);
    const expected = binding(1_800_000_300);
    await store.put("tok-race", expected, 300);

    const results = await Promise.all([
      store.consume("tok-race", { challengeId: CHALLENGE, version: VERSION }),
      store.consume("tok-race", { challengeId: CHALLENGE, version: VERSION }),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.find((r) => r !== null)).toEqual(expected);
  });

  it("★ 机检 ④(放大):32 路并发换票仍**恰一次**成功", async () => {
    const clock = fixedClock(1_800_000_000);
    const store = new MemoryLaunchTicketStore(clock.now);
    await store.put("tok-race-32", binding(1_800_000_300), 300);

    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        store.consume("tok-race-32", { challengeId: CHALLENGE, version: VERSION }),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("原子性有**结构性护栏**:consume 不得是 async 等待点(否则并发保护静默失效)", () => {
    // 内存替身的原子性来自"consume 体内没有 await ⇒ 事件循环上串行"。一旦
    // 有人在 consume 里插入 await,保护即失效而测试仍可能是绿的(取决于调度)。
    // 这条断言把该前提变成**机器可检的红线**。
    //
    // 注释先剥离:本护栏约束的是**可执行代码**,而中文注释里为了说明这条纪律
    // 必然会出现 await 这个词(首次运行实测即被自己的文档判红 —— 真实踩过的坑,
    // 保留说明以免后人再踩)。剥离器本身用**合成输入**自检,不耦合源码注释。
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    // 剥离器自检一:注释里的 await 被剥掉(否则本护栏恒假红)。
    expect(stripComments("async f() { /* await x */ return 1; }")).not.toMatch(/\bawait\b/);
    // 剥离器自检二:真实代码里的 await **不会**被剥掉(否则本护栏恒真绿 ——
    // 那比假红更危险:它会静默地不再保护任何东西)。
    expect(stripComments("async f() { await g(); }")).toMatch(/\bawait\b/);

    expect(stripComments(MemoryLaunchTicketStore.prototype.consume.toString())).not.toMatch(/\bawait\b/);
  });

  it("未签发的票据 ⇒ null(与已消费 / 已过期同形)", async () => {
    const clock = fixedClock(1_800_000_000);
    const store = new MemoryLaunchTicketStore(clock.now);
    expect(await store.consume("tok-never", { challengeId: CHALLENGE, version: VERSION })).toBeNull();
  });

  it("TTL 非正数 ⇒ PersistenceError(invalid_identifier;键域全部带 TTL 纪律)", async () => {
    const clock = fixedClock(1_800_000_000);
    const store = new MemoryLaunchTicketStore(clock.now);
    await expect(store.put("tok-badttl", binding(1_800_000_300), 0)).rejects.toBeInstanceOf(PersistenceError);
    await expect(store.put("tok-badttl", binding(1_800_000_300), -1)).rejects.toBeInstanceOf(PersistenceError);
    await expect(store.put("tok-badttl", binding(1_800_000_300), Number.NaN)).rejects.toBeInstanceOf(
      PersistenceError,
    );
  });

  it("跨租户隔离由记录携带:同 challengeId / version 的两张票按各自记录取回各自租户", async () => {
    const clock = fixedClock(1_800_000_000);
    const store = new MemoryLaunchTicketStore(clock.now);
    await store.put("tok-a", binding(1_800_000_300, { tenantId: "tenant-alpha" }), 300);
    await store.put("tok-b", binding(1_800_000_300, { tenantId: "tenant-beta" }), 300);
    expect((await store.consume("tok-a", { challengeId: CHALLENGE, version: VERSION }))?.tenantId).toBe(
      "tenant-alpha",
    );
    expect((await store.consume("tok-b", { challengeId: CHALLENGE, version: VERSION }))?.tenantId).toBe(
      "tenant-beta",
    );
  });
});

describe("launch:{jti} 键域的分级登记(D-API-24 策略表)", () => {
  it("fail-closed:Redis 不可用即 503,不降级进程内、不静默放行", () => {
    expect(REDIS_DEGRADE_POLICY.launchTicketStore.degrade).toBe("fail-closed");
    // 理由必须写清"为什么不能降级"(策略表即文档;空理由等于没有裁决记录)。
    expect(REDIS_DEGRADE_POLICY.launchTicketStore.rationale).toContain("重放防线");
    // 既有四条分级的取值不被本 WP 改动(回归护栏)。
    expect(REDIS_DEGRADE_POLICY.idempotencyWindow.degrade).toBe("degrade-to-process");
    expect(REDIS_DEGRADE_POLICY.tokenStore.degrade).toBe("fail-closed");
    expect(REDIS_DEGRADE_POLICY.routeStore.degrade).toBe("fail-closed");
    expect(REDIS_DEGRADE_POLICY.rateLimitCounter.degrade).toBe("fail-closed");
  });
});

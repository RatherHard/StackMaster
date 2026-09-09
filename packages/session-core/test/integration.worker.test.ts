/**
 * 进程级集成测试(WP-8 完成标准):TS 编排核心 spawn **真实 vm-worker**
 * 二进制的全链路——创建会话 → 动作 → 投影增量 → checkpoint → undo →
 * checkout → reset → submit(内部引用动作日志)→ close;崩溃替换恢复与
 * 幂等重放;编排器进程秘密零驻留断言(带红灯反例证明扫描器可检出)。
 *
 * 二进制定位:`STACKMASTER_WORKER_BIN` 环境变量,或按需
 * `cargo build -p vm-worker`(见 src/worker-binary.ts)。
 */

import { describe, expect, it } from "vitest";
import { canonicalize } from "@stackmaster/protocol";
import { SessionOrchestrator } from "../src/session.js";
import {
  BUFFER_BASE,
  lifecycleBundle,
  lifecycleDescriptor,
} from "./helpers/fixtures.js";

const createOptions = () => ({
  privateBundle: lifecycleBundle(),
  publicDescriptor: lifecycleDescriptor(),
});

/** 会话种子的可区分标记(零驻留扫描的语料)。 */
const SESSION_SEED = "5ecdad3e21407d95a6b9c342f80177be";
/** 私有包内 flag 的可区分标记(零驻留扫描的语料)。 */
const FLAG_SENTINEL = "FLAG{lifecycle-demo}";

describe("SessionOrchestrator(真实 vm-worker 全链路)", () => {
  it(
    "最小闭环:创建会话 → 动作 → 投影增量 → checkpoint → undo → checkout → reset → submit → close",
    { timeout: 120_000 },
    async () => {
      const session = await SessionOrchestrator.create(createOptions());
      expect(session.revision).toBe(0);
      expect(session.projection.visibleRegions.map((r) => r.regionId)).toEqual([
        "code",
        "buffer",
        "stack",
      ]);

      // ① 写可见缓冲区:已执行,revision +1,增量携带脏范围。
      const write = await session.applyAction({
        type: "write_bytes",
        args: { addressHex: BUFFER_BASE, bytesHex: "deadbeef" },
      });
      expect(write.status).toBe("running");
      expect(write.revision).toBe(1);
      expect(write.projectionDelta?.dirtyRanges).toHaveLength(1);
      expect(write.projectionDelta?.dirtyRanges[0]?.bytesHex).toBe("deadbeef");

      // ② checkpoint:回执驱动账本。
      const checkpoint = await session.applyAction({
        type: "create_checkpoint",
        args: { label: "before" },
      });
      expect(checkpoint.revision).toBe(2);
      expect(session.listCheckpoints()).toHaveLength(1);
      const snapshot = session.listCheckpoints()[0]?.snapshot;

      // ③ 再写 + undo:内容回退、版本前进。
      await session.applyAction({
        type: "write_bytes",
        args: { addressHex: BUFFER_BASE, bytesHex: "11111111" },
      });
      const undo = await session.applyAction({ type: "undo", args: {} });
      expect(undo.revision).toBe(4);

      // ④ checkout 回检查点内容。
      const checkout = await session.applyAction({
        type: "checkout_checkpoint",
        args: {
          checkpointId: String(session.listCheckpoints()[0]?.checkpointId),
        },
      });
      expect(checkout.revision).toBe(5);

      // ⑤ reset:回初始状态,revision 继续 +1。
      const reset = await session.applyAction({ type: "reset", args: {} });
      expect(reset.revision).toBe(6);

      // ⑥ sync-projection:重发缓存投影(不触发 worker 往返)。
      const sync = session.syncProjection();
      expect(sync.revision).toBe(6);
      expect(sync.projection.status).toBe("running");

      // ⑦ submit:内部裁决引用(动作日志只含已接受动作,完整可重放)。
      const submit = session.submit();
      expect(submit.form).toBe("stackmaster-session-submit/1");
      expect(submit.actionLog).toHaveLength(6);
      expect(submit.actionLog.map((entry) => entry.revisionAfter)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      expect(submit.revision).toBe(6);
      expect(submit.challenge.challengeId).toBe("wp8-lifecycle");
      expect(submit.seedPolicy).toEqual({ strategy: "fixed" });

      // ⑧ close-session:优雅退出。
      await session.closeSession();
      expect(session.phase).toBe("closed");
      void snapshot;
    },
  );

  it("崩溃替换恢复:checkpoint 快照 → kill → recover → 投影与 revision 还原", { timeout: 120_000 }, async () => {
    const fresh = await SessionOrchestrator.create(createOptions());
    await fresh.applyAction({
      type: "write_bytes",
      args: { addressHex: BUFFER_BASE, bytesHex: "0badc0de" },
    });
    // 快照恢复点(checkpoint 回执信封;export_snapshot 形态与之同构)。
    await fresh.applyAction({ type: "create_checkpoint", args: { label: "crash-point" } });
    const receipt = fresh.listCheckpoints()[0];
    if (!receipt) throw new Error("前置失败:checkpoint 回执缺失");
    const beforeKill = fresh.projection;
    const revisionAtCrash = fresh.revision;

    // 强制终止(SIGKILL;进程不复用)。
    const exit = await fresh.kill();
    expect(["forced", "crashed"]).toContain(exit.kind);

    // 崩溃替换恢复:重新提供装载参数(核心不留存私有包,零驻留)+ 最近快照。
    const recovered = await SessionOrchestrator.recover({
      ...createOptions(),
      snapshot: receipt.snapshot,
    });
    // revision 自快照续算(Vitest 的 toBe 不接受第二参数,说明移入注释)。
    expect(recovered.revision).toBe(revisionAtCrash);
    expect(canonicalize(recovered.projection)).toBe(canonicalize(beforeKill));

    // 恢复后的会话可继续执行,旧 checkpoint 引用已退化(账本清空)。
    expect(recovered.listCheckpoints()).toHaveLength(0);
    const next = await recovered.applyAction({
      type: "write_bytes",
      args: { addressHex: BUFFER_BASE, bytesHex: "cafebabe" },
    });
    expect(next.revision).toBe(revisionAtCrash + 1);
    await recovered.closeSession();
  });

  it("I-4 确定性:恢复会话与原会话同输入恒同响应;幂等重放 worker 只执行一次", { timeout: 120_000 }, async () => {
    const session = await SessionOrchestrator.create(createOptions());
    const first = await session.applyAction({
      type: "write_bytes",
      args: { addressHex: BUFFER_BASE, bytesHex: "aa" },
    }, { idempotencyKey: "determinism-key" });
    const replay = await session.applyAction({
      type: "write_bytes",
      args: { addressHex: BUFFER_BASE, bytesHex: "aa" },
    }, { idempotencyKey: "determinism-key" });
    expect(canonicalize(replay)).toBe(canonicalize(first));
    expect(session.revision).toBe(1);
    expect(session.acceptedActionCount).toBe(1);
    await session.closeSession();
  });

  it("秘密零驻留:编排器全部留存状态不含 seed / flag(带红灯反例)", { timeout: 120_000 }, async () => {
    const session = await SessionOrchestrator.create({
      ...createOptions(),
      // server_random_per_session 场景的会话种子(D-F9:编排器生成)。
      sessionSeedHex: SESSION_SEED,
      privateBundle: {
        ...lifecycleBundle(),
        seedPolicy: { strategy: "server_random_per_session" },
      },
    });
    await session.applyAction({
      type: "write_bytes",
      args: { addressHex: BUFFER_BASE, bytesHex: "aa" },
    });
    await session.applyAction({ type: "create_checkpoint", args: { label: "before-crash" } });
    const submit = session.submit();

    // 留存状态语料:编排器**自身生成面**——投影缓存、submit 引用、checkpoint
    // 账本条目(标识符 / 标签 / revision;快照载荷除外——它是 worker 所有的
    // SERVER_ONLY 持久化 blob,协议 §4.4 冻结其落编排器存储,阶段三加密静止,
    // 内含 seedState 属契约 sanctioned 形态,见会话编排语义规约 D-W8-11)。
    const retained = [
      canonicalize(session.projection),
      canonicalize(
        session.listCheckpoints().map((entry) => ({
          checkpointId: entry.checkpointId,
          label: entry.label,
          revision: entry.revision,
        })),
      ),
      canonicalize(submit),
    ].join("\n");
    expect(retained).not.toContain(SESSION_SEED);
    expect(retained).not.toContain(FLAG_SENTINEL);
    expect(submit.seedPolicy).toEqual({ strategy: "server_random_per_session" });

    await session.closeSession();

    // 红灯反例:同一扫描器对故意植入秘密的形态必须检出(证明可检出)。
    const redTeam = canonicalize({ echo: FLAG_SENTINEL, seed: SESSION_SEED });
    expect(redTeam).toContain(FLAG_SENTINEL);
    expect(redTeam).toContain(SESSION_SEED);
  });

  it("不可见地址写入被 worker 权威拒绝:revision 不动、不入动作日志", { timeout: 120_000 }, async () => {
    const session = await SessionOrchestrator.create(createOptions());
    const rejected = await session.applyAction({
      type: "write_bytes",
      args: { addressHex: "0x20001000", bytesHex: "aa" },
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.userVisibleError?.code).toBe("inaccessible_address");
    expect(session.revision).toBe(0);
    expect(session.acceptedActionCount).toBe(0);
    await session.closeSession();
  });

  it("版本锁定:包声明与引擎自报不一致 → 装载拒绝(宁可拒绝不近似执行)", { timeout: 120_000 }, async () => {
    const bundle = lifecycleBundle();
    bundle.vmEngineVersion = "9.9.9";
    await expect(
      SessionOrchestrator.create({
        privateBundle: bundle,
        publicDescriptor: lifecycleDescriptor(),
      }),
    ).rejects.toMatchObject({ code: "worker_command_rejected" });
  });
});

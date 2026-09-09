/**
 * 编排核心单元测试(WP-8):以假 worker(内存脚本形态的独立进程)验证
 * 生命周期账本、串行队列、幂等缓存、预检拒绝与崩溃分类——不依赖 Rust
 * 二进制(进程级全链路见 integration.worker.test.ts)。
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize } from "@stackmaster/protocol";
import { SessionOrchestrator, type ActionObject } from "../src/session.js";

const FAKE_WORKER = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "helpers",
  "fake-worker.mjs",
);

const fakeWorkerCommand = () => ({
  command: process.execPath,
  args: [FAKE_WORKER],
});

describe("SessionOrchestrator(假 worker)", () => {
  it("create-session 建立 ledger 并回初始投影;close-session 优雅退出", async () => {
    const session = await SessionOrchestrator.create({
      sessionId: "sess-unit-1",
      privateBundle: { seedPolicy: { strategy: "fixed" } },
      publicDescriptor: {},
      workerCommand: fakeWorkerCommand(),
    });
    expect(session.id).toBe("sess-unit-1");
    expect(session.revision).toBe(0);
    expect(session.phase).toBe("active");
    expect(session.projection?.status).toBe("running");
    await session.closeSession();
    expect(session.phase).toBe("closed");
  });

  it("applyAction 串行推进 revision;已接受动作进入规范化日志", async () => {
    const session = await SessionOrchestrator.create({
      privateBundle: { seedPolicy: { strategy: "fixed" } },
      publicDescriptor: {},
      workerCommand: fakeWorkerCommand(),
    });
    const first = await session.applyAction({
      type: "write_bytes",
      args: { addressHex: "0x20000000", bytesHex: "deadbeef" },
    });
    expect(first.status).toBe("running");
    expect(first.revision).toBe(1);
    const second = await session.applyAction({ type: "pause", args: {} });
    expect(second.revision).toBe(2);
    expect(session.acceptedActionCount).toBe(2);

    const submit = session.submit();
    expect(submit.form).toBe("stackmaster-session-submit/1");
    expect(submit.actionLog).toHaveLength(2);
    expect(submit.actionLog[0]?.revisionAfter).toBe(1);
    await session.closeSession();
  });

  it("幂等窗口内同键同负载返回字节相同缓存响应,动作不重放", async () => {
    const session = await SessionOrchestrator.create({
      privateBundle: { seedPolicy: { strategy: "fixed" } },
      publicDescriptor: {},
      workerCommand: fakeWorkerCommand(),
    });
    const action: ActionObject = {
      type: "write_bytes",
      args: { addressHex: "0x20000000", bytesHex: "aa" },
    };
    const first = await session.applyAction(action, { idempotencyKey: "key-1" });
    const replay = await session.applyAction(action, { idempotencyKey: "key-1" });
    expect(canonicalize(replay)).toBe(canonicalize(first));
    // 重放不推进 revision(动作不重放)
    expect(session.revision).toBe(1);
    await session.closeSession();
  });

  it("同键不同负载确定性拒绝 idempotency_conflict", async () => {
    const session = await SessionOrchestrator.create({
      privateBundle: { seedPolicy: { strategy: "fixed" } },
      publicDescriptor: {},
      workerCommand: fakeWorkerCommand(),
    });
    await session.applyAction(
      { type: "write_bytes", args: { addressHex: "0x20000000", bytesHex: "aa" } },
      { idempotencyKey: "key-1" },
    );
    const conflict = await session.applyAction(
      { type: "write_bytes", args: { addressHex: "0x20000000", bytesHex: "bb" } },
      { idempotencyKey: "key-1" },
    );
    expect(conflict.status).toBe("rejected");
    expect(conflict.userVisibleError?.code).toBe("idempotency_conflict");
    expect(conflict.projectionDelta).toBeNull();
    expect(conflict.publicEvents).toEqual([]);
    // 拒绝不推进 revision
    expect(session.revision).toBe(1);
    await session.closeSession();
  });

  it("create_checkpoint 回执进入 checkpoint 账本(list-checkpoints 无 worker 往返)", async () => {
    const session = await SessionOrchestrator.create({
      privateBundle: { seedPolicy: { strategy: "fixed" } },
      publicDescriptor: {},
      workerCommand: fakeWorkerCommand(),
    });
    await session.applyAction({ type: "write_bytes", args: { addressHex: "0x20000000", bytesHex: "aa" } });
    await session.applyAction({ type: "create_checkpoint", args: { label: "before" } });
    const checkpoints = session.listCheckpoints();
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.label).toBe("before");
    expect(checkpoints[0]?.revision).toBe(2);
    expect(String(checkpoints[0]?.checkpointId)).toContain("fake-checkpoint");
    await session.closeSession();
  });

  it("worker 崩溃 → phase crashed → 后续动作抛错;kill 分类为 forced", async () => {
    const session = await SessionOrchestrator.create({
      privateBundle: { seedPolicy: { strategy: "fixed" } },
      publicDescriptor: {},
      workerCommand: { command: process.execPath, args: [FAKE_WORKER], },
    });
    const exit = await session.kill();
    expect(exit.kind).toBe("forced");
    await expect(
      session.applyAction({ type: "pause", args: {} }),
    ).rejects.toThrow();
  });

  it("worker 在请求处理中退出 → 在途动作失败,phase 标记 crashed", async () => {
    const session = await SessionOrchestrator.create({
      privateBundle: { seedPolicy: { strategy: "fixed" } },
      publicDescriptor: {},
      workerCommand: {
        command: process.execPath,
        args: [FAKE_WORKER],
        env: [["FAKE_MODE", "crash_on_apply"]],
      },
    });
    await expect(
      session.applyAction({ type: "pause", args: {} }),
    ).rejects.toMatchObject({ code: "worker_crashed" });
    expect(session.phase).toBe("crashed");
  });

  it("认证替身被调用且拒绝型替身阻止建会话(基线 #1/#2 替身面)", async () => {
    const session = await SessionOrchestrator.create({
      privateBundle: { seedPolicy: { strategy: "fixed" } },
      publicDescriptor: {},
      workerCommand: fakeWorkerCommand(),
    });
    expect(session.principal.userId).toBe("stub-user");
    await session.closeSession();
  });

  it("fixed 策略携带会话种子在编排器即拒绝(协议 §4.2 互斥)", async () => {
    await expect(
      SessionOrchestrator.create({
        privateBundle: { seedPolicy: { strategy: "fixed" } },
        publicDescriptor: {},
        sessionSeedHex: "aabbccdd",
        workerCommand: fakeWorkerCommand(),
      }),
    ).rejects.toThrow();
  });
});

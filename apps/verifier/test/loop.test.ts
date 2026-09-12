/**
 * 消费循环分支语义测试(WP-61):服务循环的故障路径与停止语义。
 *
 *  - 队列深度观察故障 → 受控告警,循环继续(观察面不阻断裁决);
 *  - 认领故障 → 退避后重试(轮询间隔可中断);
 *  - 空轮询等待可被停止信号中断(快速优雅停机);
 *  - 批内停止:停止信号置位后完成当前 run,不再处置同批后续 run。
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Logger } from "pino";

import { createVerifierLoop, type VerifierLoop } from "../src/verifier.js";
import type { AdjudicatorOptions } from "../src/adjudicator.js";
import type { VerdictQueue } from "../src/persistence/ports.js";
import {
  MemoryBundleSource,
  MemoryChallengeSource,
  MemoryVerdictQueue,
  sha256Hex,
  validReference,
} from "./helpers/memory-ports.js";

const FAKE_WORKER = fileURLToPath(new URL("./helpers/fake-verify-worker.mjs", import.meta.url));

const DIGEST = sha256Hex(
  (validReference() as { replay: { actionLog: string } }).replay.actionLog,
);

function recordingLogger(): {
  logger: Logger;
  state: { warns: number; errors: number };
} {
  const state = { warns: 0, errors: 0 };
  const logger: Logger = {
    info: () => undefined,
    warn: () => {
      state.warns += 1;
    },
    error: () => {
      state.errors += 1;
    },
    debug: () => undefined,
  } as unknown as Logger;
  return { logger, state };
}

const BUNDLE_JSON = '{"vmEngineVersion":"0.1.0","engineBuildId":"dev"}';
const DESCRIPTOR_JSON = '{"schemaVersion":1}';
const REGISTRATION = {
  privateBundleSha256: sha256Hex(BUNDLE_JSON),
  publicDescriptorSha256: sha256Hex(DESCRIPTOR_JSON),
  privateBundleObject: "chal-1/1.0.0/bundle.json",
  publicDescriptorObject: "chal-1/1.0.0/descriptor.json",
};
const BUNDLES = new Map<string, Uint8Array>([
  ["chal-1/1.0.0/bundle.json", new TextEncoder().encode(BUNDLE_JSON)],
  ["chal-1/1.0.0/descriptor.json", new TextEncoder().encode(DESCRIPTOR_JSON)],
]);

function baseAdjudicator(queue: VerdictQueue): Omit<AdjudicatorOptions, "logger"> {
  return {
    queue,
    challenges: new MemoryChallengeSource(new Map([["tenant-1|chal-1|1.0.0", REGISTRATION]])),
    bundles: new MemoryBundleSource(BUNDLES),
    maxAttempts: 3,
    maxActionLogBytes: 1_048_576,
    verifyTimeoutMs: 5_000,
    workerSpec: {
      command: process.execPath,
      args: [FAKE_WORKER],
      env: [["FAKE_LOG_DIGEST", DIGEST]],
    },
  };
}

/** 带故障注入的队列包装(pendingCount / claim 首次调用抛出)。 */
class FaultyQueue implements VerdictQueue {
  constructor(
    private readonly inner: MemoryVerdictQueue,
    private readonly failDepth: boolean,
    private readonly failClaimOnce: boolean,
  ) {}
  private claimCalls = 0;

  async pendingCount(): Promise<number> {
    if (this.failDepth) {
      throw new Error("depth observation unavailable");
    }
    return this.inner.pendingCount();
  }

  async claim(batchSize: number, maxAttempts: number) {
    this.claimCalls += 1;
    if (this.failClaimOnce && this.claimCalls === 1) {
      throw new Error("claim raced with a deadlock");
    }
    return this.inner.claim(batchSize, maxAttempts);
  }

  async complete(input: Parameters<VerdictQueue["complete"]>[0]): Promise<void> {
    return this.inner.complete(input);
  }

  async fail(input: Parameters<VerdictQueue["fail"]>[0]): Promise<void> {
    return this.inner.fail(input);
  }
}

async function runUntilStopped(loop: VerifierLoop, timeoutMs = 5_000): Promise<void> {
  const running = loop.run();
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("loop 未在时限内停止")), timeoutMs).unref?.();
  });
  await Promise.race([running, deadline]);
}

describe("verifier 消费循环(故障与停止语义)", () => {
  it("空轮询等待可被停止信号中断(快速优雅停机,不等满轮询间隔)", async () => {
    const { logger } = recordingLogger();
    const loop = createVerifierLoop({
      adjudicator: { ...baseAdjudicator(new MemoryVerdictQueue()), logger },
      batchSize: 4,
      maxAttempts: 3,
      pollIntervalMs: 30_000, // 远大于用例时限:证明 stop 提前唤醒。
      logger,
    });
    const started = Date.now();
    const running = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 100));
    loop.stop();
    await runUntilStopped(loop);
    await running;
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("队列深度观察故障仅告警;认领故障退避后恢复,循环不中断", async () => {
    const { logger, state } = recordingLogger();
    const loop = createVerifierLoop({
      adjudicator: {
        ...baseAdjudicator(new FaultyQueue(new MemoryVerdictQueue(), true, true)),
        logger,
      },
      batchSize: 4,
      maxAttempts: 3,
      pollIntervalMs: 20,
      logger,
    });
    void loop.run();
    await new Promise((resolve) => setTimeout(resolve, 150));
    loop.stop();
    await runUntilStopped(loop);
    expect(state.warns).toBeGreaterThan(0);
    expect(state.errors).toBeGreaterThan(0);
  });

  it("批内停止:当前 run 处置完成后,同批后续 run 不再处置", async () => {
    const { logger } = recordingLogger();
    const first = "66666666-6666-6666-6666-666666666666";
    const second = "77777777-7777-7777-7777-777777777777";
    const queue = new MemoryVerdictQueue([
      { submissionId: first, logDigest: DIGEST, reference: validReference() },
      { submissionId: second, logDigest: DIGEST, reference: validReference() },
    ]);
    let loopRef: VerifierLoop | null = null;
    const loop = createVerifierLoop({
      adjudicator: {
        ...baseAdjudicator(queue),
        logger,
        onOutcome: (outcome) => {
          if (outcome === "completed") {
            loopRef?.stop();
          }
        },
      },
      batchSize: 4,
      maxAttempts: 3,
      pollIntervalMs: 20,
      logger,
    });
    loopRef = loop;
    const running = loop.run();
    for (let i = 0; i < 200 && queue.verdicts.size === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    loop.stop();
    await runUntilStopped(loop);
    await running;
    expect(queue.verdicts.size).toBe(1);
    expect(queue.verdicts.get(first)?.verdict).toBe("success");
    // 第二个 run 已认领但未处置(停止信号在批内生效;零裁决落库)。
    expect(queue.runs.find((run) => run.submissionId === second)?.status).toBe("running");
    expect(queue.verdicts.has(second)).toBe(false);
  }, 15_000);
});

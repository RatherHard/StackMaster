/**
 * 裁决队列消费循环(WP-61;D-API-85 触发形态:PG 轮询 SKIP LOCKED)。
 *
 * 单实例串行处置认领批(replay CPU 密集;多实例水平扩展由行锁认领天然
 * 支持,T2 规模化演进面)。停止语义:停止信号置位后完成当前批,不再发起
 * 新认领;空轮询等待可被停止信号中断(快速优雅停机)。
 */
import type { Logger } from "pino";

import { adjudicateRun, type AdjudicatorOptions } from "./adjudicator.js";

export interface VerifierLoop {
  /** 阻塞至停止信号(测试与优雅停机的汇合点)。 */
  run(): Promise<void>;
  /** 停止(幂等;当前批完成后返回)。 */
  stop(): void;
}

export function createVerifierLoop(options: {
  adjudicator: AdjudicatorOptions;
  batchSize: number;
  maxAttempts: number;
  pollIntervalMs: number;
  logger: Logger;
  onQueueDepth?: (depth: number) => void;
}): VerifierLoop {
  let stopping = false;
  let wakeStop: (() => void) | null = null;
  const stopSignal = new Promise<void>((resolve) => {
    wakeStop = resolve;
  });

  const sleepInterruptible = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      void stopSignal.then(resolve);
    });

  return {
    async run(): Promise<void> {
      options.logger.info("verifier queue loop started");
      while (!stopping) {
        try {
          const depth = await options.adjudicator.queue.pendingCount();
          options.onQueueDepth?.(depth);
        } catch (error) {
          options.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "queue depth observation failed",
          );
        }
        let claimed;
        try {
          claimed = await options.adjudicator.queue.claim(options.batchSize, options.maxAttempts);
        } catch (error) {
          options.logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            "queue claim failed; backing off",
          );
          await sleepInterruptible(options.pollIntervalMs);
          continue;
        }
        if (claimed.length === 0) {
          await sleepInterruptible(options.pollIntervalMs);
          continue;
        }
        for (const run of claimed) {
          if (stopping) {
            break;
          }
          await adjudicateRun(run, options.adjudicator);
        }
      }
      options.logger.info("verifier queue loop stopped");
    },
    stop(): void {
      stopping = true;
      wakeStop?.();
    },
  };
}

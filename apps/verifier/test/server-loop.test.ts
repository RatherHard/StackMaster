/**
 * 消费循环与服务面测试(WP-61)。
 *
 *  - 循环:认领 → 处置 → 队列排空后待命;stop 后不再发起新认领;
 *  - 服务面:healthz / readyz(探针失败 503,失败方不透出)/ metrics
 *    (指标名白名单、标签零秘密零标识符,D-API-70/71 纪律延伸)。
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Logger } from "pino";

import { buildVerifierServer } from "../src/server.js";
import { VerifierMetrics, METRIC_FAMILIES } from "../src/metrics.js";
import { createVerifierLoop } from "../src/verifier.js";
import {
  MemoryBundleSource,
  MemoryChallengeSource,
  MemoryVerdictQueue,
  sha256Hex,
  validReference,
} from "./helpers/memory-ports.js";

// 路径锚:本文件位置(根级覆盖率 projects 形态下 cwd 是仓库根,不得用
// process.cwd();import.meta.url 形态与会话编排 boot 集成测试同款)。
const FAKE_WORKER = fileURLToPath(new URL("./helpers/fake-verify-worker.mjs", import.meta.url));
const SUBMISSION_ID = "44444444-4444-4444-4444-444444444444";
const DIGEST = sha256Hex(
  (validReference() as { replay: { actionLog: string } }).replay.actionLog,
);

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

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

describe("verifier 消费循环", () => {
  it("认领批逐个处置;verdicts 落库;stop 后循环退出", async () => {
    const queue = new MemoryVerdictQueue([
      { submissionId: SUBMISSION_ID, logDigest: DIGEST, reference: validReference() },
      { submissionId: "55555555-5555-5555-5555-555555555555", logDigest: "f".repeat(64), reference: validReference() },
    ]);
    const metrics = new VerifierMetrics();
    const loop = createVerifierLoop({
      adjudicator: {
        queue,
        challenges: new MemoryChallengeSource(new Map([["tenant-1|chal-1|1.0.0", REGISTRATION]])),
        bundles: new MemoryBundleSource(BUNDLES),
        maxAttempts: 3,
        maxActionLogBytes: 1024,
        verifyTimeoutMs: 5_000,
        workerSpec: { command: process.execPath, args: [FAKE_WORKER], env: [["FAKE_LOG_DIGEST", DIGEST]] },
        logger,
        onVerdict: (verdict) => metrics.recordVerdict(verdict),
        onOutcome: (outcome) => metrics.recordRunOutcome(outcome),
      },
      batchSize: 4,
      maxAttempts: 3,
      pollIntervalMs: 20,
      logger,
    });
    const running = loop.run();
    // 处置在批次内完成:等待两个 submission 均达终态。
    for (let i = 0; i < 200 && queue.runs.every((run) => run.status === "pending"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    loop.stop();
    await running;
    expect(queue.verdicts.get(SUBMISSION_ID)?.verdict ?? "").toBe("success");
    // 失败 run:拒裁方向(failed)+ 重试行,但轮询不再发起新认领后保持。
    expect(queue.verdicts.size).toBe(1);
  }, 15_000);
});

describe("verifier 运维面(healthz / readyz / metrics)", () => {
  it("healthz 恒 200;readyz 探针全过 200", async () => {
    const server = await buildVerifierServer({
      logger,
      metrics: new VerifierMetrics(),
      readinessProbes: [
        { name: "postgres", check: async () => undefined },
        { name: "minio", check: async () => undefined },
      ],
    });
    await server.ready();
    const health = await server.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    const ready = await server.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    await server.close();
  });

  it("readyz 探针失败 → 503 冻结形态,失败方不透出", async () => {
    const server = await buildVerifierServer({
      logger,
      metrics: new VerifierMetrics(),
      readinessProbes: [
        { name: "postgres", check: async () => undefined },
        {
          name: "minio",
          check: async () => {
            throw new Error("access denied on private-bundles");
          },
        },
      ],
    });
    await server.ready();
    const ready = await server.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(503);
    expect(ready.body).toBe(JSON.stringify({ code: "internal_error", message: "dependencies unavailable" }));
    expect(ready.body).not.toContain("minio");
    expect(ready.body).not.toContain("access denied");
    await server.close();
  });

  it("readyz 探针以非 Error 值拒绝 → 同一 503 冻结形态(错误面归一)", async () => {
    const server = await buildVerifierServer({
      logger,
      metrics: new VerifierMetrics(),
      readinessProbes: [
        {
          name: "minio",
          check: () => Promise.reject("non-error-rejection"),
        },
      ],
    });
    await server.ready();
    const ready = await server.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(503);
    expect(ready.body).toBe(JSON.stringify({ code: "internal_error", message: "dependencies unavailable" }));
    expect(ready.body).not.toContain("non-error-rejection");
    await server.close();
  });

  it("metrics:指标名 ⊆ 白名单;裁决计数有界枚举标签;零秘密语料命中", async () => {
    const metrics = new VerifierMetrics();
    metrics.queueDepth.set(3);
    metrics.recordRunOutcome("completed");
    metrics.recordVerdict("success");
    metrics.verifyDuration.observe(0.5);
    const server = await buildVerifierServer({ logger, metrics, readinessProbes: [] });
    await server.ready();
    const response = await server.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    const text = response.body;
    const names = text
      .split("\n")
      .filter((line) => line.startsWith("# TYPE "))
      .map((line) => (line.split(" ")[2] ?? "").replace(/^([a-z_]+).*$/, "$1"))
      .filter((name) => name !== "");
    expect(names.length).toBeGreaterThan(0);
    for (const family of names) {
      expect(METRIC_FAMILIES.some((name) => family.startsWith(name)), family).toBe(true);
    }
    expect(text).toContain('verdict="success"');
    // 秘密语料零命中(seed 十六进制样式 / FLAG 形态)。
    expect(text).not.toMatch(/FLAG\{/);
    expect(text).not.toContain("00112233445566778899aabbccddeeff");
    await server.close();
  });
});

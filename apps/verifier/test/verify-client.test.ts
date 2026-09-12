/**
 * verify 客户端进程协议测试(WP-61):spawn 假 worker 走真实 stdio NDJSON
 * 链路(与生产 vm-worker 同一协议面)。
 *
 * 完成标准承接:一次性裁决进程形态(ready 握手版本比对 fail-closed、
 * verify 单命令、shutdown 优雅退出、崩溃收割、stop-and-wait)。
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { VerifyWorkerClient } from "../src/worker/verify-client.js";

// 路径锚:本文件位置(根级覆盖率 projects 形态下 cwd 是仓库根,不得用
// process.cwd();import.meta.url 形态与会话编排 boot 集成测试同款)。
const FAKE_WORKER = fileURLToPath(new URL("./helpers/fake-verify-worker.mjs", import.meta.url));

function spec(env: Record<string, string> = {}): {
  command: string;
  args: string[];
  env?: readonly (readonly [string, string])[];
} {
  return {
    command: process.execPath,
    args: [FAKE_WORKER],
    ...(Object.keys(env).length === 0
      ? {}
      : { env: Object.entries(env) }),
  };
}

const REQUEST = {
  privateBundle: {},
  publicDescriptor: {},
  replayContext: {},
  actionLog: "{}",
} as const;

describe("VerifyWorkerClient(假 worker,协议级)", () => {
  it("ready 握手 → verify 回裁决报告 → shutdown 优雅退出", async () => {
    const client = await VerifyWorkerClient.spawn(
      spec({ FAKE_VERDICT: "success", FAKE_LOG_DIGEST: "c".repeat(64) }),
    );
    expect(client.ready).toEqual({ vmEngineVersion: "0.1.0", engineBuildId: "dev" });
    const outcome = await client.verify(REQUEST, 5_000);
    expect(outcome.kind).toBe("report");
    if (outcome.kind === "report") {
      expect(outcome.report.verdict).toBe("success");
      expect(outcome.report.logDigest).toBe("c".repeat(64));
      expect(outcome.report.replay.kind).toBe("matched");
    }
    await client.dispose();
  }, 15_000);

  it("首帧不是 ready 自报帧 → protocol_violation 拒绝", async () => {
    await expect(VerifyWorkerClient.spawn(spec({ FAKE_MODE: "bad_first_frame" }))).rejects.toMatchObject(
      { name: "VerifyClientError", reason: "protocol_violation" },
    );
  }, 15_000);

  it("首帧是非 JSON 输出 → 同一 protocol_violation 拒绝(stdout 每行必须是协议帧)", async () => {
    await expect(
      VerifyWorkerClient.spawn(spec({ FAKE_MODE: "garbage_first_frame" })),
    ).rejects.toMatchObject({ name: "VerifyClientError", reason: "protocol_violation" });
  }, 15_000);

  it("command_error 帧收敛为确定性 outcome", async () => {
    const client = await VerifyWorkerClient.spawn(
      spec({ FAKE_MODE: "command_error_challenge_invalid" }),
    );
    const outcome = await client.verify(REQUEST, 5_000);
    expect(outcome).toEqual({ kind: "command_error", code: "challenge_invalid" });
    await client.dispose();
  }, 15_000);

  it("internal_error 方向的命令错误同样确定性收敛", async () => {
    const client = await VerifyWorkerClient.spawn(spec({ FAKE_MODE: "command_error_internal" }));
    const outcome = await client.verify(REQUEST, 5_000);
    expect(outcome).toEqual({ kind: "command_error", code: "internal_error" });
    await client.dispose();
  }, 15_000);

  it("verify 中进程崩溃 → process_failure(进程不复用)", async () => {
    const client = await VerifyWorkerClient.spawn(spec({ FAKE_MODE: "crash_on_verify" }));
    const outcome = await client.verify(REQUEST, 5_000);
    expect(outcome).toEqual({ kind: "process_failure", reason: "process_exited" });
    await client.dispose();
  }, 15_000);

  it("已收割(dispose/kill)的进程不可再服务 → process_failure", async () => {
    const client = await VerifyWorkerClient.spawn(spec());
    client.kill();
    const outcome = await client.verify(REQUEST, 5_000);
    expect(outcome).toEqual({ kind: "process_failure", reason: "worker_not_available" });
  }, 15_000);
});

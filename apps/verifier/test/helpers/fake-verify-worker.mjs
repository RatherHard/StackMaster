/**
 * 测试假 verify worker(spawn 直启,不经 TS 编译;speaks 引擎进程协议的
 * verify 最小子集)。
 *
 * 行为由环境变量驱动:
 * - `FAKE_WORKER_VERSION`(缺省 "0.1.0"):ready 自报 vmEngineVersion;
 * - `FAKE_VERDICT`(缺省 "success"):verify_report 的裁决字面;
 * - `FAKE_MODE=command_error_challenge_invalid`:verify 回 challenge_invalid;
 * - `FAKE_MODE=command_error_internal`:verify 回 internal_error;
 * - `FAKE_MODE=crash_on_verify`:收到 verify 即非零退出;
 * - `FAKE_MODE=bad_first_frame`:首帧不是 ready(协议违规路径);
 * - `FAKE_LOG_DIGEST`:report 携带的 logDigest(缺省合成 64 hex)。
 */

import { createInterface } from "node:readline";

const mode = process.env.FAKE_MODE ?? "report";
const version = process.env.FAKE_WORKER_VERSION ?? "0.1.0";
const verdict = process.env.FAKE_VERDICT ?? "success";
const digest = process.env.FAKE_LOG_DIGEST ?? "c".repeat(64);

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

if (mode === "bad_first_frame") {
  send({ type: "loaded", seq: 0 });
} else if (mode === "garbage_first_frame") {
  // 首帧非 JSON(stdout 每行必须是协议帧的违规面)。
  process.stdout.write("this is not json at all\n");
} else {
  send({ type: "ready", protocolVersion: 1, vmEngineVersion: version, engineBuildId: "dev" });
}

const replay = { kind: "matched", finalRevision: 3, finalStatus: "won" };

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    process.exit(1);
  }
  const { seq, type } = command;
  switch (type) {
    case "verify": {
      if (mode === "crash_on_verify") {
        process.exit(9);
      }
      if (mode === "command_error_challenge_invalid") {
        send({ type: "command_error", seq, error: { code: "challenge_invalid", message: "challenge bundle was rejected" } });
        break;
      }
      if (mode === "command_error_internal") {
        send({ type: "command_error", seq, error: { code: "internal_error", message: "engine could not process the command" } });
        break;
      }
      send({
        type: "verify_report",
        seq,
        report: {
          verdict,
          replay,
          hiddenTests: { kind: "executed", allPassed: true, tests: [{ index: 0, verdict: "success", expected: "success", passed: true }] },
          logDigest: digest,
        },
      });
      break;
    }
    case "shutdown": {
      send({ type: "shutdown_ack", seq });
      process.exit(0);
      break;
    }
    default: {
      send({ type: "command_error", seq, error: { code: "internal_error", message: "engine could not process the command" } });
    }
  }
});

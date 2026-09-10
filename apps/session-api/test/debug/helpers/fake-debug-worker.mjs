/**
 * 测试假调试 worker(阶段四 WP-41;speaks 引擎进程协议信封的调试面最小
 * 子集,形态与 routes/helpers/fake-worker.mjs 同源)。仅承载通道语义测试
 * (认证 / 锚定 / 限额 / 幂等 attach / 帧校验)——装载与引擎语义归真实
 * vm-worker 二进制的门控集成测试(SESSION_API_IT)。
 *
 * 行为:load_variant → variant_loaded;debug_apply_recorded → revision++;
 * debug_step → debug_halted(step);debug_run_to_breakpoint → debug_halted
 * (breakpoint);debug_read_window → 固定占位字节;debug_query_state →
 * revision / running / RIP;shutdown → shutdown_ack。
 */
import { createInterface } from "node:readline";

let revision = 0;

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

send({
  type: "ready",
  protocolVersion: 1,
  vmEngineVersion: "0.1.0",
  engineBuildId: "dev",
});

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
    case "load_variant": {
      send({
        type: "variant_loaded",
        seq,
        loaded: {
          challengeId: command.variant?.challengeId ?? "fake-challenge",
          challengeContentVersion: command.variant?.challengeContentVersion ?? "1.0.0",
          vmProfileVersion: "1.0.0",
          aslrEnabled: false,
          initialRevision: 0,
        },
      });
      break;
    }
    case "debug_apply_recorded": {
      revision += 1;
      send({
        type: "debug_applied",
        seq,
        revision,
        status: "running",
        ripHex: "0x400000",
      });
      break;
    }
    case "debug_step": {
      send({ type: "debug_halted", seq, reason: "step", addressHex: "0x400001", stepsExecuted: 1 });
      break;
    }
    case "debug_run_to_breakpoint": {
      send({
        type: "debug_halted",
        seq,
        reason: "breakpoint",
        addressHex: command.breakpoints?.[0] ?? "0x400002",
        stepsExecuted: 2,
      });
      break;
    }
    case "debug_read_window": {
      send({
        type: "debug_window_data",
        seq,
        addressHex: command.addressHex,
        bytesHex: "d3adb33fc0ffee01",
        truncated: false,
      });
      break;
    }
    case "debug_search": {
      send({
        type: "debug_search_results",
        seq,
        hits: [{ addressHex: "0x405000", bytesHex: command.patternHex ?? "d3adb33f" }],
        truncated: false,
      });
      break;
    }
    case "debug_query_state": {
      send({
        type: "debug_state",
        seq,
        state: { revision, status: "running", ripHex: "0x400000", halted: false },
      });
      break;
    }
    case "query_projection": {
      send({
        type: "projection",
        seq,
        projection: {
          revision: 0,
          visibleRegions: [],
          visibleRegisters: [],
          callStackSummary: [],
          controlFlow: { currentInstruction: { addressHex: "0x0", text: "ret" }, pausedOn: null },
          semanticHighlights: [],
          status: "running",
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
      send({
        type: "command_error",
        seq,
        error: { code: "internal_error", message: "engine could not process the command" },
      });
    }
  }
});

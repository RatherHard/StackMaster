/**
 * 测试假调试 worker(阶段四 WP-41;speaks 引擎进程协议信封的调试面最小
 * 子集,形态与 routes/helpers/fake-worker.mjs 同源)。仅承载通道语义测试
 * (认证 / 锚定 / 限额 / 幂等 attach / 帧校验)——装载与引擎语义归真实
 * vm-worker 二进制的门控集成测试(SESSION_API_IT)。
 *
 * 行为:load_variant → variant_loaded;debug_apply_recorded → revision++;
 * debug_step → debug_halted(step);debug_run_to_breakpoint → debug_halted
 * (breakpoint);debug_read_window → 固定占位字节;debug_search → 固定命中;
 * debug_instruction_stream → 确定性样例条目(含 bytesHex:null 与
 * jumpTargetHex:null 条目,锁定通道侧"缺席归一化"行为);debug_function_table
 * → 确定性单函数;debug_query_state → 暂停感知(revision / running|paused /
 * 最近暂停 rip);shutdown → shutdown_ack。
 */
import { createInterface } from "node:readline";

let revision = 0;
/** 最近暂停落点(null = running;attach 幂等回执的 paused 面由此驱动)。 */
let pausedRipHex = null;

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
      pausedRipHex = "0x400001";
      send({ type: "debug_halted", seq, reason: "step", addressHex: "0x400001", stepsExecuted: 1 });
      break;
    }
    case "debug_run_to_breakpoint": {
      pausedRipHex = command.breakpoints?.[0] ?? "0x400002";
      send({
        type: "debug_halted",
        seq,
        reason: "breakpoint",
        addressHex: pausedRipHex,
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
    case "debug_instruction_stream": {
      // 确定性样例(worker 线形差异的锁定面):第 2 条 bytesHex = null、
      // 第 3 条 jumpTargetHex = null——真实 worker 对缺席可选字段即如此
      // 序列化(WP-44);通道发射点必须归一化为"缺席"才能过冻结 Schema。
      send({
        type: "debug_instruction_stream_data",
        seq,
        instructions: [
          { addressHex: "0x400000", bytesHex: "55", text: "push rbp" },
          { addressHex: "0x400001", bytesHex: null, text: "mov rbp, rsp" },
          { addressHex: "0x400002", bytesHex: "01", text: "int3", jumpTargetHex: null },
        ],
        truncated: false,
      });
      break;
    }
    case "debug_function_table": {
      send({
        type: "debug_function_table_data",
        seq,
        functions: [{ label: "sub_400000", startAddressHex: "0x400000", byteLength: 16 }],
        truncated: false,
      });
      break;
    }
    case "debug_query_state": {
      send({
        type: "debug_state",
        seq,
        state: {
          revision,
          status: pausedRipHex === null ? "running" : "paused",
          ripHex: pausedRipHex ?? "0x400000",
          halted: pausedRipHex !== null,
        },
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

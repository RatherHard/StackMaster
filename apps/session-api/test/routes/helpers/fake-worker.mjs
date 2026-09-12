/**
 * 测试假 worker(REST 生命周期路由测试用;speaks 引擎进程协议信封的
 * 最小子集,形态与 packages/session-core 测试假 worker 同源)。
 *
 * 行为由环境变量 FAKE_MODE 驱动:
 *  - `replay`(缺省):确定性回放合法响应;create_checkpoint 附带
 *    checkpointExport 回执(恢复点数据源);
 *  - `watchdog_on_apply`:收到 apply_action 即以退出码 3 退出
 *    (worker 看门狗超时路径 → 编排侧 timeout 呈现,WP-4 错误映射);
 *  - `watchdog_on_shutdown`:收到 shutdown 即以退出码 3 退出
 *    (close_session 命令路径上呈现 timeout 映射的 REST 面测试入口);
 *  - `crash_on_apply`:收到 apply_action 即以退出码 9 退出
 *    (一般崩溃路径 → engine_error 呈现)。
 *
 * 投影载荷是最小合法 `PublicStateProjection`(7 字段)。
 */
import { createInterface } from "node:readline";

const mode = process.env.FAKE_MODE ?? "replay";

const baseProjection = {
  revision: 0,
  visibleRegions: [
    {
      regionId: "code",
      label: "代码区",
      startAddressHex: "0x401000",
      byteLength: 4096,
      permissions: "rx",
      bytesHex: "c300",
      truncated: true,
    },
  ],
  visibleRegisters: [{ name: "RAX", valueHex: "0x0" }],
  callStackSummary: [],
  controlFlow: {
    currentInstruction: { addressHex: "0x0", text: "ret" },
    pausedOn: null,
  },
  semanticHighlights: [],
  status: "running",
};

let revision = 0;
const clientSeqSeen = new Set();

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
  if (mode === "watchdog_on_apply" && type === "apply_action") {
    process.exit(3);
  }
  if (mode === "crash_on_apply" && type === "apply_action") {
    process.exit(9);
  }
  switch (type) {
    case "load": {
      send({
        type: "loaded",
        seq,
        loaded: {
          challengeId: "fake-challenge",
          challengeContentVersion: "1.0.0",
          vmProfileVersion: "1.0.0",
          dslSchemaVersion: 2,
          vmEngineVersion: "0.1.0",
          engineBuildId: "dev",
          initialRevision: 0,
        },
      });
      break;
    }
    case "apply_action": {
      const request = command.actionRequest;
      if (clientSeqSeen.has(request.clientSeq)) {
        send({
          type: "action_response",
          seq,
          actionResponse: {
            requestId: command.requestId,
            revision,
            status: "rejected",
            projectionDelta: null,
            publicEvents: [],
            userVisibleError: { code: "stale_client_seq", message: "client sequence is stale" },
          },
          checkpointExport: null,
        });
        break;
      }
      clientSeqSeen.add(request.clientSeq);
      // 确定性拒绝路径(测试"拒绝不入账"等语义):write_bytes 携带 ff 字节
      // 即拒绝(inaccessible_address 教学形态),revision 不前进。
      if (request.action.type === "write_bytes" && request.action.args.bytesHex === "ff") {
        send({
          type: "action_response",
          seq,
          actionResponse: {
            requestId: command.requestId,
            revision,
            status: "rejected",
            projectionDelta: null,
            publicEvents: [],
            userVisibleError: {
              code: "inaccessible_address",
              // I-9 统一占位形态:addressHex 恒为 null(冻结 Schema 复验要求)。
              addressHex: null,
              message: "address is not accessible",
            },
          },
          checkpointExport: null,
        });
        break;
      }
      revision += 1;
      const isCheckpoint = request.action.type === "create_checkpoint";
      const actionResponse = {
        requestId: command.requestId,
        revision,
        status: "running",
        projectionDelta: isCheckpoint
          ? null
          : { revision, dirtyRanges: [], changedRegisters: [] },
        publicEvents: [],
      };
      send({
        type: "action_response",
        seq,
        actionResponse,
        checkpointExport: isCheckpoint
          ? {
              checkpointId: `fake-checkpoint-${revision}`,
              snapshot: {
                snapshotFormatVersion: 1,
                vmEngineVersion: "0.1.0",
                engineBuildId: "dev",
                revision,
                payload: {},
              },
            }
          : null,
      });
      break;
    }
    case "query_projection": {
      send({
        type: "projection",
        seq,
        projection: { ...baseProjection, revision },
      });
      break;
    }
    case "export_action_log": {
      // 重放材料面(WP-61):最小合法形态(结构复验通过;内容为合成占位,
      // 单元测试不消费其语义)。
      send({
        type: "action_log_exported",
        seq,
        replayContext: {
          challengeId: "fake-challenge",
          challengeContentVersion: "1.0.0",
          vmProfileVersion: "1.0.0",
          vmEngineVersion: "0.1.0",
          engineBuildId: "dev",
          verdictRuleVersion: "1.0.0",
          challengeBundleHash: "a".repeat(64),
          vmProfileHash: "b".repeat(64),
          archBits: 32,
          seedPolicy: { strategy: "fixed", derivation: null },
        },
        actionLog: `{"context":{"archBits":32,"challengeBundleHash":"${"a".repeat(64)}","challengeContentVersion":"1.0.0","challengeId":"fake-challenge","engineBuildId":"dev","seedPolicy":{"derivation":null,"strategy":"fixed"},"vmEngineVersion":"0.1.0","vmProfileHash":"${"b".repeat(64)}","vmProfileVersion":"1.0.0","verdictRuleVersion":"1.0.0"},"entries":[],"format":"stackmaster-action-log/1"}`,
      });
      break;
    }
    case "shutdown": {
      if (mode === "watchdog_on_shutdown") {
        process.exit(3);
      }
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

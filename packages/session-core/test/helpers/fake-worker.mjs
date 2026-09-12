/**
 * 测试假 worker(单元测试用; speaks 引擎进程协议信封的最小子集)。
 *
 * 形态:独立 Node 脚本(spawn 直启,不经 TS 编译)。行为由环境变量驱动:
 * - `FAKE_MODE=replay`(缺省):确定性回放合法响应;
 * - `FAKE_MODE=crash_on_apply`:收到 apply_action 即以非零码退出(崩溃路径)。
 *
 * 投影载荷是最小合法 `PublicStateProjection`(7 字段);`write` 动作回执
 * revision +1,其余动作 +1 且 create_checkpoint 附带 checkpointExport。
 */

import { createInterface } from "node:readline";

const mode = process.env.FAKE_MODE ?? "replay";

const projection = {
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
let clientSeqSeen = new Set();

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
  if (mode === "crash_on_apply" && type === "apply_action") {
    process.exit(9);
  }
  switch (type) {
    case "load": {
      send({ type: "loaded", seq, loaded: {
        challengeId: "fake-challenge",
        challengeContentVersion: "1.0.0",
        vmProfileVersion: "1.0.0",
        dslSchemaVersion: 2,
        vmEngineVersion: "0.1.0",
        engineBuildId: "dev",
        initialRevision: 0,
      } });
      break;
    }
    case "apply_action": {
      const request = command.actionRequest;
      if (clientSeqSeen.has(request.clientSeq)) {
        send({ type: "action_response", seq, actionResponse: {
          requestId: command.requestId,
          revision,
          status: "rejected",
          projectionDelta: null,
          publicEvents: [],
          userVisibleError: { code: "stale_client_seq", message: "client sequence is stale" },
        }, checkpointExport: null });
        break;
      }
      clientSeqSeen.add(request.clientSeq);
      revision += 1;
      const isCheckpoint = request.action.type === "create_checkpoint";
      send({ type: "action_response", seq, actionResponse: {
        requestId: command.requestId,
        revision,
        status: "running",
        projectionDelta: { revision, dirtyRanges: [], changedRegisters: [] },
        publicEvents: [],
        ...(isCheckpoint ? {} : { userVisibleError: undefined }),
      }, checkpointExport: isCheckpoint ? {
        checkpointId: `fake-checkpoint-${revision}`,
        snapshot: { snapshotFormatVersion: 1, vmEngineVersion: "0.1.0", engineBuildId: "dev", revision, payload: {} },
      } : null });
      break;
    }
    case "query_projection": {
      projection.revision = revision;
      send({ type: "projection", seq, projection });
      break;
    }
    case "export_snapshot": {
      send({ type: "snapshot_exported", seq, snapshot: {
        snapshotFormatVersion: 1, vmEngineVersion: "0.1.0", engineBuildId: "dev", revision, payload: {},
      } });
      break;
    }
    case "import_snapshot": {
      revision = Number(command.snapshot?.revision ?? revision);
      send({ type: "snapshot_imported", seq });
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
      send({ type: "shutdown_ack", seq });
      process.exit(0);
      break;
    }
    default: {
      send({ type: "command_error", seq, error: { code: "internal_error", message: "engine could not process the command" } });
    }
  }
});

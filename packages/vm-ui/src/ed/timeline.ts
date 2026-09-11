/**
 * 时间线构建纯函数(FE-ED-04,WP-F9)。
 *
 * 客户端自账本构建:动作/checkpoint 历史 = SessionClient 的 onActionResponse
 * 离散响应流 + list_checkpoints 的 CheckpointRef 列表(REST,按创建序)的
 * **纯函数合成**,零服务端时间线端点(时间线只存引用,协议 6.3)。
 *
 * 语义锚点:
 *  - ActionResponse 不携带动作本体,宿主在发送侧保留 (action, response) 对
 *    (动作账本属会话 UI 状态,README 纪律);本函数消费配对记录;
 *  - create_checkpoint 动作的响应不含 checkpointId(服务端签发);checkpoint
 *    列表以 revision 对齐承载 id + label——若 create_checkpoint 响应的
 *    revision 与某 checkpoint 条目相同,**跳过动作条目只保留 checkpoint 条目**
 *    (同一事实不重复呈现);列表尚未刷新(无同 revision 条目)时按普通动作呈现;
 *  - 排序:revision 升序(I-5 权威单调计数器即会话时间轴);同 revision 按
 *    动作 → checkpoint → submit 的稳定次序(同 revision 的多动作按流序);
 *  - `seq` 为排序后的 1 起稠密序号(展示序,非协议序号)。
 */
import type { ActionObject, ActionResponse, CheckpointRef } from "@stackmaster/protocol";

import { t } from "../i18n/i18n.js";
import { formatAddressHex } from "../render/hex.js";

/** 时间线条目类别(规约口径:动作 / checkpoint / 提交)。 */
export type TimelineEntryKind = "action" | "checkpoint" | "submit";

/** 时间线条目(FE-ED-04 规约形态)。 */
export interface TimelineEntry {
  /** 展示序号(1 起稠密;排序后分配,非协议序号)。 */
  readonly seq: number;
  readonly kind: TimelineEntryKind;
  /** 人类可读条目摘要(动作 = type + 关键参数摘要;通用教学文案)。 */
  readonly label: string;
  /** 该事实对应的权威 revision(I-5)。 */
  readonly revision: number;
  /** 宿主可选提供的时刻(epoch 毫秒;响应流 / 命令完成时)。 */
  readonly at?: number;
  /** 动作响应状态(running/paused/won/failed/rejected;checkpoint/submit 条目缺省)。 */
  readonly status?: string;
  /** kind = checkpoint 时携带服务端签发引用(跳转/展示用)。 */
  readonly checkpointId?: string;
  /** kind = submit 时携带提交引用。 */
  readonly submissionId?: string;
}

/** 动作时间线配对记录(宿主动作账本的最小切片)。 */
export interface ActionTimelineRecord {
  /** 发送的动作本体(摘要 = type + 关键参数)。 */
  readonly action: ActionObject;
  /** 该动作的响应(onActionResponse 流,按到达序)。 */
  readonly response: ActionResponse;
  /** 响应时刻(epoch 毫秒,可选)。 */
  readonly at?: number;
}

/** 提交时间线记录(submit REST 响应切片,可选输入)。 */
export interface SubmitTimelineRecord {
  readonly submissionId: string;
  readonly revision: number;
  readonly at?: number;
}

/** 动作摘要:type + 关键参数摘要(地址 0x 小写、字节长度、暂停事件、标签)。 */
export function summarizeActionObject(action: ActionObject): string {
  switch (action.type) {
    case "write_bytes":
      return t("timeline.writeBytes", {
        address: formatAddressHex(action.args.addressHex),
        count: action.args.bytesHex.length / 2,
      });
    case "push":
      return `push ${action.args.valueHex}`;
    case "call":
      return `call ${formatAddressHex(action.args.targetHex)}`;
    case "run_to_event":
      return `run_to_event(${action.args.pauseOn})`;
    case "create_checkpoint":
      return action.args.label === undefined
        ? "create_checkpoint"
        : `create_checkpoint "${action.args.label}"`;
    case "checkout_checkpoint":
      return `checkout_checkpoint ${action.args.checkpointId}`;
    default:
      // 无参动作(pop/ret/step/pause/undo/reset)与兜底:只呈现类型名。
      return action.type;
  }
}

/** 条目排序键:revision 升序,同 revision 按 kind 次序稳定(动作 → checkpoint → submit)。 */
const KIND_ORDER: Record<TimelineEntryKind, number> = { action: 0, checkpoint: 1, submit: 2 };

/**
 * buildTimeline —— 动作响应流 + checkpoint 列表(+可选提交记录)→ 时间线条目。
 * 全部输入只读;输出为新数组(客户端自账本,零服务端往返)。
 */
export function buildTimeline(
  actionResponses: readonly ActionTimelineRecord[],
  checkpoints: readonly CheckpointRef[],
  submissions: readonly SubmitTimelineRecord[] = [],
): TimelineEntry[] {
  // checkpoint 按 revision 索引:对齐 create_checkpoint 动作响应(去重呈现)。
  const checkpointByRevision = new Map<number, CheckpointRef>();
  for (const checkpoint of checkpoints) {
    if (!checkpointByRevision.has(checkpoint.revision)) {
      checkpointByRevision.set(checkpoint.revision, checkpoint);
    }
  }

  const unsorted: TimelineEntry[] = [];
  for (const record of actionResponses) {
    const { action, response } = record;
    const checkpoint = checkpointByRevision.get(response.revision);
    // create_checkpoint 响应且列表已有同 revision 条目 → 只保留 checkpoint 条目。
    if (action.type === "create_checkpoint" && checkpoint !== undefined) {
      continue;
    }
    unsorted.push({
      seq: 0,
      kind: "action",
      label: summarizeActionObject(action),
      revision: response.revision,
      ...(record.at !== undefined ? { at: record.at } : {}),
      status: response.status,
    });
  }
  for (const checkpoint of checkpoints) {
    unsorted.push({
      seq: 0,
      kind: "checkpoint",
      label:
        checkpoint.label === undefined
          ? t("timeline.checkpointRef", { id: checkpoint.checkpointId })
          : t("timeline.checkpointLabeled", { label: checkpoint.label }),
      revision: checkpoint.revision,
      checkpointId: checkpoint.checkpointId,
    });
  }
  for (const submission of submissions) {
    unsorted.push({
      seq: 0,
      kind: "submit",
      label: t("timeline.submitRef", { id: submission.submissionId }),
      revision: submission.revision,
      ...(submission.at !== undefined ? { at: submission.at } : {}),
      submissionId: submission.submissionId,
    });
  }

  // 稳定排序:revision 升序,同 revision 按动作 → checkpoint → submit。
  const sorted = [...unsorted].sort((a, b) => {
    if (a.revision !== b.revision) {
      return a.revision - b.revision;
    }
    return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  });
  return sorted.map((entry, index) => ({ ...entry, seq: index + 1 }));
}

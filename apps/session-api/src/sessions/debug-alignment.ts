/**
 * 调试克隆「对齐源」解析(中期 M3 遗留移交清单第 6 项;D-API-145)。
 *
 * # 缺陷(本模块存在的理由)
 *
 * 调试实例 = attach 时按 `origin.revision` **重放权威动作日志**得到的克隆。
 * 旧实现的唯一对齐源是**已落库**的 `action_log`,而该表只在 `submit` 时落库
 * (`LiveSessionManager#persistActionLogDelta`,D-API-56)⇒ **未提交会话**
 * 的克隆恒为**种子初始态**(真机取证:M2 期请求 `targetRevision: 1`、实际
 * 对齐 `revision: 0`,栈区全 `0x00`)——即「对齐源」选错,克隆静默退化为
 * 种子态而非精确对齐到请求的 revision。
 *
 * # 定案对齐源(D-API-145)
 *
 *   **在途会话的权威动作日志** = `SubmitReference.actionLog`(编排核心
 *   `acceptedActions` 账本的同源投影,仅已接受动作;`submit()` 对该账本是
 *   纯读取、零副作用),**以已落库 `action_log` 补齐其在途账本基线之前的
 *   前缀**(重启恢复场景:恢复后的账本自快照 revision 起重启,基线之前的
 *   条目只存在于已落库日志里)。
 *
 * 两条来源都不含秘密(动作 = 玩家输入,公开面),故合并结果可安全进入
 * 调试进程;真实快照字节仍**零装载**(ADR-DC1 条款 3 未动)。
 *
 * # 精确对齐语义(非「尽量接近」)
 *
 * `origin.revision` 的含义被收紧为**精确对齐点**:克隆必须逐条重放到该
 * revision。因此本模块只接受**从 revision 0 起连续**的合并日志,并返回
 *  - `aligned = true`:重放序恰为 `1..targetRevision`(逐字节确定的克隆);
 *  - `aligned = false`:该 revision **在途不可得**(合并日志在到达 target 前
 *    即有缺口,例如恢复基线高于已落库前缀 / 日志被裁剪),调用方须以
 *    **确定性失败**呈现(冻结 `invalid_input_format` / `"revision is not
 *    available"`),**禁止静默退回种子态**(正是本缺陷的成因)。
 *
 * 纯函数:零 IO、零时钟、零随机——同一输入逐字节同一输出(确定性可断言)。
 */
import type { ActionObject } from "@stackmaster/protocol";

/** 权威动作日志条目(在途账本与已落库行同形,仅已接受动作)。 */
export interface DebugAlignmentEntry {
  readonly clientSeq: number;
  readonly revisionAfter: number;
  readonly action: ActionObject;
}

export interface DebugAlignmentInput {
  /** 请求的精确对齐点(`debug_attach.origin.revision` / checkpoint 的日志位置)。 */
  readonly targetRevision: number;
  /** 在途会话权威动作日志(`SubmitReference.actionLog`;`inFlightBase + 1` 起连续)。 */
  readonly inFlight: readonly DebugAlignmentEntry[];
  /** 在途账本基线 revision(新建会话 = 0;重启恢复的会话 = 快照 revision)。 */
  readonly inFlightBase: number;
  /** 已落库权威动作日志(`ActionLogStore.listBySession`;可能只覆盖到上次 submit)。 */
  readonly persisted: readonly DebugAlignmentEntry[];
}

export interface DebugAlignmentResolution {
  /**
   * 精确对齐到 `targetRevision` 的重放序(重放起点固定为变体装载后的
   * revision 0,故恒为 `revisionAfter = 1..targetRevision`;`targetRevision = 0`
   * 时为空数组)。
   */
  readonly entries: readonly DebugAlignmentEntry[];
  /**
   * 合并日志**从 revision 0 起连续**覆盖的上界。`aligned = true` 时等于
   * `targetRevision`;`aligned = false` 时为缺口前的最后一个连续 revision
   * (= 可用于诊断的"最远可精确对齐点")。
   */
  readonly availableMax: number;
  /** `targetRevision` 是否在途可得(精确对齐可行)。 */
  readonly aligned: boolean;
}

/**
 * 在途账本基线解析:`SubmitReference.actionLog` 为空时基线 = 当前权威
 * revision(新建会话 0;恢复会话 = 快照 revision),否则 = 首条条目前一
 * revision(条目自基线 + 1 起连续)。
 */
export function inFlightLedgerBase(
  revision: number,
  inFlight: readonly DebugAlignmentEntry[],
): number {
  const first = inFlight[0];
  return first === undefined ? Math.max(0, revision) : Math.max(0, first.revisionAfter - 1);
}

/**
 * 对齐源合并 + 精确覆盖判定(纯函数,见文件头语义)。
 *
 * 合并规则:已落库日志只补**在途账本基线之前**的区间(恢复会话的前缀);
 * 基线之后的条目一律以在途账本为准(在途永远比已落库新,且已落库日志在
 * 该区间可能因 submit 间隙而缺条目)。
 */
export function resolveDebugAlignment(input: DebugAlignmentInput): DebugAlignmentResolution {
  const prefix = input.persisted.filter((entry) => entry.revisionAfter <= input.inFlightBase);
  const merged = [...prefix, ...input.inFlight];

  const entries: DebugAlignmentEntry[] = [];
  let availableMax = 0;
  for (const entry of merged) {
    // 逐条连续性:必须恰为下一条(重复 / 乱序 / 缺口一律终止——缺口之后的
    // 条目无法在克隆里表达,继续重放会得到与权威态不符的克隆)。
    if (entry.revisionAfter !== availableMax + 1) {
      break;
    }
    availableMax = entry.revisionAfter;
    if (availableMax <= input.targetRevision) {
      entries.push(entry);
    }
  }

  return {
    entries,
    availableMax,
    // 连续覆盖到 target ⇒ 重放序长度恰为 target(条目自 1 起连续)。
    aligned: entries.length === input.targetRevision,
  };
}

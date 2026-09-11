/**
 * embed-runtime 事件名与事件 detail 类型(事件驱动 API 面)。
 *
 * 全部经 EventTarget(CustomEvent.detail)发出:宿主与 react-wrapper 以
 * addEventListener 订阅;事件 detail 只携带宿主决策所需的最小快照,
 * 零对端消息内容反射(V-12 / 侧信道纪律)。
 */
import type { EmbedCapability, EmbedTheme } from "@stackmaster/protocol";

/** 会话事件名。 */
export const EMBED_SESSION_EVENTS = {
  /** 握手完成(ready 已发出;插件进入就绪)。 */
  handshakeComplete: "handshake-complete",
  /** embed 会话不可用(超时 / 版本协商失败 / dispose;停止控制面投递)。 */
  sessionUnavailable: "embed-session-unavailable",
  /** 违规计数面变化(V-12 宿主本地面)。 */
  violationCountersChanged: "violation-counters-changed",
  /** 插件高度上报(V-7/V-8/V-10 全部通过后;宿主据此调整 iframe 高度)。 */
  heightChanged: "height-changed",
  /** reload() 已发起(新 esid 已生成,宿主据此重建 iframe 并等 load)。 */
  reloadInitiated: "embed-reload-initiated",
} as const;

/** 会话状态机状态。 */
export type EmbedSessionState = "idle" | "awaiting-hello" | "ready" | "unavailable";

/** 会话不可用原因。 */
export type EmbedSessionUnavailableReason =
  | "handshake-timeout"
  | "version-negotiation-failed"
  | "disposed";

/** handshake-complete 事件 detail。 */
export interface EmbedHandshakeCompleteDetail {
  readonly sessionId: string;
  readonly negotiatedVersion: number;
  readonly grantedCapabilities: readonly EmbedCapability[];
  readonly config: { readonly theme: EmbedTheme; readonly language: string };
}

/** embed-session-unavailable 事件 detail。 */
export interface EmbedSessionUnavailableDetail {
  readonly sessionId: string;
  readonly reason: EmbedSessionUnavailableReason;
}

/** violation-counters-changed 事件 detail。 */
export interface EmbedViolationCountersChangedDetail {
  readonly sessionId: string;
  readonly counters: Readonly<Record<string, number>>;
}

/** height-changed 事件 detail(clamped = 被宿主 maxHeightPx 收紧)。 */
export interface EmbedHeightChangedDetail {
  readonly sessionId: string;
  readonly heightPx: number;
  readonly clamped: boolean;
  readonly seq: number;
}

/** embed-reload-initiated 事件 detail。 */
export interface EmbedReloadInitiatedDetail {
  readonly sessionId: string;
  readonly iframeSrc: string;
}

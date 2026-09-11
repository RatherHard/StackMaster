/**
 * 违规计数面(V-12 失败静默的宿主本地面)。
 *
 * 一切入站校验失败只丢弃 + 本地计数:不向对端回复错误、不区分失败原因反馈、
 * 不中断会话(V-12)。计数键以规则编号为前缀(v1/v2/…),供宿主诊断与
 * 13.3 场景测试直接断言;violation-counters-changed 事件随每次递增发出,
 * 携带快照(只增计数器,零反射对端消息内容——侧信道纪律)。
 */

/** 违规计数键(规则编号前缀;state-* 为握手状态违规,§4.5)。 */
export const VIOLATION_COUNTER_KEYS = {
  /** V-1:非 opaque 对端 event.origin ≠ 预期插件来源。 */
  v1OriginMismatch: "v1-origin-mismatch",
  /** V-1':source ≠ 非预期窗口(含非 opaque 路径的窗口绑定复核,V-5)。 */
  v1pSourceMismatch: "v1p-source-mismatch",
  /** V-2:序列化字节超 MAX_EMBED_MESSAGE_BYTES。 */
  v2Oversized: "v2-oversized",
  /** V-2:不可解析为 JSON 对象。 */
  v2NonJson: "v2-non-json",
  /** V-3:版本不在受理集(N-1 窗口)/ 版本协商失败(§4.3)。 */
  v3UnsupportedVersion: "v3-unsupported-version",
  /** V-4:Schema 校验拒绝(未知类型 / 未知字段 / 坏枚举 / 坏标识符)。 */
  v4SchemaInvalid: "v4-schema-invalid",
  /** V-5:sessionId ≠ 当前 esid(含重载轮换后旧值)。 */
  v5SessionMismatch: "v5-session-mismatch",
  /** V-6:类型不属于宿主接收方向集。 */
  v6WrongDirection: "v6-wrong-direction",
  /** V-7:seq ≤ 对端高水位(重复 / 过期)。 */
  v7StaleSeq: "v7-stale-seq",
  /** V-8:未授予能力对应的消息类型出现。 */
  v8CapabilityViolation: "v8-capability-violation",
  /** V-10:按消息类型频率超限(出站自限与入站外圈共用本键)。 */
  v10RateLimit: "v10-rate-limit",
  /** 状态违规:握手完成后再收 hello(§4.5)。 */
  stateHelloAfterReady: "state-hello-after-ready",
  /** 会话不可用(超时 / 版本失败 / dispose)后收到的迟到消息。 */
  unavailableDrop: "unavailable-drop",
} as const;

export type ViolationCounterKey = (typeof VIOLATION_COUNTER_KEYS)[keyof typeof VIOLATION_COUNTER_KEYS];

export type ViolationCountersSnapshot = Readonly<Record<ViolationCounterKey, number>>;

/** 只增计数器集(线程无关;快照为独立冻结副本)。 */
export class ViolationCounters {
  private readonly values = new Map<ViolationCounterKey, number>();

  public record(key: ViolationCounterKey): void {
    this.values.set(key, (this.values.get(key) ?? 0) + 1);
  }

  public get(key: ViolationCounterKey): number {
    return this.values.get(key) ?? 0;
  }

  /** 全键快照(未命中键补 0,形态稳定,便于测试与诊断面板直接渲染)。 */
  public snapshot(): ViolationCountersSnapshot {
    const out = {} as Record<ViolationCounterKey, number>;
    for (const key of Object.values(VIOLATION_COUNTER_KEYS)) {
      out[key] = this.values.get(key) ?? 0;
    }
    return Object.freeze(out);
  }
}

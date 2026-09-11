/**
 * embed-runtime 错误类型(宿主侧 API 面;与 V-12 失败静默严格区分)。
 *
 * V-12 的"失败静默"约束的是 **postMessage 通道对端反馈**:一切入站校验失败
 * 只丢弃 + 本地计数,不回错误、不中断会话(嵌入协议 §五)。本文件的错误
 * 是**宿主调用方编程错误 / 装配错误**(同步 API 误用),不属于对端反馈面,
 * 抛出是确定性契约,不违反 V-12。
 */

/** embed-runtime 错误基类。 */
export class EmbedRuntimeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "EmbedRuntimeError";
  }
}

/** 装配错误:构造选项越界 / 语义非法(如 maxHeightPx 超协议冻结上限)。 */
export class EmbedInvalidOptionError extends EmbedRuntimeError {
  public constructor(message: string) {
    super(message);
    this.name = "EmbedInvalidOptionError";
  }
}

/** port 交付前置缺失:握手未完成 / 未挂接 iframe(D-API-75 备用通道:port 转移为必需前置)。 */
export class EmbedPortDeliveryError extends EmbedRuntimeError {
  public constructor(message: string) {
    super(message);
    this.name = "EmbedPortDeliveryError";
  }
}

/** 会话不可用后仍发起控制面投递(§4.5:宿主侧超时即停止控制面投递)。 */
export class EmbedUnavailableError extends EmbedRuntimeError {
  public constructor(message: string) {
    super(message);
    this.name = "EmbedUnavailableError";
  }
}

/** 能力未授予(§4.4 降级矩阵是宿主的发送义务:未授予恒不发送)。 */
export class EmbedCapabilityNotGrantedError extends EmbedRuntimeError {
  public constructor(message: string) {
    super(message);
    this.name = "EmbedCapabilityNotGrantedError";
  }
}

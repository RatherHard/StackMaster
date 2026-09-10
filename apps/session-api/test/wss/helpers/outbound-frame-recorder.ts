/**
 * 出站帧录制 helper(WP-5 完成标准"通道出站帧可被 WP-7 录制机检完整捕获";
 * 任务分解 WP-7 跨域载荷录制机检的捕获面复用点)。
 *
 * 位置:服务端侧 —— 通道状态机在每帧过冻结 `WssFrameSchema` 自检之后、入
 * 发送缓冲之前回调 `outboundFrameSink`;录制器即该钩子的收集实现。WP-7 的
 * 机检(ZR-B9 共现规则 / ZR-B10 完整事件日志形态 / ZR-B4 / B6 语料零命中)
 * 直接消费 `frames()`,并可配红灯反例证明扫描器可检出。
 *
 * 通道上只有公开投影(硬门槛):帧载荷 = 冻结契约(WssFrame 三值封闭),
 * 录制面不新增任何下发面——它只观察已过契约自检的出站帧。
 */
import type { WssFrame } from "@stackmaster/protocol";

/** 单帧录制记录(时刻为服务端单调时钟读数;非秘密)。 */
export interface OutboundFrameRecord {
  readonly frame: WssFrame;
  readonly recordedAt: number;
}

export class OutboundFrameRecorder {
  readonly #records: OutboundFrameRecord[] = [];

  /** 通道 outboundFrameSink 钩子的实现形态。 */
  readonly sink = (frame: WssFrame): void => {
    this.#records.push({ frame, recordedAt: Date.now() });
  };

  /** 全部已录帧(出序即下发序;WP-7 机检的输入)。 */
  frames(): readonly WssFrame[] {
    return this.#records.map((record) => record.frame);
  }

  /** 指定会话的已录帧(跨多会话装配时的过滤面)。 */
  framesOf(sessionId: string): readonly WssFrame[] {
    return this.frames().filter((frame) => frame.sessionId === sessionId);
  }

  /** 全部记录(含时刻)。 */
  records(): readonly OutboundFrameRecord[] {
    return [...this.#records];
  }

  reset(): void {
    this.#records.length = 0;
  }
}

/**
 * DebugDataSource —— 调试档数据源(WP-F2 占位骨架,WP-F8 填充)。
 *
 * 定位(ADR-DC1 /《前端实施计划》§四):全量语义的调试模式档——任意地址窗口、
 * 全内存检索、指令流(`instructionStream` 仅此档存在)、函数表、原生断点。
 * 数据源 = 调试通道(WP-40 独立端点独立帧族);调试模式档只消费调试通道
 * 数据(其公开性由零装载保证),不得旁路拉取真实私有包内容。
 *
 * 本 WP 只固定类存在与构造签名(视图侧可先行接线),方法体一律抛
 * "调试档由 WP-F8 填充"——禁止以占位实现伪造任何全量语义。
 */
import type {
  AddrRange,
  ByteQuery,
  Hit,
  Instr,
  MemoryDataSource,
  RegisterRow,
  Row,
  VmaList,
} from "./types.js";

/** 调试档构造选项(占位:仅固定构造签名形态;语义面归 WP-F8 定稿)。 */
export interface DebugDataSourceOptions {
  /** 调试通道 URL(WP-40:`GET /sessions/debug-channel`;WP-F8 接线)。 */
  readonly debugChannelUrl?: string;
}

export class DebugDataSource implements MemoryDataSource {
  readonly #options: DebugDataSourceOptions;

  constructor(options: DebugDataSourceOptions = {}) {
    this.#options = options;
  }

  /** 构造选项只读暴露(装配诊断;WP-F8 填充前无语义)。 */
  get options(): DebugDataSourceOptions {
    return this.#options;
  }

  regions(): VmaList {
    throw notImplemented();
  }

  registers(): RegisterRow[] {
    throw notImplemented();
  }

  bytesRows(range: AddrRange): Row[] {
    void range; // 占位:签名即契约面,WP-F8 填充实现。
    throw notImplemented();
  }

  search(query: ByteQuery): Hit[] {
    void query; // 占位:签名即契约面,WP-F8 填充实现。
    throw notImplemented();
  }

  /** 指令流:调试档独有(FE-IN 系;公开档不存在)。 */
  instructionStream(range: AddrRange): Instr[] {
    void range; // 占位:签名即契约面,WP-F8 填充实现。
    throw notImplemented();
  }
}

function notImplemented(): never {
  throw new Error("调试档由 WP-F8 填充");
}

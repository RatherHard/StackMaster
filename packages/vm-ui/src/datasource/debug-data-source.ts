/**
 * DebugDataSource —— 调试档数据源(WP-F8;ADR-DC1 /《前端实施计划》§四)。
 *
 * 定位:全量语义的调试模式档——任意地址窗口、全内存检索、指令流
 * (`instructionStream` 仅此档存在)、函数表、原生地址断点。数据源 = 调试
 * 通道(WP-40 独立端点独立帧族);**调试模式档只消费调试通道数据(其公开性
 * 由零装载保证,ADR-DC1 条款 2),不得旁路拉取真实私有包内容**。
 *
 * **数据模型(主控定案)= 推送 + 显式拉取的本地缓存**,全部属"公开投影与
 * UI 状态"(调试通道数据公开性由零装载保证):
 *  - 窗口缓存:`debug_window_data` 回执(显式 `prefetchWindow` 拉取)按地址
 *    归并成互不重叠的已缓存段;`bytesRows` / `search` 只覆盖缓存窗口,缓存外
 *    = "窗口外"标记(与公开档同形,越界不报错);
 *  - 指令流:`debug_instruction_stream` **推送帧**(每次暂停 → 暂停落点上下文
 *    maxItems=16;§九推送模型,协议 v1 无 C→S 拉取帧)按地址并入;
 *    `instructionStream(range)` 只返回推送覆盖面内的条目,超出 = 空数组;
 *  - 函数表:attach 推送的 `debug_function_table`(恰一次);
 *  - 暂停态:`debug_paused`(step / breakpoint / program_halt / budget);
 *  - 断点集合:调试档 UI 状态(FE-IN-08);
 *  - `regions()` / `registers()` = 解题模式公开投影的**结构同构映射**
 *    (v1 夹具 aslrEnabled 恒缺席/false,区域地址与调试实例一致;aslr-on
 *    题目的调试档区域列表精度 = 结构描述级——D-J8 / D-J10 演进项,登记于
 *    README)。`regions().windowByteLength` = 区域内已缓存字节的最大覆盖面
 *    (中段空洞以窗口外 cell 显式呈现)。
 *
 * **扩展方法契约(调试档独有面,不在 MemoryDataSource 接口上——照接口注释
 * 惯例,视图 duck-typing 探测)**:`prefetchWindow` / `searchAllMemory` /
 * `step` / `runToBreakpoint` / 断点集合管理 / `instructions` / `functions` /
 * `paused` / `attached` / `connectionStatus` / `onChange`。
 *
 * 变更通知:缓存 / 暂停 / 断点 / 连接态变化即分发 `change` 事件(调试通道
 * 推送异步到达,视图订阅后自行 refresh——公开投影的 rAF 合帧归 SessionClient,
 * 本数据源直发,量级 = 调试交互粒度)。
 */
import type { PublicStateProjection } from "@stackmaster/protocol";
import { DEBUG_MAX_BREAKPOINTS, DEBUG_WINDOW_MAX_BYTES } from "@stackmaster/protocol";

import {
  DebugChannelClient,
  DebugChannelClientError,
  type DebugAttachedPayload,
  type DebugChannelEvent,
  type DebugChannelStatus,
  type DebugFrameInstruction,
  type DebugFunctionEntry,
  type DebugPausedPayload,
  type DebugWindowDataPayload,
} from "../client/debug-channel-client.js";import {
  addressToHex,
  bytesHexToBytes,
  normalizeBytesHex,
  normalizeValueHex,
  parseAddressHex,
} from "../render/hex.js";
import { alignDownToRow, ROW_BYTES } from "../render/rows.js";
import type {
  AddrRange,
  ByteCell,
  ByteQuery,
  Hit,
  Instr,
  MemoryDataSource,
  RegisterRow,
  Row,
  VmaEntry,
  VmaList,
} from "./types.js";

// ── 公开类型 ───────────────────────────────────────────────────────────────

/** 指令流缓存条目(展示面:伪机器码 / 文本 / 跳转目标,FE-IN-02/03)。 */
export interface DebugInstructionEntry extends Instr {
  /** 该地址处公开代码区字节(推送条目可选字段,缺席 = 未知,非 null)。 */
  readonly bytesHex?: string;
  /** 跳转目标(仅控制转移条目出现;FE-IN-03 延展显示)。 */
  readonly jumpTargetHex?: string;
}

/** 全内存检索命中(FE-IN-07 字节检索入口;regionId = 区域归属,可为 null)。 */
export interface DebugMemorySearchHit {
  readonly addressHex: string;
  /** 命中处字节回显(服务端与模式等长)。 */
  readonly matchedHex: string;
  /** 命中地址所属可见区域(未映射为 null)。 */
  readonly regionId: string | null;
}

/** 全内存检索结果(hits 按地址升序;truncated = presence-only 截断标记)。 */
export interface DebugMemorySearchResult {
  readonly hits: readonly DebugMemorySearchHit[];
  readonly truncated: boolean;
}

/** 数据源变更事件类别(视图 / 宿主订阅驱动 refresh)。 */
export type DebugDataSourceChangeKind =
  | "attached"
  | "cache"
  | "paused"
  | "breakpoints"
  | "error"
  | "connection";

/** 数据源变更事件。 */
export interface DebugDataSourceChangeEvent {
  readonly kind: DebugDataSourceChangeKind;
  /** kind = breakpoints 时携带当前断点集合(地址升序)。 */
  readonly breakpoints?: readonly string[];
  /** kind = paused 时携带暂停回执。 */
  readonly paused?: DebugPausedPayload;
}

/** DebugDataSource 构造选项。 */
export interface DebugDataSourceOptions {
  /**
   * 公开投影提供者(`regions()` / `registers()` 的结构同构映射源;缺省恒
   * null → 空 VMA / 空寄存器)。工作区装配传 `() => client.store.snapshot`。
   */
  readonly projectionProvider?: () => PublicStateProjection | null;
}

/** 已缓存窗口段(互不重叠、互不相邻;按 start 升序维护)。 */
interface CachedSegment {
  readonly start: bigint;
  readonly bytes: Uint8Array;
}

/** 缺省 prefetch 窗口字节数(地址跳转 / 跳转链延伸的教学展示量级)。 */
export const DEBUG_PREFETCH_DEFAULT_BYTES = 256;

// ── 会话装配 ───────────────────────────────────────────────────────────────

/** 调试档装配的会话最小面(SessionClient 结构兼容;测试可注入替身)。 */
export interface DebugSessionLike {
  readonly sessionId: string | null;
  readonly store: { readonly revision: number | null };
}

/** 调试档装配传输选项(透传 DebugChannelClient;测试注入假套接字)。 */
export type DebugDataSourceTransportOptions = Pick<
  ConstructorParameters<typeof DebugChannelClient>[0],
  "channelUrl" | "baseUrl" | "webSocketFactory" | "generateRequestId"
>;

/**
 * 组合根装配:按会话当前 revision 起点构造调试档数据源(attach origin =
 * revision 重放对齐)。会话未创建返回 null;装配后由调用方 `attach()`
 * (连接 + 自动 attach)驱动,不再重复取 revision。
 */
export function createDebugDataSource(
  session: DebugSessionLike,
  options: DebugDataSourceTransportOptions = {},
): DebugDataSource | null {
  const sessionId = session.sessionId;
  if (sessionId === null) {
    return null;
  }
  const revision = session.store.revision ?? 0;
  return new DebugDataSource(
    new DebugChannelClient({ sessionId, origin: { kind: "revision", revision }, ...options }),
  );
}

// ── DebugDataSource ────────────────────────────────────────────────────────

export class DebugDataSource implements MemoryDataSource {
  readonly #client: DebugChannelClient;
  readonly #projectionProvider: () => PublicStateProjection | null;
  readonly #listeners = new Set<(event: DebugDataSourceChangeEvent) => void>();
  readonly #unsubscribe: () => void;

  /** 已缓存窗口段(升序、互不重叠相邻;窗口显式拉取唯一来源)。 */
  #segments: CachedSegment[] = [];
  /** 指令流缓存(推送唯一来源;地址归一化小写键)。 */
  readonly #instructions = new Map<string, DebugInstructionEntry>();
  /** 函数表(attach 推送;按起始地址排序缓存)。 */
  #functions: readonly DebugFunctionEntry[] = [];
  /** 断点集合(调试档 UI 状态;归一化小写地址)。 */
  readonly #breakpoints = new Set<string>();
  /** 暂停态(最新 debug_paused / attach 携带)。 */
  #paused: DebugPausedPayload | null = null;
  /** 暂停落点地址(rip 锚点来源;attach 携带 paused 与 debug_paused 均更新)。 */
  #pausedAddressHex: string | null = null;
  /** attach 回执。 */
  #attached: DebugAttachedPayload | null = null;

  constructor(client: DebugChannelClient, options: DebugDataSourceOptions = {}) {
    this.#client = client;
    this.#projectionProvider = options.projectionProvider ?? (() => null);
    // 通道事件 → 缓存归并 + 变更分发(单一入口;数据源是通道状态的唯一消费面)。
    this.#unsubscribe = client.onEvent((event) => {
      this.#onChannelEvent(event);
    });
  }

  // ── 订阅与状态面 ─────────────────────────────────────────────────────────

  /** 订阅变更(缓存 / 暂停 / 断点 / 连接);返回退订函数。 */
  onChange(listener: (event: DebugDataSourceChangeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** 当前连接状态。 */
  get connectionStatus(): DebugChannelStatus {
    return this.#client.status;
  }

  /** attach 回执(未完成为 null)。 */
  get attached(): DebugAttachedPayload | null {
    return this.#attached;
  }

  /** 最新暂停态(debug_paused 帧;attach 携带的对齐暂停不算,理由文案不适用)。 */
  get paused(): DebugPausedPayload | null {
    return this.#paused;
  }

  /** 最新暂停落点地址(rip 锚点来源;attach 携带 paused 亦更新)。 */
  get pausedAddressHex(): string | null {
    return this.#pausedAddressHex;
  }

  /** 函数表(按起始地址升序;attach 推送,未到达为空)。 */
  get functions(): readonly DebugFunctionEntry[] {
    return this.#functions;
  }

  /** 断点集合(地址升序快照)。 */
  get breakpoints(): readonly string[] {
    return [...this.#breakpoints].sort((a, b) => {
      const delta = parseAddressHex(a) - parseAddressHex(b);
      return delta < 0n ? -1 : delta > 0n ? 1 : 0;
    });
  }

  /** 断点数量(菜单可用性判断)。 */
  get breakpointCount(): number {
    return this.#breakpoints.size;
  }

  /** 指令流是否命中断点(行渲染标记)。 */
  isBreakpoint(addressHex: string): boolean {
    return this.#breakpoints.has(normalizeAddressHex(addressHex));
  }

  /** 添加断点(FE-IN-08;重复添加为 no-op)。 */
  addBreakpoint(addressHex: string): void {
    const normalized = normalizeAddressHex(addressHex);
    if (this.#breakpoints.has(normalized) || this.#breakpoints.size >= DEBUG_MAX_BREAKPOINTS) {
      return;
    }
    this.#breakpoints.add(normalized);
    this.#emit({ kind: "breakpoints", breakpoints: this.breakpoints });
  }

  /** 移除断点(FE-IN-08;不存在为 no-op)。 */
  removeBreakpoint(addressHex: string): void {
    const normalized = normalizeAddressHex(addressHex);
    if (!this.#breakpoints.has(normalized)) {
      return;
    }
    this.#breakpoints.delete(normalized);
    this.#emit({ kind: "breakpoints", breakpoints: this.breakpoints });
  }

  /** 切换断点(FE-IN-08 指令视图行断点)。 */
  toggleBreakpoint(addressHex: string): void {
    const normalized = normalizeAddressHex(addressHex);
    if (this.#breakpoints.has(normalized)) {
      this.removeBreakpoint(normalized);
    } else {
      this.addBreakpoint(normalized);
    }
  }

  // ── 生命周期与调试动作(扩展方法)────────────────────────────────────────

  /** 连接调试通道并自动 attach(重放对齐由服务端承担;幂等)。 */
  attach(): void {
    this.#client.connect();
  }

  /** 断开并释放(切回解题模式时由组合根调用)。 */
  dispose(): void {
    this.#unsubscribe();
    this.#client.dispose();
  }

  /**
   * 显式窗口拉取(FE-IN-06 / 跳转链延伸):发出 `debug_window` 帧,回执并入
   * 缓存后 resolve。byteLength 夹取到 [1, DEBUG_WINDOW_MAX_BYTES]。
   */
  async prefetchWindow(addressHex: string, byteLength: number = DEBUG_PREFETCH_DEFAULT_BYTES): Promise<DebugWindowDataPayload> {
    const clamped = Math.min(Math.max(Math.trunc(byteLength) || 1, 1), DEBUG_WINDOW_MAX_BYTES);
    const payload = await this.#client.requestWindow(normalizeAddressHex(addressHex), clamped);
    this.#mergeWindow(payload);
    this.#emit({ kind: "cache" });
    return payload;
  }

  /**
   * 全内存字节检索(FE-IN-07 字节入口):`debug_search` 走调试通道全内存,
   * 与同步 `search()`(仅缓存窗口)区分。奇数长度 hex 由通道契约拒绝并 reject。
   */
  async searchAllMemory(patternHex: string, maxHits?: number): Promise<DebugMemorySearchResult> {
    const payload = await this.#client.requestSearch(normalizeBytesHex(patternHex), maxHits);
    const regions = this.#projection()?.visibleRegions ?? [];
    return {
      hits: payload.hits.map((hit) => ({
        addressHex: hit.addressHex,
        matchedHex: normalizeBytesHex(hit.bytesHex),
        regionId: regionIdOf(regions, parseAddressHex(hit.addressHex)),
      })),
      truncated: payload.truncated === true,
    };
  }

  /** 调试实例单步(FE-WS-04a 调试档;resolve = debug_paused)。 */
  async step(): Promise<DebugPausedPayload> {
    return await this.#client.step();
  }

  /**
   * 运行到断点(FE-WS-04c / FE-IN-08):缺省用当前断点集合;显式传入则以
   * 传入集合为准。集合为空确定性抛错(协议 breakpoints ≥ 1)。
   */
  async runToBreakpoint(addresses?: readonly string[]): Promise<DebugPausedPayload> {
    const targets = addresses ?? this.breakpoints;
    if (targets.length === 0) {
      throw new DebugChannelClientError("empty_breakpoints", "断点集合为空:先在指令视图添加地址断点");
    }
    return await this.#client.runToBreakpoint(targets);
  }

  // ── MemoryDataSource 接口(公开投影映射 + 缓存投影)──────────────────────

  /**
   * VMA 列表:公开投影 visibleRegions 的结构同构映射(v1 区域地址与调试实例
   * 一致,见模块头)。`windowByteLength` = 区域内**已缓存字节的最大覆盖前缀**
   * (区域起点 → 最远缓存字节;中段未缓存的地址在 bytesRows 里以"窗口外"
   * cell 显式呈现,不伪造)——区域起点起连续前缀的形态会让中段 prefetch
   * (地址跳转 / 跳转链延伸)对字节视图不可见,故取最大覆盖面。
   */
  regions(): VmaList {
    const projection = this.#projection();
    if (projection === null) {
      return [];
    }
    return projection.visibleRegions.map((region): VmaEntry => {
      const base = parseAddressHex(region.startAddressHex);
      const windowByteLength = Math.min(this.#cachedCoverageFrom(base, region.byteLength), region.byteLength);
      return {
        regionId: region.regionId,
        label: region.label,
        startAddressHex: region.startAddressHex,
        byteLength: region.byteLength,
        permissions: region.permissions,
        windowByteLength,
        truncated: windowByteLength < region.byteLength,
      };
    });
  }

  /**
   * 寄存器行:公开投影 visibleRegisters(调试通道协议 v1 无寄存器帧;对齐后
   * 调试实例与真实实例共享公开条件集,公开投影寄存器面即结构同构的展示面)。
   */
  registers(): RegisterRow[] {
    const projection = this.#projection();
    if (projection === null) {
      return [];
    }
    return projection.visibleRegisters.map((register) => ({
      name: register.name,
      valueHex: normalizeValueHex(register.valueHex),
    }));
  }

  /**
   * 8 字节行(半开区间):行基址 8 对齐,首尾可为部分行;字节只来自缓存窗口,
   * 缓存外 = "窗口外" cell(区域归属可判时带 regionId,与公开档同形)。
   */
  bytesRows(range: AddrRange): Row[] {
    const start = parseAddressHex(range.startAddressHex);
    const end = parseAddressHex(range.endAddressHex);
    if (end <= start) {
      return [];
    }
    const regions = this.#projection()?.visibleRegions ?? [];
    const row = BigInt(ROW_BYTES);
    const rows: Row[] = [];
    let rowBase = alignDownToRow(start, ROW_BYTES);
    while (rowBase < end) {
      const rowEnd = rowBase + row;
      const spanStart = rowBase > start ? rowBase : start;
      const spanEnd = rowEnd < end ? rowEnd : end;
      const cells: ByteCell[] = [];
      for (let address = spanStart; address < spanEnd; address += 1n) {
        const addressHex = addressToHex(address);
        const byte = this.#byteAt(address);
        cells.push({
          addressHex,
          regionId: regionIdOf(regions, address),
          offset: byte === null ? null : offsetInRegion(regions, address),
          byteHex: byte === null ? null : byte.toString(16).padStart(2, "0"),
          byte,
        });
      }
      rows.push({ addressHex: addressToHex(rowBase), cells });
      rowBase = rowEnd;
    }
    return rows;
  }

  /** 字节检索(缓存窗口集;全内存检索走扩展方法 searchAllMemory)。 */
  search(query: ByteQuery): Hit[] {
    if (query.patternHex.length === 0) {
      return [];
    }
    const pattern = normalizeBytesHex(query.patternHex);
    const regions = this.#projection()?.visibleRegions ?? [];
    const hits: Hit[] = [];
    for (const segment of this.#segments) {
      const haystack = bytesToBytesHex(segment.bytes);
      let from = 0;
      for (;;) {
        const at = haystack.indexOf(pattern, from);
        if (at < 0) {
          break;
        }
        if (at % 2 === 0) {
          const address = segment.start + BigInt(at / 2);
          hits.push({
            regionId: regionIdOf(regions, address) ?? "",
            addressHex: addressToHex(address),
            matchedHex: pattern,
          });
        }
        from = at + 1;
      }
    }
    return hits;
  }

  /**
   * 指令流(调试档独有;FE-IN-01):返回缓存指令流(推送覆盖面)中落在
   * [start, end) 的条目(按地址升序);超出覆盖面 = 空数组(协议 v1 无
   * 拉取帧,推送是唯一来源)。
   */
  instructionStream(range: AddrRange): Instr[] {
    const start = parseAddressHex(range.startAddressHex);
    const end = parseAddressHex(range.endAddressHex);
    return this.#sortedInstructions()
      .filter((entry) => {
        const address = parseAddressHex(entry.addressHex);
        return address >= start && address < end;
      })
      .map((entry) => ({ addressHex: entry.addressHex, text: entry.text }));
  }

  /** 指令流全量缓存(升序;含 bytesHex / jumpTargetHex 展示面,FE-IN-02/03)。 */
  instructions(): readonly DebugInstructionEntry[] {
    return this.#sortedInstructions();
  }

  /** 某地址处指令缓存(命中返回条目;地址跳转 / 跳转目标定位用)。 */
  instructionAt(addressHex: string): DebugInstructionEntry | null {
    return this.#instructions.get(normalizeAddressHex(addressHex)) ?? null;
  }

  // ── 内部:通道事件归并 ───────────────────────────────────────────────────

  #onChannelEvent(event: DebugChannelEvent): void {
    switch (event.kind) {
      case "attached":
        this.#attached = event.payload;
        this.#pausedAddressHex =
          event.payload.paused === undefined ? null : normalizeAddressHex(event.payload.paused.addressHex);
        this.#emit({ kind: "attached" });
        return;
      case "window-data":
        this.#mergeWindow(event.payload);
        this.#emit({ kind: "cache" });
        return;
      case "paused":
        this.#paused = event.payload;
        this.#pausedAddressHex = normalizeAddressHex(event.payload.addressHex);
        this.#emit({ kind: "paused", paused: event.payload });
        return;
      case "instruction-stream":
        for (const instruction of event.payload.instructions) {
          this.#mergeInstruction(instruction);
        }
        this.#emit({ kind: "cache" });
        return;
      case "function-table":
        this.#functions = [...event.payload.functions].sort((a, b) => {
          const delta = parseAddressHex(a.startAddressHex) - parseAddressHex(b.startAddressHex);
          return delta < 0n ? -1 : delta > 0n ? 1 : 0;
        });
        this.#emit({ kind: "cache" });
        return;
      case "search-results":
        // 检索回执由 searchAllMemory 的 promise 承载;缓存无变化,不再转发。
        return;
      case "error":
        this.#emit({ kind: "error" });
        return;
      case "status":
        this.#emit({ kind: "connection" });
        return;
    }
  }

  /** 窗口回执 → 缓存段归并(重叠 / 相邻段合并为单一连续段)。 */
  #mergeWindow(payload: DebugWindowDataPayload): void {
    const start = parseAddressHex(payload.addressHex);
    const bytes = bytesHexToBytes(payload.bytesHex);
    if (bytes.length === 0) {
      return;
    }
    const end = start + BigInt(bytes.length);
    // 重叠 / 相邻段(含新回执边界)归并为单一连续段;已知窗口字节以新回执为准。
    const overlap = this.#segments.filter((segment) => {
      const segmentEnd = segment.start + BigInt(segment.bytes.length);
      return segmentEnd >= start && segment.start <= end;
    });
    const mergedStart =
      overlap.length > 0 && overlap[0]!.start < start ? overlap[0]!.start : start;
    const mergedEnd = overlap.reduce((acc, segment) => {
      const segmentEnd = segment.start + BigInt(segment.bytes.length);
      return segmentEnd > acc ? segmentEnd : acc;
    }, end);
    const merged = new Uint8Array(Number(mergedEnd - mergedStart));
    for (const segment of overlap) {
      merged.set(segment.bytes, Number(segment.start - mergedStart));
    }
    merged.set(bytes, Number(start - mergedStart));
    const kept = this.#segments.filter((segment) => !overlap.includes(segment));
    kept.push({ start: mergedStart, bytes: merged });
    kept.sort((a, b) => (a.start < b.start ? -1 : 1));
    this.#segments = kept;
  }

  #mergeInstruction(instruction: DebugFrameInstruction): void {
    const key = normalizeAddressHex(instruction.addressHex);
    const entry: DebugInstructionEntry = {
      addressHex: key,
      text: instruction.text,
      ...(instruction.bytesHex === undefined ? {} : { bytesHex: normalizeBytesHex(instruction.bytesHex) }),
      ...(instruction.jumpTargetHex === undefined
        ? {}
        : { jumpTargetHex: normalizeAddressHex(instruction.jumpTargetHex) }),
    };
    this.#instructions.set(key, entry);
  }

  #sortedInstructions(): readonly DebugInstructionEntry[] {
    return [...this.#instructions.values()].sort((a, b) => {
      const delta = parseAddressHex(a.addressHex) - parseAddressHex(b.addressHex);
      return delta < 0n ? -1 : delta > 0n ? 1 : 0;
    });
  }

  /** 缓存字节查找(二分;缓存外 null)。 */
  #byteAt(address: bigint): number | null {
    let low = 0;
    let high = this.#segments.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const segment = this.#segments[mid] as CachedSegment;
      const segmentEnd = segment.start + BigInt(segment.bytes.length);
      if (address < segment.start) {
        high = mid - 1;
      } else if (address >= segmentEnd) {
        low = mid + 1;
      } else {
        return segment.bytes[Number(address - segment.start)] ?? null;
      }
    }
    return null;
  }

  /**
   * 区域内已缓存字节的最大覆盖长度(区域起点 → 与区域相交的缓存段的最远
   * 末尾;无缓存 = 0,中段空洞由 bytesRows 的窗口外 cell 显式表达)。
   */
  #cachedCoverageFrom(base: bigint, byteLength: number): number {
    const regionEnd = base + BigInt(byteLength);
    let maxEnd = base;
    for (const segment of this.#segments) {
      const segmentEnd = segment.start + BigInt(segment.bytes.length);
      if (segmentEnd <= base || segment.start >= regionEnd) {
        continue;
      }
      if (segmentEnd > maxEnd) {
        maxEnd = segmentEnd;
      }
    }
    return Number(maxEnd - base);
  }

  #projection(): PublicStateProjection | null {
    return this.#projectionProvider();
  }

  #emit(event: DebugDataSourceChangeEvent): void {
    for (const listener of [...this.#listeners]) {
      listener(event);
    }
  }
}

// ── 帮助函数 ────────────────────────────────────────────────────────────────

/** 地址归一化(`0x` + 小写;非法地址抛错——契约面输入不静默容忍漂移)。 */
function normalizeAddressHex(addressHex: string): string {
  return addressToHex(parseAddressHex(addressHex));
}

/** 字节数组 → 小写 bytesHex(缓存检索 haystack)。 */
function bytesToBytesHex(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 1) {
    out += (bytes[index] as number).toString(16).padStart(2, "0");
  }
  return out;
}

/** 地址 → 所属可见区域 id(按区域全长范围;未映射 null)。 */
function regionIdOf(
  regions: readonly PublicStateProjection["visibleRegions"][number][],
  address: bigint,
): string | null {
  for (const region of regions) {
    const base = parseAddressHex(region.startAddressHex);
    if (address >= base && address < base + BigInt(region.byteLength)) {
      return region.regionId;
    }
  }
  return null;
}

/** 地址 → 区域内偏移(调用方保证已命中区域)。 */
function offsetInRegion(
  regions: readonly PublicStateProjection["visibleRegions"][number][],
  address: bigint,
): number | null {
  for (const region of regions) {
    const base = parseAddressHex(region.startAddressHex);
    if (address >= base && address < base + BigInt(region.byteLength)) {
      return Number(address - base);
    }
  }
  return null;
}

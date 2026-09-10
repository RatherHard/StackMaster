/**
 * ProjectionStore —— 公开投影状态存储(WP-F2)。
 *
 * 职责(硬门槛:浏览器任何位置只保存公开投影与 UI 状态):
 *  - 保存最近一次 `PublicStateProjection`(七字段冻结契约);
 *  - 应用 `ProjectionDelta`:dirtyRanges → 按区域/偏移的字节更新、
 *    changedRegisters → 按名替换、controlFlow / status / callStackSummary →
 *    存在即整体替换(协议 I-4 存在性确定性 + 整体替换语义);
 *  - `semanticHighlights` 只随初始投影(create_session)与 sync 全量存在:
 *    增量携带时整体替换,缺省时**保持不变**(不被 delta 清除);
 *  - 订阅 API:变更事件逐次同步分发,由 SessionClient 以 rAF 合帧后批量
 *    通知视图(每帧至多一次);本存储自身不做合帧。
 *
 * 纪律:
 *  - 写时复制:任何变更都构造新投影对象,已发出的快照引用不被原地修改
 *    ("冻结公开投影"的轻量实现,数据源可安全缓存);
 *  - revision 对齐:增量 revision 必须等于当前 revision 才应用;错位返回
 *    false(调用方以 sync-projection 重新对齐,禁止本地推导补齐);
 *  - IndexedDB 持久化本 WP 不做(只保存公开投影与 UI 状态,无会话历史落盘)。
 */
import type {
  ProjectionDelta,
  PublicStateProjection,
  PublicRegister,
} from "@stackmaster/protocol";
import { parseAddressHex } from "../render/hex.js";

/** 投影变更类别。 */
export type ProjectionChangeKind =
  /** 全量替换(create_session 初始投影 / sync_projection 重发)。 */
  | "replace"
  /** 增量应用(ActionResponse.projectionDelta)。 */
  | "delta"
  /** 仅 revision 前进(delta 为 null 的已执行动作,如 create_checkpoint)。 */
  | "revision";

/** 投影变更事件(revision = 变更后的权威 revision)。 */
export interface ProjectionChange {
  readonly kind: ProjectionChangeKind;
  readonly revision: number;
  /** kind === "delta" 时携带该增量;其余为 null。 */
  readonly delta: ProjectionDelta | null;
}

export type ProjectionChangeListener = (change: ProjectionChange) => void;

export class ProjectionStore {
  #projection: PublicStateProjection | null = null;
  readonly #listeners = new Set<ProjectionChangeListener>();

  /** 最近一次公开投影快照(写时复制;无投影时为 null——断线也保留最近快照)。 */
  get snapshot(): PublicStateProjection | null {
    return this.#projection;
  }

  /** 最近一次权威 revision(无投影为 null)。 */
  get revision(): number | null {
    return this.#projection?.revision ?? null;
  }

  /** 订阅变更;返回退订函数。 */
  subscribe(listener: ProjectionChangeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * 全量替换(create_session / sync_projection):整体替换最近投影,
   * 含 semanticHighlights(初始投影 / sync 全量是 highlights 的唯一来源)。
   */
  replaceProjection(projection: PublicStateProjection): void {
    this.#projection = projection;
    this.#emit({ kind: "replace", revision: projection.revision, delta: null });
  }

  /**
   * 增量应用。delta.revision 是本增量描述的**目标** revision(= 动作信封
   * revision,已执行动作恒前进 1),因此仅当其为当前 revision 的严格后继时
   * 应用(返回 true);错位(跳号 / 滞后)不应用并返回 false——对齐走
   * sync-projection,不做本地推导。
   */
  applyDelta(delta: ProjectionDelta): boolean {
    const previous = this.#projection;
    if (previous === null || delta.revision !== previous.revision + 1) {
      return false;
    }
    this.#projection = {
      ...previous,
      revision: delta.revision,
      visibleRegions: applyDirtyRanges(previous.visibleRegions, delta),
      visibleRegisters: mergeRegisters(previous.visibleRegisters, delta.changedRegisters),
      ...(delta.controlFlow !== undefined ? { controlFlow: delta.controlFlow } : {}),
      ...(delta.status !== undefined ? { status: delta.status } : {}),
      ...(delta.callStackSummary !== undefined
        ? { callStackSummary: delta.callStackSummary }
        : {}),
      // semanticHighlights 存在即整体替换、缺省保持(I-4 整体替换语义)。
      ...(delta.semanticHighlights !== undefined
        ? { semanticHighlights: delta.semanticHighlights }
        : {}),
    };
    this.#emit({ kind: "delta", revision: delta.revision, delta });
    return true;
  }

  /**
   * 仅前进 revision(无投影变化的已执行动作:projectionDelta === null,
   * 如 create_checkpoint)。终态前进(revision 落后/相等)为 no-op 并返回 false。
   */
  advanceRevision(revision: number): boolean {
    const previous = this.#projection;
    if (previous === null || revision <= previous.revision) {
      return false;
    }
    this.#projection = { ...previous, revision };
    this.#emit({ kind: "revision", revision, delta: null });
    return true;
  }

  #emit(change: ProjectionChange): void {
    for (const listener of [...this.#listeners]) {
      listener(change);
    }
  }
}

/**
 * dirtyRanges → 按区域/偏移的字节更新:对引用区域把合并写入按偏移拼入
 * 锚定窗口字节串;越出窗口(窗口 = 区域起点前缀,D3)的部分裁剪——窗口只展示
 * 区域起点前缀,窗口外写入不影响交付字节。引用未知区域的 range 防御性跳过。
 */
function applyDirtyRanges(
  regions: PublicStateProjection["visibleRegions"],
  delta: ProjectionDelta,
): PublicStateProjection["visibleRegions"] {
  if (delta.dirtyRanges.length === 0) {
    return regions;
  }
  return regions.map((region) => {
    const touched = delta.dirtyRanges.filter((range) => range.regionId === region.regionId);
    if (touched.length === 0) {
      return region;
    }
    let bytesHex = region.bytesHex;
    for (const range of touched) {
      bytesHex = spliceWindowBytes(region.startAddressHex, bytesHex, range.startAddressHex, range.bytesHex);
    }
    return { ...region, bytesHex };
  });
}

/** 把 range.bytesHex 拼入区域窗口字节串(裁剪出界部分;窗口外写入不扩展窗口)。 */
function spliceWindowBytes(
  regionStartHex: string,
  windowBytesHex: string,
  rangeStartHex: string,
  rangeBytesHex: string,
): string {
  const windowBytes = windowBytesHex.length / 2;
  const offset = Number(parseAddressHex(rangeStartHex) - parseAddressHex(regionStartHex));
  if (!Number.isInteger(offset) || offset < 0) {
    return windowBytesHex; // 起点不在本区域窗口坐标系内:防御性跳过。
  }
  const rangeBytes = rangeBytesHex.length / 2;
  const start = offset;
  const end = Math.min(offset + rangeBytes, windowBytes);
  if (end <= start) {
    return windowBytesHex; // 完全在窗口外:不产生可见变化。
  }
  const prefix = windowBytesHex.slice(0, start * 2);
  const replacement = rangeBytesHex.slice(0, (end - start) * 2);
  const suffix = windowBytesHex.slice(end * 2);
  return `${prefix}${replacement}${suffix}`;
}

/** changedRegisters → 按名替换(保持白名单投影顺序;未知寄存器防御性忽略)。 */
function mergeRegisters(
  registers: readonly PublicRegister[],
  changed: readonly PublicRegister[],
): PublicRegister[] {
  if (changed.length === 0) {
    return [...registers];
  }
  const changedByName = new Map(changed.map((register) => [register.name, register]));
  const merged = registers.map(
    (register) => changedByName.get(register.name) ?? register,
  );
  return merged;
}

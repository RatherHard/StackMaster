/**
 * MemoryDataSource —— 双档数据源抽象(《前端实施计划》§四,WP-F2 定稿)。
 *
 * **视图组件只许依赖此接口**(WP-F3 字节视图 / WP-F4 寄存器视图消费;
 * WP-F8 调试档填充)——这是"ADR-DC1 评审结果不影响已写代码"的唯一保证点:
 * 视图禁止绕过接口直读 session-client 投影存储(评审解耦的关键约束,
 * 前端实施计划 §四;README 同款纪律条目)。
 *
 * 双档语义:
 *  - 公开档 `ProjectionDataSource`:数据源 = 冻结公开投影,语义受 D3
 *    (窗口锚定区域起点)与 `currentInstruction` 单条约束——越界查询返回
 *    "窗口外"标记而非报错;`instructionStream` 恒 undefined;
 *  - 调试档 `DebugDataSource`:ADR-DC1 评审后填充(WP-F8),全量语义;
 *    `instructionStream` 仅此档存在。
 *
 * 地址区间记法:本接口面的区间统一为**半开区间** [startAddressHex, endAddressHex)。
 */

/** 地址区间(半开区间 [startAddressHex, endAddressHex);0x 前缀十六进制)。 */
export interface AddrRange {
  readonly startAddressHex: string;
  readonly endAddressHex: string;
}

/** 字节检索查询(WP-F3 窗口内字节检索;模式为偶数长度十六进制串,大小写均可)。 */
export interface ByteQuery {
  readonly patternHex: string;
}

/** 检索命中:命中地址 + 命中字节回显(公开档仅在已下发窗口字节内产生命中)。 */
export interface Hit {
  readonly regionId: string;
  readonly addressHex: string;
  /** 命中字节序列(小写十六进制,无 0x 前缀)。 */
  readonly matchedHex: string;
}

/** 寄存器展示行(FE-RG-01/02);valueHex 恒 `0x` + 大写十六进制(契约归一化形态)。 */
export interface RegisterRow {
  readonly name: string;
  readonly valueHex: string;
}

/** VMA 列表条目(FE-FV-06;可见内存区域公开布局直读,含锚定窗口交付尺寸)。 */
export interface VmaEntry {
  readonly regionId: string;
  readonly label: string;
  readonly startAddressHex: string;
  readonly byteLength: number;
  /** r/w/x 子集(规范书写序 r < w < x)。 */
  readonly permissions: string;
  /** 锚定窗口实际下发字节数(D3:窗口 = 区域起点前缀 min(byteLength, maxBytesPerRange))。 */
  readonly windowByteLength: number;
  /** D3 统一截断标记(true = 窗口被 maxBytesPerRange 截断)。 */
  readonly truncated: boolean;
}

/** VMA 列表(regions() 返回值;按投影 visibleRegions 顺序)。 */
export type VmaList = readonly VmaEntry[];

/** 调试档指令流条目(WP-F8;公开档不存在 instructionStream)。 */
export interface Instr {
  readonly addressHex: string;
  /** 服务端生成的伪指令展示文本(非可执行 IR)。 */
  readonly text: string;
}

/**
 * 单字节单元格:窗口内字节携带内容;窗口外为统一"窗口外"标记(D3——
 * 越界查询返回窗口外标记而非报错),`byteHex` / `byte` / `offset` 为 null。
 * `regionId` 在字节属于某可见区域(即使窗口外)时携带,供视图标注归属。
 */
export interface ByteCell {
  readonly addressHex: string;
  readonly regionId: string | null;
  /** 区域内字节偏移(0 起;窗口外为 null)。 */
  readonly offset: number | null;
  /** 小写十六进制字节(如 "0a";窗口外为 null)。 */
  readonly byteHex: string | null;
  /** 字节值(0–255;窗口外为 null;渲染原语直接消费)。 */
  readonly byte: number | null;
}

/**
 * 8 字节行(FE-ST-01 三段布局的数据建模):
 *  - 第一段 = `addressHex`(行基地址,8 字节对齐,展示层恒小写);
 *  - 第二段 = 十六进制段(由 `cells[].byteHex` 拼接,render/hex 分组格式化);
 *  - 第三段 = 特殊显示段(render/special-display 逐 cell 渲染)。
 *
 * `cells` 长度 = 行与查询范围交集的字节数(1–8):查询范围按行对齐时恒为 8,
 * 区间首尾可为部分行;行跨区域边界 / 窗口边界时以"窗口外"cell 填充。
 */
export interface Row {
  readonly addressHex: string;
  readonly cells: readonly ByteCell[];
}

/**
 * 双档数据源接口(UI 组件唯一依赖面;照《前端实施计划》§四定稿):
 *
 * ```text
 * interface MemoryDataSource {          // UI 组件只依赖此接口
 *   regions(): VmaList;                 // FE-FV-06
 *   registers(): RegisterRow[];         // FE-RG-01/02
 *   bytesRows(range: AddrRange): Row[]; // FE-ST/FE-FV 行渲染
 *   search(query: ByteQuery): Hit[];
 *   instructionStream?(range): Instr[]; // 调试档独有;公开档 undefined
 * }
 * ```
 */
export interface MemoryDataSource {
  /** VMA 列表(FE-FV-06):可见内存区域公开布局。 */
  regions(): VmaList;
  /** 寄存器行(FE-RG-01/02):白名单寄存器展示面。 */
  registers(): RegisterRow[];
  /** 8 字节行渲染(FE-ST/FE-FV):越界字节以"窗口外"cell 表达,不报错。 */
  bytesRows(range: AddrRange): Row[];
  /** 字节检索(公开档仅在已下发窗口字节内检索)。 */
  search(query: ByteQuery): Hit[];
  /**
   * 指令流(调试档独有):公开档不存在此方法(ProjectionDataSource 未实现,
   * `dataSource.instructionStream === undefined`)。
   */
  instructionStream?(range: AddrRange): Instr[];
}

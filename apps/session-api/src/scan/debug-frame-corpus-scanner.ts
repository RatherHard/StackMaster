/**
 * 调试通道帧语料包含性扫描器(阶段四 WP-44;ZR-B12,ADR-DC1 §四前置项 5)。
 *
 * 断言语义(上游条目:`docs/contracts/数据分类与秘密零驻留清单.md` §9.1
 * ZR-B12 行;整体公开性论证:同文档 §6.8 结构性路径——展示载荷值来源 ⊆
 * 调试变体镜像字节 + 公开代码区 + 玩家输入,封闭集;ADR-DC1 条款 2):
 *
 *  - 调试通道 **S→C 出站帧**中承载内存字节的字段(debug_window_data 的
 *    `bytesHex`、debug_search_results 的 `hits[].bytesHex`、
 *    debug_instruction_stream 的 `instructions[].bytesHex`)逐值断言
 *    ⊆ **调试变体镜像** `memoryRegions.contentHex`(以变体自身为语料全集,
 *    不拿真实镜像当全集——WP-42 定案:两镜像恰在派生槽上可区分);按帧的
 *    `addressHex` 定位区域后做**子串包含**;
 *  - **玩家输入回显语料**为并列合法来源:权威动作日志 `write_bytes` 的
 *    `bytesHex`(§6.8 封闭集第三源;确定性重放使其出现在调试实例内存与
 *    出站帧中,不列即集成层必然真阳性);
 *  - **错误帧 / 控制帧无内存字节载荷天然通过**(error = 冻结 PublicError;
 *    debug_attached / debug_paused 只承载地址与状态枚举;C→S 请求帧是玩家
 *    输入回传,不是本扫描器的断言对象);
 *  - **字段位置白名单放行**(封闭枚举,带放行理由):
 *    - 地址类字段(`addressHex` / `startAddressHex` / `jumpTargetHex`):
 *      调试实例布局常量,ASLR 差异是教学语义非泄露面(WP-40 协议语义 §五);
 *    - 展示文本字段(`instructions[].text` / `functions[].label`):源 =
 *      公开代码区派生(I-10 静态模板类,§6.8 生成纪律)。放行不是豁免——
 *      附**走私字节边界检查**:文本中长度 > 16 个十六进制字符(> 8 字节,
 *      超出 u64 数值渲染上限)的连续十六进制串必 ∈ 语料,否则命中。≤ 16
 *      字符的十六进制串按数值操作数渲染放行(展示面 `0x…` 立即数 / 位移 /
 *      跳转目标的合法形态)。
 *
 * 执行面边界(如实登记,见上游 v1.13 论证):子串包含不是逐字节重建——引擎
 * 执行派生的运行时字节(如 `push` 写栈)是变体镜像 × 玩家输入 × 确定性引擎
 * 的派生物,不在子串语料内,其公开性由 ADR-DC1 条款 3 确定性重放 + ZR-B13
 * 派生复算承接;集成脚本以对齐窗口覆盖对齐面。语料法(ZR-B1 / B6)在同一
 * 录制集上的职责分工不变(由 cross-domain-payload-scanner 并行承担)。
 *
 * 定位纪律(与 cross-domain-payload-scanner 同一立场):本扫描器是**录制
 * 机检的测试锚点**,不是运行时硬闸;运行于双层——纯模块单测(常规 CI)+
 * 生产 Provider 真实变体 × 真实 vm-worker 的 SESSION_API_IT 门控集成(红灯
 * 注入与零命中同套件,证明机检有效)。
 *
 * 纯模块:零依赖、零 IO(与 cross-domain-payload-scanner 同风格);帧输入
 * 取结构形态({type, payload}),与 `@stackmaster/protocol` 冻结 Schema 解析
 * 产物结构兼容, Schema 演进时不与本文件产生耦合。
 */

/** 机检命中(条目 ID 携带上游清单编号;path 为帧内 JSON 指针风格路径)。 */
export interface ZrB12Violation {
  readonly id:
    | "ZR-B12-address-outside-variant"
    | "ZR-B12-bytes-not-in-variant-corpus"
    | "ZR-B12-text-smuggled-bytes";
  readonly path: string;
  /** 命中证据(越界地址 / 语料外字节串前缀 / 走私十六进制串;非真实秘密)。 */
  readonly token: string;
  readonly detail: string;
}

/** 帧输入的结构视图(与冻结 DebugFrame Schema 解析产物结构兼容)。 */
export interface DebugFrameScanView {
  readonly type: string;
  readonly payload: unknown;
}

/** 调试变体内存区域视图(WP-40 DebugVariantBundle.memoryRegions 同构子集)。 */
export interface DebugVariantRegionView {
  readonly regionId: string;
  readonly startAddressHex: string;
  /** 缺省 = contentHex 字节长度(变体契约下两者恒相等;显式入参仅为容错)。 */
  readonly byteLength?: number;
  readonly contentHex: string;
}

/**
 * 展示文本字段位置白名单(按 Schema 字段位置封闭枚举)。
 *
 * 放行理由(登记,上游 v1.13 论证第(4)点):
 *  - `instructions[].text`:伪汇编展示文本,源 = 公开代码区字节(服务端
 *    生成,D5"展示数据非可执行 IR"边界在调试通道同样适用);
 *  - `functions[].label`:函数表标签,源 = 公开代码区符号面(`sub_<hex>`
 *    派生标签 / 公开描述包符号)。
 *
 * 白名单只放行"文本承载"这一形态;放行文本仍受走私字节边界检查(见文件头)。
 */
export interface DebugFrameTextAllowlist {
  /** 放行位置记法:`<数组字段>[].<文本字段>`(相对 payload 根)。 */
  readonly textPositions: readonly string[];
}

/** 缺省白名单(v1 帧族 Schema 位置全集;协议演进 = 白名单显式演进)。 */
export const DEFAULT_DEBUG_TEXT_ALLOWLIST: DebugFrameTextAllowlist = {
  textPositions: ["instructions[].text", "functions[].label"],
};

/** 走私字节边界:十六进制连续串参与断言的最小长度(8 字符 = 4 字节)。 */
export const ZR_B12_TEXT_HEX_RUN_MIN_LENGTH = 8;

/**
 * 走私字节边界:按数值操作数渲染放行的最大长度(16 字符 = u64 的十六进制
 * 上限)。> 16 字符的连续十六进制串不可能是数值渲染,必 ∈ 语料。
 */
export const ZR_B12_NUMERIC_RENDERING_MAX_LENGTH = 16;

/** 承载内存字节的帧字段位置(断言面封闭枚举;映射文档登记用)。 */
export const DEBUG_FRAME_MEMORY_BYTE_POSITIONS: readonly string[] = [
  "debug_window_data/payload/bytesHex",
  "debug_search_results/payload/hits[].bytesHex",
  "debug_instruction_stream/payload/instructions[].bytesHex",
] as const;

/** 扫描输入(帧 × 变体语料 × 玩家输入语料 × 白名单)。 */
export interface DebugFrameCorpusScanInput {
  readonly frame: DebugFrameScanView;
  /** 调试变体镜像内存区域(语料全集;WP-42:不拿真实镜像当全集)。 */
  readonly variantRegions: readonly DebugVariantRegionView[];
  /** 玩家输入回显语料(权威动作日志 bytesHex 值集合;§6.8 封闭集第三源)。 */
  readonly playerInputBytesHex?: readonly string[];
  /** 展示文本字段白名单(缺省 = DEFAULT_DEBUG_TEXT_ALLOWLIST)。 */
  readonly allowlist?: DebugFrameTextAllowlist;
}

function normalizeHex(value: string): string {
  return value.toLowerCase();
}

/** `0x` 前缀 hex → BigInt(非法形态返回 null;帧侧地址形态由契约先行校验)。 */
function parseAddressHex(hex: string): bigint | null {
  if (!/^0x[0-9a-fA-F]{1,16}$/.test(hex)) {
    return null;
  }
  return BigInt(hex);
}

/** 区域字节长度(contentHex 为权威;byteLength 入参仅做一致性上限)。 */
function regionByteLength(region: DebugVariantRegionView): bigint {
  const contentBytes = BigInt(region.contentHex.length / 2);
  return region.byteLength === undefined ? contentBytes : BigInt(region.byteLength);
}

/** 按地址定位区域(半开区间 [start, start + byteLength))。 */
function locateRegion(
  address: bigint,
  regions: readonly DebugVariantRegionView[],
): DebugVariantRegionView | null {
  for (const region of regions) {
    const start = parseAddressHex(region.startAddressHex);
    if (start === null) {
      continue;
    }
    if (address >= start && address < start + regionByteLength(region)) {
      return region;
    }
  }
  return null;
}

/** 玩家输入语料是否包含给定字节串(子串包含;大小写归一)。 */
function playerCorpusContains(playerInputBytesHex: readonly string[], bytesHex: string): boolean {
  return playerInputBytesHex.some((payload) => normalizeHex(payload).includes(bytesHex));
}

/** 全语料(变体区域 contentHex + 玩家输入)是否包含给定字节串。 */
function corpusContains(
  regions: readonly DebugVariantRegionView[],
  playerInputBytesHex: readonly string[],
  bytesHex: string,
): boolean {
  if (regions.some((region) => normalizeHex(region.contentHex).includes(bytesHex))) {
    return true;
  }
  return playerCorpusContains(playerInputBytesHex, bytesHex);
}

/**
 * 走私字节边界检查:提取文本中 ≥ 8 字符的连续十六进制串;> 16 字符
 * (超出 u64 数值渲染上限,不可能是展示面数值形态)的串必 ∈ 语料。
 */
function scanTextForSmuggledBytes(
  text: string,
  path: string,
  regions: readonly DebugVariantRegionView[],
  playerInputBytesHex: readonly string[],
  violations: ZrB12Violation[],
): void {
  const runPattern = new RegExp(`[0-9a-fA-F]{${ZR_B12_TEXT_HEX_RUN_MIN_LENGTH},}`, "g");
  let match: RegExpExecArray | null;
  while ((match = runPattern.exec(text)) !== null) {
    const run = match[0];
    if (run.length <= ZR_B12_NUMERIC_RENDERING_MAX_LENGTH) {
      continue; // 数值操作数渲染形态(0x… 立即数 / 位移 / 跳转目标),放行
    }
    if (!corpusContains(regions, playerInputBytesHex, normalizeHex(run))) {
      violations.push({
        id: "ZR-B12-text-smuggled-bytes",
        path,
        token: run,
        detail: "展示文本携带语料外超长十六进制串(超出数值渲染上限且不属于变体/玩家输入语料)",
      });
    }
  }
}

/** 白名单匹配:位置记法 `instructions[].text` ↔ 实际路径 `instructions[2].text`。 */
function isAllowlistedTextPosition(actual: string, allowlist: DebugFrameTextAllowlist): boolean {
  return allowlist.textPositions.some((pattern) => {
    const patternRegex = new RegExp(
      `^${pattern.replaceAll("[]", "\\[[0-9]+\\]").replaceAll(".", "\\.")}$`,
    );
    return patternRegex.test(actual);
  });
}

/** 展示文本字段的放行 + 边界检查(text 位置不在白名单 = 越界承载,直接命中)。 */
function scanDisplayText(
  text: unknown,
  payloadField: string,
  itemPath: string,
  regions: readonly DebugVariantRegionView[],
  playerInputBytesHex: readonly string[],
  allowlist: DebugFrameTextAllowlist,
  violations: ZrB12Violation[],
): void {
  if (typeof text !== "string") {
    return;
  }
  const position = `${payloadField}${itemPath}`;
  if (!isAllowlistedTextPosition(position, allowlist)) {
    violations.push({
      id: "ZR-B12-text-smuggled-bytes",
      path: `${position}(unallowlisted)`,
      token: text.slice(0, 32),
      detail: "展示文本出现在字段位置白名单之外(白名单按 Schema 位置封闭枚举)",
    });
    return;
  }
  scanTextForSmuggledBytes(text, position, regions, playerInputBytesHex, violations);
}

/** 内存字节断言:定位区域 → 子串包含(变体语料 ∨ 玩家输入语料)。 */
function assertMemoryBytes(
  addressHex: unknown,
  bytesHex: unknown,
  path: string,
  regions: readonly DebugVariantRegionView[],
  playerInputBytesHex: readonly string[],
  violations: ZrB12Violation[],
): void {
  if (typeof bytesHex !== "string" || bytesHex.length === 0) {
    return; // 无字节载荷(空串 / 缺席)= 无断言对象
  }
  if (typeof addressHex !== "string") {
    violations.push({
      id: "ZR-B12-address-outside-variant",
      path,
      token: String(addressHex).slice(0, 32),
      detail: "内存字节字段缺少可定位的地址字段(帧形态违反 §6.8 值来源定位义务)",
    });
    return;
  }
  const address = parseAddressHex(addressHex);
  const region = address === null ? null : locateRegion(address, regions);
  if (region === null) {
    violations.push({
      id: "ZR-B12-address-outside-variant",
      path,
      token: addressHex,
      detail: "帧承载内存字节的地址不落在调试变体镜像任何映射区域内",
    });
    return;
  }
  const bytes = normalizeHex(bytesHex);
  if (!corpusContains(regions, playerInputBytesHex, bytes)) {
    violations.push({
      id: "ZR-B12-bytes-not-in-variant-corpus",
      path,
      token: bytes.slice(0, 32),
      detail: `帧字节串不属于所定位区域 ${region.regionId} 的变体语料,也不属于玩家输入语料`,
    });
  }
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 扫描一帧调试通道出站帧(已解析;零命中 = 合法)。
 * 帧类型分派:只有三个 S→C 帧族承载内存字节断言面;错误帧 / 控制帧 /
 * C→S 请求帧无内存字节载荷,天然通过(文件头纪律)。
 */
export function scanDebugFrameCorpus(input: DebugFrameCorpusScanInput): ZrB12Violation[] {
  const violations: ZrB12Violation[] = [];
  const { frame } = input;
  const regions = input.variantRegions;
  const playerInputBytesHex = input.playerInputBytesHex ?? [];
  const allowlist = input.allowlist ?? DEFAULT_DEBUG_TEXT_ALLOWLIST;
  const payload = (frame.payload ?? {}) as Record<string, unknown>;

  switch (frame.type) {
    case "debug_window_data": {
      assertMemoryBytes(
        payload["addressHex"],
        payload["bytesHex"],
        "$/payload/bytesHex",
        regions,
        playerInputBytesHex,
        violations,
      );
      break;
    }
    case "debug_search_results": {
      const hits = asArray(payload["hits"]);
      hits.forEach((hit, index) => {
        const entry = (hit ?? {}) as Record<string, unknown>;
        assertMemoryBytes(
          entry["addressHex"],
          entry["bytesHex"],
          `$/payload/hits[${index}]/bytesHex`,
          regions,
          playerInputBytesHex,
          violations,
        );
      });
      break;
    }
    case "debug_instruction_stream": {
      const instructions = asArray(payload["instructions"]);
      instructions.forEach((entryValue, index) => {
        const entry = (entryValue ?? {}) as Record<string, unknown>;
        assertMemoryBytes(
          entry["addressHex"],
          entry["bytesHex"],
          `$/payload/instructions[${index}]/bytesHex`,
          regions,
          playerInputBytesHex,
          violations,
        );
        scanDisplayText(
          entry["text"],
          "instructions",
          `[${index}].text`,
          regions,
          playerInputBytesHex,
          allowlist,
          violations,
        );
      });
      break;
    }
    case "debug_function_table": {
      const functions = asArray(payload["functions"]);
      functions.forEach((entryValue, index) => {
        const entry = (entryValue ?? {}) as Record<string, unknown>;
        scanDisplayText(
          entry["label"],
          "functions",
          `[${index}].label`,
          regions,
          playerInputBytesHex,
          allowlist,
          violations,
        );
      });
      break;
    }
    default:
      // debug_attached / debug_paused / error / C→S 五帧:无内存字节载荷,天然通过。
      break;
  }
  return violations;
}

/** 扫描一批出站帧(全程录制集;path 前缀 `$<index>` 定位帧)。 */
export function scanDebugFrameCorpora(
  inputs: readonly DebugFrameCorpusScanInput[],
): ZrB12Violation[] {
  const violations: ZrB12Violation[] = [];
  inputs.forEach((input, index) => {
    for (const violation of scanDebugFrameCorpus(input)) {
      violations.push({ ...violation, path: `$${index}${violation.path}` });
    }
  });
  return violations;
}

/** 机检报告行(CI / 测试输出携带上游条目 ID;映射文档 §九扫描器纪律)。 */
export function formatZrB12Violations(violations: readonly ZrB12Violation[]): string[] {
  return violations.map((violation) => `[${violation.id}] ${violation.path}: ${violation.token}`);
}

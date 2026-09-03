/**
 * 双包 Schema 共用的正则模式源(单一来源:JSON Schema `pattern` 与
 * 检查器共用同一字符串,严格性测试对照 Schema 内字面量防漂移)。
 *
 * 刻意比协议传输层更窄:基集寄存器模式 `^R[A-Z0-9]{1,3}$` 与 FLAG 模式
 * `^FLAG[A-Z0-9_]*$` 结构性不相交(WP-1 §12.5),使秘密汇寄存器集合可静态枚举。
 */

export const CHALLENGE_ID_PATTERN_SOURCE = "^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$";

export const SEMVER_PATTERN_SOURCE = "^[0-9]+\\.[0-9]+\\.[0-9]+$";

/** regionId / fileId / objectId / stageId / testId 共用标识符模式。 */
export const OBJECT_ID_PATTERN_SOURCE = "^[a-z][a-z0-9-]{0,62}$";

/** 基集寄存器名模式(冻结 14 个;清单见 BASE_REGISTER_NAMES)。 */
export const BASE_REGISTER_NAME_PATTERN_SOURCE = "^R[A-Z0-9]{1,3}$";

/** FLAG 寄存器名模式(WP-1 §12.5:名称公开、值永不公开)。 */
export const FLAG_REGISTER_NAME_PATTERN_SOURCE = "^FLAG[A-Z0-9_]*$";

/** 64 位 hex,入站面大小写均可。 */
export const HEX_VALUE_64_PATTERN_SOURCE = "^0x[0-9a-fA-F]{1,16}$";

/** 公开输出面寄存器值:大写十六进制(协议公开输出面对齐)。 */
export const PUBLIC_HEX_VALUE_64_PATTERN_SOURCE = "^0x[0-9A-F]{1,16}$";

/** 权限规范序子集(rwx 合法、wr 非法),与协议 VisibleMemoryRegion 同形。 */
export const PERMISSIONS_PATTERN_SOURCE = "^r?w?x?$";

/** 非空偶长 hex 字节串。 */
export const HEX_BYTES_PATTERN_SOURCE = "^([0-9a-fA-F]{2})+$";

/** seed hex:16 – 64 hex 字符(8–32 字节熵)。 */
export const SEED_HEX_PATTERN_SOURCE = "^([0-9a-fA-F]{2}){8,32}$";

/** seed 公开路径单段(§4.3 路径语法)。 */
export const SEED_PATH_SEGMENT_PATTERN_SOURCE = "^[A-Za-z][A-Za-z0-9_]{0,31}$";

/** seed 公开路径:点分标识符序列 ≤ 8 段。 */
export const SEED_PATH_PATTERN_SOURCE =
  "^[A-Za-z][A-Za-z0-9_]{0,31}(\\.[A-Za-z][A-Za-z0-9_]{0,31}){0,7}$";

/** IR 标签名。 */
export const IR_LABEL_ID_PATTERN_SOURCE = "^[a-z][a-z0-9_]{0,62}$";

/** 内存操作数位移(有符号 64 位 hex)。 */
export const DISPLACEMENT_HEX_PATTERN_SOURCE = "^-?0x[0-9a-fA-F]{1,16}$";

/**
 * 自由文本控制字符禁令:拒绝 C0 / C1 控制字符与 DEL
 * (与协议 PublicTextSchema 一致;JSON Schema pattern 是无锚搜索,须显式 ^ $)。
 */
export const CONTROL_CHARS_BAN_PATTERN_SOURCE = "^[^\\u0000-\\u001F\\u007F-\\u009F]*$";

/** 寄存器冻结基集(WP-1 §3.2;清单由跨包一致性测试对照 protocol 锚定)。 */
export const BASE_REGISTER_NAMES = [
  "RSP",
  "RBP",
  "RIP",
  "RAX",
  "RBX",
  "RCX",
  "RDI",
  "RSI",
  "RDX",
  "R8",
  "R9",
  "R10",
  "R11",
  "R12",
] as const;
export type BaseRegisterName = (typeof BASE_REGISTER_NAMES)[number];

/** 检查器直接消费的已编译模式(JS Schema 用字符串,检查器用 RegExp)。 */
export const CHALLENGE_ID_PATTERN = new RegExp(CHALLENGE_ID_PATTERN_SOURCE);
export const BASE_REGISTER_NAME_PATTERN = new RegExp(BASE_REGISTER_NAME_PATTERN_SOURCE);
export const FLAG_REGISTER_NAME_PATTERN = new RegExp(FLAG_REGISTER_NAME_PATTERN_SOURCE);
export const CONTROL_CHARS_BAN_PATTERN = new RegExp(CONTROL_CHARS_BAN_PATTERN_SOURCE);

/**
 * 双包数值限制常量(Schema min/max 与检查器共用同一数值;严格性测试
 * 对照 Schema 内字面量防漂移)。协议冻结常量(如 MAX_WRITE_BYTES、
 * maxBytesPerRange 默认值)在此只作上限引用,公开包不得重新声明协议预算。
 */

/** 区域数量上限(公开布局 / 私有初始区域 / 初始投影一致)。 */
export const MAX_MEMORY_REGIONS = 64;

/** 单区域字节上限:16 MiB(协议 MAX_REGION_BYTE_LENGTH)。 */
export const MAX_REGION_BYTE_LENGTH = 16_777_216;

/** VMA 页对齐倍数(G3/D2:区域 byteLength 与 pageSizeBytes 均为其倍数;XS-MEM-PAGE-ALIGN)。 */
export const PAGE_SIZE_MULTIPLE_BYTES = 4096;

/** 页大小下限(4KB;G3/D2,Schema 与检查器共用)。 */
export const MIN_PAGE_SIZE_BYTES = 4096;

/** 页大小上限(64KB;G3/D2,Schema 与检查器共用)。 */
export const MAX_PAGE_SIZE_BYTES = 65536;

/** 全部区域字节总量上限(13.2:过大内存布局拒绝;XS-MEM-TOTAL)。 */
export const MAX_MEMORY_TOTAL_BYTES = 64 * 1024 * 1024;

/** 全部区域初始内容字节总量上限(XS-MEM-TOTAL;contentHex 为 hex 字符时按字节计)。 */
export const MAX_MEMORY_CONTENT_BYTES = 2 * 1024 * 1024;

/** 初始投影 bytesHex 上限:512 hex 字符 = 协议默认 maxBytesPerRange(256 字节)。 */
export const MAX_BYTES_HEX_PER_RANGE = 512;

/** 单动作写字节上限(协议 MAX_WRITE_BYTES;公开 resourceLimits 上限引用)。 */
export const MAX_WRITE_BYTES = 4096;

/** 公开可见寄存器 / 初始投影寄存器数量上限(G2/D3.1:32 → 64,资源护栏非自由度限制)。 */
export const MAX_VISIBLE_REGISTERS = 64;

/** 私有初始寄存器键数量上限(G2/D3.1:64 → 256,资源护栏非自由度限制)。 */
export const MAX_VM_REGISTERS = 256;

/** IR 指令数上限(7.2 循环上限的结构性兜底之一)。 */
export const MAX_IR_INSTRUCTIONS = 4096;

/** IR 标签数上限。 */
export const MAX_IR_LABELS = 512;

/** 每指令操作数槽上限。 */
export const MAX_OPERANDS_PER_INSTRUCTION = 4;

/** 表层机器码 token 字典条数上限(G5/D6 资源护栏;docs/最小DSL范围.md §三.4)。 */
export const MAX_ENCODING_TABLE_ENTRIES = 64;

/** 作者自定义指令条数上限(G4/D4 声明面资源护栏)。 */
export const MAX_CUSTOM_INSTRUCTIONS = 16;

/** 作者接口条数上限(G4/D4 声明面资源护栏)。 */
export const MAX_INTERFACES = 16;

/** 单条自定义指令微算子序列长度上限(G4:恒定步数上界 = 求值步数上限)。 */
export const MAX_MICRO_OPS_PER_INSTRUCTION = 16;

/** 单个接口效果原语序列长度上限(G4:恒定步数上界)。 */
export const MAX_EFFECTS_PER_INTERFACE = 16;

/** 判题条件布尔组合静态深度(L1→L2→L3→谓词;XS-NESTING)。 */
export const MAX_CONDITION_DEPTH = 3;

/** 每层布尔组合分支数上限(all / any 数组 maxItems)。 */
export const MAX_CONDITION_BRANCHES = 4;

/** 状态机阶段数上限(v1)。 */
export const MAX_STAGES = 8;

/** 单阶段迁移数上限。 */
export const MAX_STAGE_TRANSITIONS = 8;

/** 单阶段副作用数上限。 */
export const MAX_STAGE_SIDE_EFFECTS = 8;

/** 隐藏测试数上限。 */
export const MAX_HIDDEN_TESTS = 16;

/** 私有对象登记数上限。 */
export const MAX_PRIVATE_OBJECTS = 64;

/** 虚拟文件数上限。 */
export const MAX_VIRTUAL_FILES = 8;

/** 单虚拟文件内容上限(字符)。 */
export const MAX_VIRTUAL_FILE_BYTES = 4096;

/** 单条隐藏测试 payload 上限(hex 字符;= 4096 字节)。 */
export const MAX_HIDDEN_TEST_PAYLOAD_HEX = 8192;

/** seed 字节数上限(seedHex ≤ 64 hex 字符)。 */
export const MAX_SEED_BYTES = 32;

/** memory_equals 定长切片上限(字节;白名单第 7 项)。 */
export const MAX_MEMORY_EQUALS_BYTES = 256;

/** memory_contains 有界匹配上限(字节;白名单第 8 项)。 */
export const MAX_MEMORY_CONTAINS_BYTES = 64;

/** 提示阶梯条数上限。 */
export const MAX_HINTS = 8;

/** 公开错误映射条数上限(≤ 16 错误码)。 */
export const MAX_PUBLIC_ERROR_MAPPINGS = 16;

/** 语义高亮条数上限。 */
export const MAX_SEMANTIC_HIGHLIGHTS = 32;

/** declaredSeedPublicPaths 条数上限。 */
export const MAX_DECLARED_SEED_PATHS = 32;

/** seed 公开路径段数上限。 */
export const MAX_SEED_PATH_SEGMENTS = 8;

/** 单会话谓词求值步数预算上限(D1 约束 2 / I-6 / T-SC2 配置前提)。 */
export const MAX_PREDICATE_EVAL_STEPS = 10_000_000;

/** 每状态指令预算上限(7.2 循环上限)。 */
export const MAX_STAGE_INSTRUCTION_STEPS = 10_000_000;

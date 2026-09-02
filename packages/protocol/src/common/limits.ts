/**
 * 协议级资源护栏常量(冻结)。
 *
 * 这些是协议层的硬上限:题目级预算由公开描述包声明(计划书 7.1 公开部分)
 * 且必须 ≤ 协议上限;服务端在执行前按题目预算重新校验(6.2 第 6 条),
 * 超出协议上限的请求在契约校验层即被拒绝,不进入执行。
 *
 * 数值依据见 docs/数据分类与秘密零驻留清单.md 决策 D3/D4 与
 * packages/protocol/docs/会话动作协议语义.md。
 */

/** write_bytes 单动作字节上限(4096 B;与 D3 的投影单策略上限同量级)。 */
export const MAX_WRITE_BYTES = 4096;

/** 每动作 publicEvents 数组长度上限(D4 冻结;超限由服务端确定性聚合)。 */
export const MAX_PUBLIC_EVENTS_PER_ACTION = 256;

/**
 * create_checkpoint 可选标签最大长度(玩家自报内容,BOUNDARY)。
 * 计数口径:按 Unicode code point 计(JSON Schema maxLength 口径);TS 侧 Zod
 * 按 UTF-16 码元计,对增补平面字符只会更严(保守方向),WP-6 golden fixture
 * 不得以增补平面字符断言长度边界。
 */
export const CHECKPOINT_LABEL_MAX_LENGTH = 128;

/**
 * 服务端签发不透明标识符(sessionId / requestId / checkpointId)与客户端幂等键
 * 的最大长度。计数口径同上;字符集约束见 identifiers.ts(语义文档 §2.1)。
 */
export const OPAQUE_ID_MAX_LENGTH = 128;

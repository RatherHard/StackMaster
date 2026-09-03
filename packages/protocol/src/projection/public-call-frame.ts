/**
 * PublicCallFrame —— 调用栈摘要帧(WP-1 §4.2 / 决策 D2,WP-3 冻结)。
 *
 * 内容裁剪为 {index, functionLabel, returnAddressHex}:帧基址不直接下发,
 * 由玩家从可见 RSP/RBP 自行推导(保留教学价值)。MVP 中代码区恒公开,
 * 调用深度是公开程序的确定性行为;若未来出现非公开代码区(非 MVP),
 * 整帧替换为统一占位帧(标签与地址一起隐藏),与 D5 的 currentInstruction
 * 占位规则对齐。
 */
import { z } from "zod";
import { AddressHexSchema } from "../common/hex.js";
import { CALL_STACK_MAX_DEPTH } from "../common/limits.js";
import { PublicTextSchema } from "../common/public-text.js";

export const PublicCallFrameSchema = z.strictObject({
  /** 栈内序号,0 = 最内帧(当前函数);上限随 CALL_STACK_MAX_DEPTH。 */
  index: z.number().int().min(0).max(CALL_STACK_MAX_DEPTH - 1),
  /** 函数标签;来源冻结:公开描述包符号表或服务端静态模板,禁止私有符号表。 */
  functionLabel: PublicTextSchema(),
  returnAddressHex: AddressHexSchema,
  /**
   * presence-only 截断标记(WP-1 v1.2):仅出现在可见调用栈深度超过
   * CALL_STACK_MAX_DEPTH = 64 后展示的最后一帧上,表达"其后还有帧未展示"。
   * D2:不得以"+N 帧"等计数表达(深度计数是隐藏控制流的信号);本标记的
   * 存在性是(可见深度, 公开常量 64)的确定性函数,无隐藏信息。
   * z.literal(true):出现即 true,显式 false 在契约层即拒绝。
   */
  truncated: z.literal(true).optional(),
});
export type PublicCallFrame = z.infer<typeof PublicCallFrameSchema>;

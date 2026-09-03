/**
 * PublicControlFlow —— 当前执行位置的公开形态(WP-1 §4.2 / 决策 D5,WP-3 冻结)。
 *
 * 当前指令展示由服务端从展示数据单独生成(7.3),不是可执行 IR 的任何形态;
 * MVP 代码区恒公开,RIP 展示恒可行。若未来引入非公开代码区(非 MVP),
 * currentInstruction 必须整体替换为统一占位符(地址与文本一起隐藏),
 * 不得只隐藏地址保留文本(D5)。
 */
import { z } from "zod";
import { AddressHexSchema } from "../common/hex.js";
import { PublicTextSchema } from "../common/public-text.js";
import { PauseEventSchema } from "../session-action/action-args.js";

export const PublicControlFlowSchema = z.strictObject({
  /** 必填非空:MVP 中投影恒携带当前指令展示(代码区恒公开)。 */
  currentInstruction: z.strictObject({
    addressHex: AddressHexSchema,
    /** 服务端生成的伪指令展示文本(非可执行 IR,7.3)。 */
    text: PublicTextSchema(),
  }),
  /**
   * 触发当前暂停的事件类别;null = 运行中或无特定暂停事件。
   * 枚举与 run_to_event.pauseOn 同源(D5):复用同一 Schema,语义文档 §一。
   */
  pausedOn: PauseEventSchema.nullable(),
});
export type PublicControlFlow = z.infer<typeof PublicControlFlowSchema>;

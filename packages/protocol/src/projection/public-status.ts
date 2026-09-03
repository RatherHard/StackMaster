/**
 * PublicStatus —— 权威 VM 状态的公开形态(WP-1 §4.2 / 决策 D1,WP-3 冻结)。
 *
 * 仅在动作响应边界同步下发:无进度字段、无轮询旁路(D1 约束 1 / 约束 3);
 * won/failed 是教学结果而非正式裁决(与 VerdictResult 分离,D6)。
 * `rejected` 不属于本枚举——它只出现在 ActionResponse.status,不进入公开投影。
 */
import { z } from "zod";

export const PublicStatusSchema = z.enum(["running", "paused", "won", "failed"]);
export type PublicStatus = z.infer<typeof PublicStatusSchema>;

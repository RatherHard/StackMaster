/**
 * 裁决面(11 值结果类型;WP-61)。
 *
 * `VerdictResultSchema`(protocol,WP-2 冻结)的 11 值封闭枚举是裁决唯一
 * 词汇(零新增字面,D-API-83);本模块提供 worker verify 响应裁决字面的
 * 受理校验。verifier **零裁决逻辑**:11 值映射由引擎侧 verify 命令面产出
 * (ADR-8 同锚),服务侧只做字面受理(非 11 值 = 引擎契约漂移,run
 * failed,不落 verdicts)。
 */
import type { z } from "zod";
import { VerdictResultSchema } from "@stackmaster/protocol";

export type Verdict = z.infer<typeof VerdictResultSchema>;

/** 受理 11 值裁决字面(引擎响应面;未知字面返回 null)。 */
export function parseVerdict(value: unknown): Verdict | null {
  const parsed = VerdictResultSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

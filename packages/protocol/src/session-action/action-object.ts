/**
 * 动作判别对象:`{ type, args }`(计划书 6.2 的 ActionRequest.action 形态)。
 *
 * 用 discriminatedUnion 表达,使生成的 JSON Schema 在每个分支携带
 * `type` 常量与对应 args Schema——Rust 侧(serde + schemars)按同一结构消费。
 */
import { z } from "zod";
import {
  CallArgsSchema,
  CheckoutCheckpointArgsSchema,
  CreateCheckpointArgsSchema,
  PauseArgsSchema,
  PopArgsSchema,
  PushArgsSchema,
  ResetArgsSchema,
  RetArgsSchema,
  RunToEventArgsSchema,
  StepArgsSchema,
  UndoArgsSchema,
  WriteBytesArgsSchema,
} from "./action-args.js";

/** 全部动作类型(WP-2 冻结,与计划书 6.2 一致)。 */
export const SESSION_ACTION_TYPES = [
  "write_bytes",
  "push",
  "pop",
  "call",
  "ret",
  "step",
  "run_to_event",
  "pause",
  "undo",
  "checkout_checkpoint",
  "reset",
  "create_checkpoint",
] as const;

export type SessionActionType = (typeof SESSION_ACTION_TYPES)[number];

export const ActionObjectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("write_bytes"), args: WriteBytesArgsSchema }),
  z.strictObject({ type: z.literal("push"), args: PushArgsSchema }),
  z.strictObject({ type: z.literal("pop"), args: PopArgsSchema }),
  z.strictObject({ type: z.literal("call"), args: CallArgsSchema }),
  z.strictObject({ type: z.literal("ret"), args: RetArgsSchema }),
  z.strictObject({ type: z.literal("step"), args: StepArgsSchema }),
  z.strictObject({ type: z.literal("run_to_event"), args: RunToEventArgsSchema }),
  z.strictObject({ type: z.literal("pause"), args: PauseArgsSchema }),
  z.strictObject({ type: z.literal("undo"), args: UndoArgsSchema }),
  z.strictObject({ type: z.literal("checkout_checkpoint"), args: CheckoutCheckpointArgsSchema }),
  z.strictObject({ type: z.literal("reset"), args: ResetArgsSchema }),
  z.strictObject({ type: z.literal("create_checkpoint"), args: CreateCheckpointArgsSchema }),
]);

export type ActionObject = z.infer<typeof ActionObjectSchema>;

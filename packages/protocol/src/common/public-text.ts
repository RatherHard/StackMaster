/**
 * 公开展示文本 Schema 工厂(WP-3)。
 *
 * 适用于服务端生成、面向玩家展示的标签与文本:可见区域 `label`、调用栈
 * `functionLabel`、`currentInstruction.text`、`SemanticHighlight.label`、
 * 错误提示 `hints`(均为 WP-1 §4.2 / §4.4 冻结的 PUBLIC 字段)。
 *
 * 值来源受 WP-1 I-10 约束:公开描述包符号表、公开布局常量或服务端静态模板,
 * 禁止私有符号表;控制字符封禁同 checkpoint 标签(审计日志注入面,语义文档 §2.1)。
 */
import { z } from "zod";
import { PUBLIC_TEXT_MAX_LENGTH } from "./limits.js";

/**
 * 控制字符封禁(C0/C1)。注:这里**有意**在正则中匹配控制字符以拒绝它们。
 */
// eslint-disable-next-line no-control-regex -- 封禁 C0/C1 控制字符本身要求正则中出现控制字符
const CONTROL_CHARACTER_PATTERN = /^[^\u0000-\u001F\u007F-\u009F]*$/;

/**
 * 非空展示文本:默认上限 PUBLIC_TEXT_MAX_LENGTH,禁控制字符。
 * 计数口径同 CHECKPOINT_LABEL_MAX_LENGTH(JSON Schema maxLength = code point;
 * Zod 按 UTF-16 码元,对增补平面字符只会更严,保守方向)。
 */
export function PublicTextSchema(maxLength: number = PUBLIC_TEXT_MAX_LENGTH): z.ZodString {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .regex(CONTROL_CHARACTER_PATTERN, "展示文本不允许包含控制字符");
}

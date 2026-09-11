/**
 * 教学组件面(FE-ED 系,WP-F9)本地结构类型与常量。
 *
 * 依赖纪律(dependency-cruiser `browser-packages-only-depend-on-protocol`):
 * 前端**禁止 import challenge-schema**——公开描述包的类型面在本包内以**结构
 * 兼容的最小本地类型**登记(结构化类型系统下与 challenge-schema 实例互认);
 * 对齐锚 = `packages/challenge-schema/docs/双包Schema语义.md`:
 *  - `hintLadder[]`:`{order(1–8), revealPolicy: on_request | after_n_failures,
 *    failureThreshold?, hintText(1–512)}`;`revealPolicy = after_n_failures`
 *    ⇒ `failureThreshold` 必填(if/then);
 *  - `publicErrorMapping[]`:`{errorCode: 16 值冻结枚举, teachingNote(1–512)}`。
 * `errorCode` 直接复用 `@stackmaster/protocol` 的 `PublicErrorCode`(16 值
 * 冻结枚举同一字符串集合),双包枚举本身同源(双包Schema语义.md §vocabulary)。
 *
 * 本文件只承载类型与纯常量,零副作用;组件面在 src/views/ed/。
 */
import type { PublicErrorCode } from "@stackmaster/protocol";

import { t } from "../i18n/i18n.js";

/**
 * 教学提示(对齐 challenge-schema `PublicHint`,见双包Schema语义.md hintLadder 行)。
 * revealPolicy 语义在浏览器本地执行:
 *  - `on_request`:玩家点"显示下一条提示"逐级揭示;
 *  - `after_n_failures`:失败计数(由宿主传入)达到 failureThreshold 自动揭示。
 */
export interface PublicHint {
  /** 提示序(1 起,梯级顺序)。 */
  readonly order: number;
  readonly revealPolicy: "on_request" | "after_n_failures";
  /** after_n_failures 的解锁阈值(Schema if/then 强制必填;防御性缺席 = 永不解锁)。 */
  readonly failureThreshold?: number;
  /** 提示文案(通用教学语料,不含任何秘密)。 */
  readonly hintText: string;
}

/**
 * 错误教学注解映射(对齐 challenge-schema `PublicErrorMapping`,
 * 见双包Schema语义.md publicErrorMapping 行)。
 */
export interface PublicErrorMapping {
  /** 16 值冻结错误码(与 protocol PublicErrorCode 同串集)。 */
  readonly errorCode: PublicErrorCode;
  /** 题目作者提供的通用教学注解。 */
  readonly teachingNote: string;
}

/**
 * FE-ED-07 无匹配 teachingNote 时的默认教学文案(规约口径)。
 * 导出常量 = zh-CN 快照(既有测试与公开 API 面);组件渲染经 i18n 键
 * `ed.noTeachingNote`(WP-53;zh-CN 值与此常量一字不差)。
 */
export const DEFAULT_TEACHING_NOTE = "该错误暂无教学注解";

/**
 * checkpoint 标签校验(FE-ED-05):≤ 128 字符(protocol
 * CHECKPOINT_LABEL_MAX_LENGTH)且不含 C0/C1 控制字符(与 protocol
 * CreateCheckpointArgsSchema 的 CHECKPOINT_LABEL_PATTERN 同则)。
 * 返回 null = 合法;否则返回违反原因文案(直接呈现给玩家)。
 */
export function validateCheckpointLabel(label: string): string | null {
  if (label.length > 128) {
    return t("ed.labelTooLong");
  }
  // eslint-disable-next-line no-control-regex -- 封禁 C0/C1 控制字符本身要求正则中出现控制字符(同 protocol action-args.ts)
  const controlChars = /[\u0000-\u001F\u007F-\u009F]/;
  if (controlChars.test(label)) {
    return t("ed.labelControlChars");
  }
  return null;
}

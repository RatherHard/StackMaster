/**
 * 寄存器名称 Schema(WP-3;公开投影 PublicRegister 与 ProjectionPolicy 白名单共用)。
 *
 * MVP 基础名称集合(RSP/RBP/RIP/RAX/…/R12 + FLAG 子集)由 WP-1 §3.2 冻结;
 * 但名称集合本身允许题目 VM Profile 扩展(docs/develop/Vm 模块设计.md:寄存器
 * 名称、种类与数量应允许出题人自由设定),协议层只约束标识符形态:
 * 字母或下划线开头,仅含字母数字下划线,最长 32 字符。
 *
 * 名称是否属于题目白名单由服务端按题目重新校验(6.2 第 6 条);
 * "秘密汇寄存器不得进入白名单"由编译期污点推导强制(WP-1 I-3)。
 */
import { z } from "zod";

export const REGISTER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

export const RegisterNameSchema = z
  .string()
  .regex(
    REGISTER_NAME_PATTERN,
    "寄存器名称必须以字母或下划线开头,仅含字母数字下划线,最长 32 字符",
  );

export type RegisterName = z.infer<typeof RegisterNameSchema>;

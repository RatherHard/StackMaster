/**
 * 寄存器名称 Schema(WP-3;公开投影 PublicRegister 与 ProjectionPolicy 声明集共用)。
 *
 * G2/D3 双命名空间保留模型(WP-1 §12.5 v1.5,《Vm 模块设计冲突与整改方案》§3.2):
 * 题目寄存器集由出题人自由声明(challenge-schema vmProfile.registers 定义性声明),
 * 协议层约束名称形态与题目侧同一模式:一般命名空间 ^[A-Z][A-Z0-9_]{0,15}$,
 * 负向前瞻排除 FLAG 保留区 ^FLAG[A-Z0-9_]*$(FLAG 值永不进入公开投影,I-3;
 * 双命名空间结构性不相交,秘密汇可静态枚举)。
 *
 * 名称是否属于题目声明集由服务端按题目重新校验(6.2 第 6 条);
 * "秘密汇寄存器不得进入白名单"由编译期污点推导强制(WP-1 I-3)。
 */
import { z } from "zod";

export const REGISTER_NAME_PATTERN = /^(?!FLAG)[A-Z][A-Z0-9_]{0,15}$/;

export const RegisterNameSchema = z
  .string()
  .regex(
    REGISTER_NAME_PATTERN,
    "寄存器名称须为一般命名空间形式:大写字母开头,仅含大写字母数字下划线,最长 16 字符,且不得落入 FLAG 保留区",
  );

export type RegisterName = z.infer<typeof RegisterNameSchema>;

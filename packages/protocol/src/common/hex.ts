/**
 * 十六进制标量 Schema(计划书 6.2:地址与 64 位值在公开 API 用明确的十六进制字符串)。
 *
 * 输入校验刻意宽松(1–16 位、大小写均可):规范化形态(位宽补齐、大小写)
 * 由 WP-6 的规范化序列化规则冻结;是否匹配题目 VM Profile 的地址位宽
 * (32/64 位)由服务端按题目重新校验——动作协议与 VM Profile 解耦。
 */
import { z } from "zod";
import { MAX_WRITE_BYTES } from "./limits.js";

/** 地址:0x 前缀,1–16 位十六进制数字(≤ 64 位)。 */
export const AddressHexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,16}$/, "必须是 0x 前缀的十六进制地址(1-16 位数字)");

/** 64 位值:0x 前缀,1–16 位十六进制数字(push 的操作数等)。 */
export const ValueHex64Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{1,16}$/, "必须是 0x 前缀的十六进制值(1-16 位数字)");

/**
 * 字节序列:偶数长度十六进制串(无 0x 前缀,与公开投影 bytesHex 同形态),
 * 长度上限 2 × MAX_WRITE_BYTES 字符。
 */
export const BytesHexSchema = z
  .string()
  .regex(/^(?:[0-9a-fA-F]{2})+$/, "必须是偶数长度的十六进制串(无 0x 前缀)")
  .max(MAX_WRITE_BYTES * 2, `字节内容超过协议级上限(${MAX_WRITE_BYTES} 字节)`);

/**
 * 非空字节序列(≥ 1 字节):公开投影的区域内容、dirty range 与事件 payload 的形态。
 * 协议级上限与 BytesHexSchema 一致(4096 字节 = D3 的 maxBytesPerRange 单策略上限);
 * 生效上限 maxBytesPerRange(默认 256)由服务端按策略收紧,契约层只卡协议上限。
 */
export const NonEmptyBytesHexSchema = BytesHexSchema.min(2, "至少携带 1 字节");

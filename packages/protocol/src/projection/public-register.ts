/**
 * PublicRegister —— 白名单寄存器的公开形态(WP-1 §4.2,WP-3 冻结)。
 *
 * 名称 ∈ ProjectionPolicy.visibleRegisters 白名单;值是教学观察对象本身
 * (玩家要学习"寄存器里发生了什么"),秘密汇寄存器不得进入白名单由
 * 编译期污点推导强制(WP-1 I-3),运行时由差分测试兜底(T-SC4)。
 */
import { z } from "zod";
import { RegisterNameSchema } from "../common/register-name.js";

/**
 * 架构值的大写十六进制形态(WP-1 §4.2 v1.4:0x 前缀,1–16 位大写数字;
 * 值 = archBits 位宽的架构值,以 64 位容器承载、高位按题目
 * `vmProfile.archBits` 掩蔽——位宽域校验归服务端,协议层不做位宽判断)。
 * 与请求侧的宽松输入形态(common/hex.ts,大小写均可)不同,投影是服务端
 * 生成的规范化输出面——固定大写让 ZR-P3 / T-SC1 的规范化字节等价判定
 * 与 golden fixture 的跨语言往返具有稳定字典序。地址字段不在此约束内
 * (沿用 AddressHexSchema,位宽/大小写规范化归 WP-6 序列化规则)。
 */
export const PublicValueHex64Schema = z
  .string()
  .regex(/^0x[0-9A-F]{1,16}$/, "必须是 0x 前缀的大写十六进制值(1-16 位数字)");

export const PublicRegisterSchema = z.strictObject({
  name: RegisterNameSchema,
  valueHex: PublicValueHex64Schema,
});
export type PublicRegister = z.infer<typeof PublicRegisterSchema>;

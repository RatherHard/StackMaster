/**
 * 十六进制渲染原语(WP-F2 共享渲染层;WP-F3/F4 并行消费,互不依赖)。
 *
 * 契约形态纪律(与 protocol 冻结面一字不差):
 *  - `bytesHex`(字节序列)一律**小写**、无 0x 前缀、偶数长度(common/hex.ts);
 *  - 寄存器 `valueHex` 恒 `0x` + **大写**十六进制数字(PublicValueHex64Schema;
 *    大写形态保证规范化字节等价判定与 golden fixture 的稳定字典序);
 *  - 地址 `0x` 前缀,展示层恒**小写**(协议侧大小写规范化归 WP-6 序列化规则,
 *    本层对展示输入做防御性归一化)。
 *
 * 全部为纯函数:无效输入抛错(契约面已保证合法形态,渲染层不静默容忍漂移)。
 */

/** 偶数长度十六进制串(与 protocol BytesHexSchema 同形,但长度上限归调用方语义)。 */
const EVEN_HEX_PATTERN = /^(?:[0-9a-fA-F]{2})+$/;

/** 1–16 位十六进制数字(与 protocol 地址 / 值 Schema 同形)。 */
const HEX_DIGITS_PATTERN = /^[0-9a-fA-F]{1,16}$/;

/** bytesHex 归一化:校验偶数长度十六进制串并转为小写。 */
export function normalizeBytesHex(bytesHex: string): string {
  if (!EVEN_HEX_PATTERN.test(bytesHex)) {
    throw new Error(`非法 bytesHex(必须为偶数长度的十六进制串):${JSON.stringify(bytesHex)}`);
  }
  return bytesHex.toLowerCase();
}

/** bytesHex → 字节数组(输入先归一化)。 */
export function bytesHexToBytes(bytesHex: string): Uint8Array {
  const normalized = normalizeBytesHex(bytesHex);
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** 字节数组 → 小写 bytesHex。 */
export function bytesToBytesHex(bytes: ArrayLike<number>): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 1) {
    out += (bytes[index] as number).toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * bytesHex 分组格式化(十六进制段展示):每 `groupBytes` 字节为一组,组间以
 * 空格分隔,组内字节连续。例:`("aabbccddeeff0011", 2)` → `"aabb ccdd eeff 0011"`。
 */
export function formatBytesHexGrouped(bytesHex: string, groupBytes: number): string {
  if (!Number.isInteger(groupBytes) || groupBytes < 1) {
    throw new Error(`分组字节数必须为正整数:${groupBytes}`);
  }
  const normalized = normalizeBytesHex(bytesHex);
  const totalBytes = normalized.length / 2;
  const groups: string[] = [];
  for (let start = 0; start < totalBytes; start += groupBytes) {
    groups.push(normalized.slice(start * 2, Math.min(start + groupBytes, totalBytes) * 2));
  }
  return groups.join(" ");
}

/**
 * 寄存器值归一化:恒 `0x` + 大写十六进制数字(PublicValueHex64 契约形态)。
 * 防御性接受小写输入与省略前缀形态(渲染层对漂移输入归一化而非报错——
 * 值是服务端生成的规范化输出面,此处只为渲染兜底)。
 */
export function normalizeValueHex(valueHex: string): string {
  const digits = valueHex.toLowerCase().startsWith("0x") ? valueHex.slice(2) : valueHex;
  if (!HEX_DIGITS_PATTERN.test(digits)) {
    throw new Error(`非法 valueHex(必须为 0x 前缀的 1-16 位十六进制):${JSON.stringify(valueHex)}`);
  }
  return `0x${digits.toUpperCase()}`;
}

/** 地址解析:0x 前缀十六进制 → bigint(1–16 位,大小写均可)。 */
export function parseAddressHex(addressHex: string): bigint {
  const lowered = addressHex.toLowerCase();
  const digits = lowered.startsWith("0x") ? lowered.slice(2) : lowered;
  if (!HEX_DIGITS_PATTERN.test(digits)) {
    throw new Error(`非法地址(必须为 0x 前缀的 1-16 位十六进制):${JSON.stringify(addressHex)}`);
  }
  return BigInt(`0x${digits}`);
}

/** 地址格式化:bigint → `0x` + 小写十六进制(无填充)。 */
export function addressToHex(address: bigint): string {
  return `0x${address.toString(16)}`;
}

/**
 * 地址展示格式化:`0x` + 小写十六进制,按 `minDigits` 零填充(如 32 位
 * 习惯宽度 8)。不截断超宽地址(64 位地址传 minDigits=16)。
 */
export function formatAddressHex(addressHex: string, minDigits = 1): string {
  if (!Number.isInteger(minDigits) || minDigits < 1 || minDigits > 16) {
    throw new Error(`地址最小位数必须为 1-16:${minDigits}`);
  }
  const digits = parseAddressHex(addressHex).toString(16).padStart(minDigits, "0");
  return `0x${digits}`;
}

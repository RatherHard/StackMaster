/**
 * 客户端编译期求值面(WP-F6 / M9 变通口径)。
 *
 * 求值环境 = **公开投影只读快照**:寄存器名 → 值、地址 → 窗口内字节
 * (`visibleRegisters` + 已下发窗口 `bytesHex`)。隐藏数据天然不可用——
 * 这是 M9 的底线约束:未知引用 / 窗口外地址确定性报错,零静默兜底。
 *
 * 值模型(编译期):
 *  - 数值 = bigint(64 位无符号语义,与协议"64 位容器承载、高位按位宽掩蔽"
 *    同构;运算结果按 MASK_64 回绕);
 *  - 字符串 = JS string(写字符串按 **UTF-8** 编码为字节——定案:公开档无
 *    编码表下发,encodingTable 仅存在于字节权威执行模式的接口 token 语义,
 *    与积木字符串无关);
 *  - 布尔 = JS boolean(比较产出,分支消费)。
 *
 * 端序定案 = **小端**(与 WP-F4 跳转链一致:公开投影不携带端序字段,公开
 * 描述包 `vmProfile.endianness` 已冻结 "little")。
 */
import type { MemoryDataSource } from "../../datasource/types.js";
import { addressToHex, parseAddressHex } from "../../render/hex.js";
import type { PayloadEvalEnvironment } from "./types.js";

/** 64 位掩码(协议:架构值以 64 位容器承载)。 */
export const MASK_64 = (1n << 64n) - 1n;

/** 编译期值(bigint 数值 / string 字符串 / boolean 布尔)。 */
export type PayloadValue = bigint | string | boolean;

/** 列表(具名,按名存取;元素为编译期值)。 */
export class PayloadList {
  readonly items: PayloadValue[] = [];
}

/** 求值错误(确定性报错;编译器捕获后映射为带 blockId 的编译错误)。 */
export class PayloadEvalError extends Error {
  /** 稳定错误码(映射到 PayloadCompileErrorCode)。 */
  readonly code: "unknown_reference" | "type_mismatch" | "division_by_zero" | "eval_limit_exceeded";

  constructor(
    code: "unknown_reference" | "type_mismatch" | "division_by_zero" | "eval_limit_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "PayloadEvalError";
    this.code = code;
  }
}

/** 64 位回绕(加/减/乘后掩蔽)。 */
export function mask64(value: bigint): bigint {
  return ((value % (MASK_64 + 1n)) + (MASK_64 + 1n)) % (MASK_64 + 1n);
}

/** 字符串 → UTF-8 字节(定案编码)。 */
export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * 数字字面量解析:非负十进制或 0x 前缀十六进制;其余形态确定性报错
 * (不静默猜测,教学可解释)。
 */
export function parseNumericLiteral(text: string): bigint {
  const trimmed = text.trim();
  if (/^(?:0x[0-9a-fA-F]{1,16}|\d+)$/.test(trimmed)) {
    return BigInt(trimmed);
  }
  throw new PayloadEvalError(
    "type_mismatch",
    `数字字面量必须为非负十进制或 0x 十六进制:${JSON.stringify(text)}`,
  );
}

/** 值 → 64 位数值(类型不符确定性报错)。 */
export function valueToNumber(value: PayloadValue): bigint {
  if (typeof value !== "bigint") {
    throw new PayloadEvalError("type_mismatch", `此处需要数值,实际为 ${describeValue(value)}`);
  }
  return value;
}

/** 值 → 字符串(类型不符确定性报错)。 */
export function valueToString(value: PayloadValue): string {
  if (typeof value !== "string") {
    throw new PayloadEvalError("type_mismatch", `此处需要字符串,实际为 ${describeValue(value)}`);
  }
  return value;
}

/** 值 → 布尔(类型不符确定性报错)。 */
export function valueToBoolean(value: PayloadValue): boolean {
  if (typeof value !== "boolean") {
    throw new PayloadEvalError("type_mismatch", `此处需要真/假条件,实际为 ${describeValue(value)}`);
  }
  return value;
}

/** 值的中文描述(错误文案用)。 */
function describeValue(value: PayloadValue): string {
  if (typeof value === "bigint") {
    return `数值 ${value}`;
  }
  if (typeof value === "string") {
    return `字符串 "${value}"`;
  }
  return value ? "真" : "假";
}

/** 空求值环境:任何寄存器 / 内存引用确定性报错(未接公开投影时的确定性语义)。 */
export function createEmptyEvalEnvironment(): PayloadEvalEnvironment {
  return {
    registerValue: (name) => {
      throw new PayloadEvalError("unknown_reference", `寄存器 ${name} 不在公开投影中(当前无求值数据)`);
    },
    byteAt: (address) => {
      throw new PayloadEvalError(
        "unknown_reference",
        `地址 ${addressToHex(address)} 不在可见窗口内(当前无求值数据)`,
      );
    },
    readBytesLittleEndian: (address, count) => {
      throw new PayloadEvalError(
        "unknown_reference",
        `地址 ${addressToHex(address)} 不在可见窗口内(当前无求值数据;尝试读取 ${count} 字节)`,
      );
    },
  };
}

/**
 * 公开投影求值环境:由 `MemoryDataSource` 构造(视图唯一依赖面,纪律不破)。
 * 寄存器表来自 `registers()`(名称大小写不敏感);字节读取经 `bytesRows()`
 * ——窗口外 cell 天然返回 null(契约面),此处转为确定性报错。
 */
export function createPublicEvalEnvironment(dataSource: MemoryDataSource): PayloadEvalEnvironment {
  const registers = new Map<string, bigint>();
  for (const row of dataSource.registers()) {
    try {
      registers.set(row.name.trim().toLowerCase(), BigInt(row.valueHex));
    } catch {
      // 寄存器值非法(契约面不会出现):跳过而非让整个求值环境不可用。
    }
  }
  const regionWindows = dataSource
    .regions()
    .map((entry) => ({
      start: parseAddressHex(entry.startAddressHex),
      windowBytes: entry.windowByteLength,
    }));

  return {
    registerValue(name: string): bigint {
      const value = registers.get(name.trim().toLowerCase());
      if (value === undefined) {
        throw new PayloadEvalError(
          "unknown_reference",
          `寄存器 ${name} 不在公开投影白名单中(仅 visibleRegisters 可求值)`,
        );
      }
      return value;
    },

    byteAt(address: bigint): number {
      return Number(readWindowBytes(address, 1)[0]);
    },

    readBytesLittleEndian(address: bigint, count: number): bigint {
      const bytes = readWindowBytes(address, count);
      let value = 0n;
      // 小端:低地址字节为低位(WP-F4 端序定案)。
      let index = 0;
      for (const byte of bytes) {
        value |= BigInt(byte) << BigInt(8 * index);
        index += 1;
      }
      return value;
    },
  };

  /** 读取窗口内连续 count 字节;窗口外 / 未映射确定性报错。 */
  function readWindowBytes(address: bigint, count: number): number[] {
    const covered = regionWindows.some(
      (region) => address >= region.start && address - region.start < BigInt(region.windowBytes),
    );
    const rows = dataSource.bytesRows({
      startAddressHex: addressToHex(address),
      endAddressHex: addressToHex(address + BigInt(count)),
    });
    const byteByAddress = new Map<bigint, number>();
    for (const row of rows) {
      for (const cell of row.cells) {
        if (cell.byte !== null) {
          byteByAddress.set(parseAddressHex(cell.addressHex), cell.byte);
        }
      }
    }
    const bytes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const byte = byteByAddress.get(address + BigInt(index));
      if (byte === undefined) {
        throw new PayloadEvalError(
          "unknown_reference",
          covered
            ? `地址 ${addressToHex(address + BigInt(index))} 不在已下发窗口内(求值仅限公开投影窗口)`
            : `地址 ${addressToHex(address + BigInt(index))} 不可见(未映射或隐藏区域,I-9)`,
        );
      }
      bytes.push(byte);
    }
    return bytes;
  }
}

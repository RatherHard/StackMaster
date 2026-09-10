/**
 * SeedDeriver —— 确定性派生器 `splitmix64-stream-v1` 的 TS 侧移植(WP-42;
 * 判题语义规约 §六 D-J7、ADR-DC1 条款 2 / §六 R2)。
 *
 * **权威实现 = `vm-engine/vm-core/src/judge/seed.rs`**(同一算法标识的字面量
 * 在 protocol 以 `DEBUG_VARIANT_SEED_ALGORITHM_ID` 重复冻结);本文件逐行对照
 * 该实现移植,跨语言一致性由黄金向量锁死:
 * `test/golden/seed-derivation-vectors.json`(TS 测试与
 * `vm-engine/vm-worker/tests/seed_derivation_conformance.rs` 消费同一文件,
 * 断言两侧对同一种子同序数派生同值)。
 *
 * 算法(与 seed.rs 同一冻结形态,变更 = 破坏性引擎语义变更):
 *  1. 种子字节按 FNV-1a 64 折叠为内部状态(offset basis `0xcbf29ce484222325`,
 *     prime `0x00000100000001b3`,逐字节 xor 后乘);
 *  2. 第 k 次抽取(k 自 0 起)= splitmix64(state + k):wrapping 算术(模 2^64),
 *     终结子 `0x9E3779B97F4A7C15`,mix 常量 `0xBF58476D1CE4E5B9` /
 *     `0x94D049BB133111EB`,输出 = z ^ (z >> 31);
 *  3. 第 k 次抽取仅由种子与 k 决定(无隐藏状态、无外部熵)。
 *
 * 64 位 wrapping 算术以 BigInt 承载(JS Number 无法精确表示 u64 乘法);
 * 派生值出口统一为 BigInt,字节化(小端取前 8 字节)由消费面
 * (`debug-variant`)按 WP-40 §七.2 draws 规范槽序执行。
 *
 * 应用面(首个):调试变体镜像的 ASLR 基址派生与秘密槽派生(D-J8/D-J10);
 * 真实实例引擎侧派生仍归 vm-core(同一算法,TS 侧不参与引擎装配)。
 */

/** 派生算法标识(与 vm-core `SEED_ALGORITHM_ID` 同一冻结字面量)。 */
export const SEED_ALGORITHM_ID = "splitmix64-stream-v1";

/** 种子字节下界(seed.rs `MIN_SEED_BYTES` 镜像:8 字节)。 */
export const MIN_SEED_BYTES = 8;

/** 种子字节上界(seed.rs `MAX_SEED_BYTES` 镜像:32 字节)。 */
export const MAX_SEED_BYTES = 32;

/** u64 掩蔽域(模 2^64;wrapping 算术的截断掩码)。 */
const MASK_U64 = (1n << 64n) - 1n;

/** FNV-1a 64 offset basis(seed.rs 同值)。 */
const FNV_OFFSET_BASIS = 0xcbf2_9ce4_8422_2325n;

/** FNV-1a 64 prime(seed.rs 同值)。 */
const FNV_PRIME = 0x0000_0100_0000_01b3n;

/**
 * 派生路径摘要(与 vm-core `DerivationPathSummary` 同构的 TS 类型;
 * 回放元数据承载面——**不含种子值**,只登记算法标识与派生次数)。
 */
export interface DerivationPathSummary {
  readonly algorithmId: string;
  readonly draws: number;
}

/**
 * 确定性派生器(`splitmix64-stream-v1`;与 vm-core SeedDeriver 逐行同构):
 * 同一种子与同一调用序 ⇒ 同一输出序列(黄金向量与属性测试双面锁定)。
 */
export class SeedDeriver {
  /** FNV-1a 折叠后的内部状态。 */
  readonly #state: bigint;
  /** 已消耗的抽取次数(第 k 次抽取 = splitmix64(state + k))。 */
  #sequence = 0;

  /** 自种子字节构造(任意长度;典型 8–32 字节)。 */
  constructor(seedBytes: Uint8Array) {
    // FNV-1a 64 折叠:确定性、与字节位置相关(seed.rs new 同序)。
    let folded = FNV_OFFSET_BASIS;
    for (const byte of seedBytes) {
      folded ^= BigInt(byte);
      folded = (folded * FNV_PRIME) & MASK_U64;
    }
    this.#state = folded;
  }

  /** 自 hex 形态种子构造(偶长 hex,无 0x 前缀;长度界由调用方先行校验)。 */
  static fromHex(seedHex: string): SeedDeriver {
    return new SeedDeriver(seedBytesFromHex(seedHex));
  }

  /** 派生次数(派生路径元数据的计数部分)。 */
  draws(): number {
    return this.#sequence;
  }

  /** 派生路径摘要(不含种子值;与回放元数据 DerivationPathSummary 同语义)。 */
  summary(): DerivationPathSummary {
    return { algorithmId: SEED_ALGORITHM_ID, draws: this.#sequence };
  }

  /**
   * 派生下一个 64 位值(splitmix64 终结子;BigInt 乘加后按 MASK_U64 截断,
   * 与 Rust wrapping 算术逐位等价)。
   */
  nextU64(): bigint {
    let z = (this.#state + BigInt(this.#sequence)) & MASK_U64;
    z = (z * 0x9E37_79B9_7F4A_7C15n) & MASK_U64;
    z = ((z ^ (z >> 30n)) * 0xBF58_476D_1CE4_E5B9n) & MASK_U64;
    z = ((z ^ (z >> 27n)) * 0x94D0_49BB_1331_11EBn) & MASK_U64;
    this.#sequence += 1;
    return (z ^ (z >> 31n)) & MASK_U64;
  }
}

/** 偶长 hex(无 0x 前缀)→ 字节;形态非法返回 null(校验归调用方)。 */
export function seedBytesFromHex(seedHex: string): Uint8Array {
  if (seedHex.length % 2 !== 0 || !/^(?:[0-9a-fA-F]{2})+$/.test(seedHex)) {
    throw new Error(`seed hex 形态非法(须为偶长 hex,无 0x 前缀):长度 ${seedHex.length}`);
  }
  const bytes = new Uint8Array(seedHex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(seedHex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * u64 → 小端 8 字节(数组;WP-40 §七.2 "小端字节序取前 8 字节"的块字节化)。
 */
export function u64ToLittleEndianBytes(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let rest = value & MASK_U64;
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
}

//! SeedDeriver 跨语言黄金向量对偶测试(阶段四 WP-42;判题语义规约 §六 D-J7、
//! ADR-DC1 条款 2 / §六 R2)。
//!
//! 消费与 TS 侧(`packages/challenge-compiler/test/seed-deriver.test.ts`)同一
//! 黄金向量文件 `packages/challenge-compiler/test/golden/
//! seed-derivation-vectors.json`,用 vm-core 的**权威实现**(`vm_core::judge::seed
//! ::SeedDeriver`,`splitmix64-stream-v1`)断言:同一种子同序数派生同值——
//! 锁死 challenge-compiler 侧 TS 移植与引擎实现的跨语言一致性(调试变体镜像
//! 的秘密槽 / ASLR 基址派生与回放元数据 DerivationPathSummary 同源)。
//!
//! 向量值落盘前经独立三方实现(Python)验证;本文件零引擎源码改动
//! (vm-core / vm-runtime 源码不动,仅新增本测试)。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use vm_core::judge::seed::{SeedDeriver, SessionRng};

/// 黄金向量文件(仓库根相对;vm-worker 位于 vm-engine/vm-worker,上两级为仓库根)。
fn golden_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("packages")
        .join("challenge-compiler")
        .join("test")
        .join("golden")
        .join("seed-derivation-vectors.json")
}

/// 第 k 次(k 自 1 起)抽取值。
fn draw_k(seed_bytes: &[u8], k: u64) -> u64 {
    let mut deriver = SeedDeriver::new(seed_bytes);
    let mut value = 0;
    for _ in 0..k {
        value = deriver.next_u64();
    }
    value
}

fn decode_seed_hex(seed_hex: &str) -> Vec<u8> {
    assert_eq!(seed_hex.len() % 2, 0, "seed hex 必须为偶长: {seed_hex}");
    (0..seed_hex.len() / 2)
        .map(|index| {
            u8::from_str_radix(&seed_hex[index * 2..index * 2 + 2], 16)
                .expect("seed hex 须为合法十六进制")
        })
        .collect()
}

#[test]
fn seed_derivation_matches_golden_vectors() {
    let raw = fs::read_to_string(golden_path()).expect("黄金向量文件存在(仓库内相对路径)");
    let document: Value = serde_json::from_str(&raw).expect("黄金向量文件为合法 JSON");
    assert_eq!(
        document["algorithmId"].as_str(),
        Some(vm_core::judge::seed::SEED_ALGORITHM_ID),
        "算法标识与 vm-core 权威字面量一致"
    );

    let vectors = document["drawVectors"]
        .as_array()
        .expect("drawVectors 数组存在");
    assert!(vectors.len() >= 20, "向量条数 ≥ 20(实际 {})", vectors.len());
    for vector in vectors {
        let seed_hex = vector["seedHex"].as_str().expect("seedHex 字段");
        let k = vector["draw"].as_u64().expect("draw 序数");
        let expected_decimal = vector["expectedU64Decimal"].as_str().expect("十进制期望值");
        let expected_hex = vector["expectedU64Hex"].as_str().expect("hex 期望值");
        let seed_bytes = decode_seed_hex(seed_hex);
        // 长度界镜像(MIN/MAX_SEED_BYTES):向量集须含 8–32 字节边界形态。
        assert!(
            (vm_core::judge::seed::MIN_SEED_BYTES..=vm_core::judge::seed::MAX_SEED_BYTES)
                .contains(&seed_bytes.len()),
            "种子长度 {seed_hex} 越界"
        );

        let got = draw_k(&seed_bytes, k);
        let expected: u64 = expected_decimal.parse().expect("十进制期望值为 u64");
        assert_eq!(
            got, expected,
            "跨语言派生值不一致(seed = {seed_hex}, draw = {k})"
        );
        assert_eq!(
            format!("0x{got:x}"),
            expected_hex,
            "hex 形态不一致(seed = {seed_hex}, draw = {k})"
        );
        // 派生计数口径:第 k 次抽取后 draws() == k(DerivationPathSummary 同语义)。
        let mut deriver = SeedDeriver::new(&seed_bytes);
        for _ in 0..k {
            deriver.next_u64();
        }
        assert_eq!(
            deriver.summary().draws,
            k,
            "draws 计数口径(seed = {seed_hex})"
        );
    }
}

#[test]
fn same_seed_same_stream_and_different_seeds_diverge_conformance() {
    // 黄金文件中的边界种子在同序列 / 异序列属性上与 vm-core 测试锚呼应。
    let raw = fs::read_to_string(golden_path()).expect("黄金向量文件存在");
    let document: Value = serde_json::from_str(&raw).expect("黄金向量文件为合法 JSON");
    let seed_hex = document["drawVectors"][0]["seedHex"]
        .as_str()
        .expect("seedHex 字段");
    let seed_bytes = decode_seed_hex(seed_hex);

    let mut a = SeedDeriver::new(&seed_bytes);
    let mut b = SeedDeriver::new(&seed_bytes);
    for _ in 0..256 {
        assert_eq!(a.next_u64(), b.next_u64(), "同种子必须产生同一序列");
    }
    let flipped: Vec<u8> = seed_bytes.iter().map(|byte| !byte).collect();
    let mut c = SeedDeriver::new(&flipped);
    let mut diverged = false;
    let mut a_again = SeedDeriver::new(&seed_bytes);
    for _ in 0..256 {
        if a_again.next_u64() != c.next_u64() {
            diverged = true;
            break;
        }
    }
    assert!(diverged, "异种子序列应不同");
}

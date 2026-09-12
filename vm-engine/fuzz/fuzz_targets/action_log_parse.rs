#![no_main]
//! fuzz 目标:动作日志解析面(阶段六 WP-61;阶段三验收评审 §六.11 引擎侧
//! 演进承接——verifier 复用面的 cargo-fuzz 语料加码)。
//!
//! 管线与 verifier 裁决链路同构:字节 → UTF-8 → `ActionLog::from_canonical_text`
//! (规范化 JSON 语法 + `stackmaster-action-log/1` 形态 + 条目字段域复验)
//! → `hash_hex`(规范化序列化 + SHA-256 复算)。解析成功后再走一遍
//! 序列化 → 再解析的往返(读回路径的修复面;`entries_mut` 篡改矩阵的消费
//! 前置)。
//!
//! 判定纪律:任意字节输入**不 panic**;畸形输入必须被拒绝(Err),静默误收
//! 即解析防线缺陷。语料纪律:不提交种子语料(动作日志属提交面内容,沿
//! challenge_bundle 目标"私有题目包样本永不入 git"的同源纪律);libfuzzer
//! 以空语料起步。

use libfuzzer_sys::fuzz_target;
use vm_runtime::action_log::ActionLog;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    // 解析面:畸形输入必须 Err,不得 panic / 误收。
    if let Ok(log) = ActionLog::from_canonical_text(text) {
        // 摘要面:解析成功则规范化哈希必须可复算(序列化先验的推论)。
        if let Ok(digest) = log.hash_hex() {
            debug_assert_eq!(digest.len(), 64);
        }
        // 往返面:规范化序列化 → 再解析必须成功且哈希一致(读回路径)。
        if let Ok(round_trip) = log.canonical_text() {
            let reparsed = ActionLog::from_canonical_text(&round_trip)
                .expect("规范化文本必须可读回(序列化先验)");
            assert_eq!(
                reparsed.hash_hex().unwrap(),
                log.hash_hex().unwrap(),
                "解析 → 序列化 → 再解析的哈希必须逐字节一致"
            );
        }
    }
});

//! 私有判题包测试期 builder(冒烟 §四用;阶段一验收评审 §三移交项 5)。
//!
//! **私有包样例永不入 git**(CLAUDE.md 红线):全部私有样例由本模块在
//! 冒烟进程内现场构造,样例值均为占位符(`FLAG{placeholder}` 等),
//! 不含任何真实题目内容。构造形态满足 private-bundle.schema.json 的
//! 两种程序形态(IR 模式 / 字节模式;双程序形态恰一)。

use serde_json::{json, Value};

/// IR 模式最小合法包(compiledIr 在场、entrypointAddressHex 缺省)。
pub fn build_ir_mode_bundle() -> Value {
    json!({
        "schemaVersion": 1,
        "challengeId": "smoke-contract-ir",
        "challengeContentVersion": "1.0.0",
        "vmProfileVersion": "1.0.0",
        "dslSchemaVersion": 2,
        "vmEngineVersion": "0.1.0",
        "declaredSeedPublicPaths": [],
        "seedPolicy": { "strategy": "fixed", "seedHex": "00112233445566778899aabbccddeeff" },
        "initialState": {
            "registers": { "RSP": "0x7ffc00", "RBP": "0x7ffc00", "RIP": "0x401000" },
            "memoryRegions": [
                {
                    "regionId": "code",
                    "kind": "code",
                    "startAddressHex": "0x401000",
                    "byteLength": 4096,
                    "permissions": "rx",
                    "contentHex": format!("{}{}", "55".repeat(8), "00".repeat(4096 - 8)),
                    "isHidden": false
                }
            ]
        },
        "secrets": { "flag": "FLAG{placeholder}", "virtualFiles": [] },
        "privateObjects": [],
        "judging": { "successCondition": { "all": [] } },
        "compiledIr": {
            "irFormatVersion": 2,
            "entrypointIndex": 0,
            "instructions": [ { "op": "ret", "operands": [] } ],
            "labels": []
        },
        "judgingConfig": { "verdictRuleVersion": "1.0.0", "maxPredicateEvalSteps": 10000 }
    })
}

/// 字节模式最小合法包(entrypointAddressHex 在场、compiledIr 缺省;
/// 编码表本身在公开包 vmProfile,Schema 单包视角两种形态均放行)。
pub fn build_byte_mode_bundle() -> Value {
    let mut bundle = build_ir_mode_bundle();
    let object = bundle.as_object_mut().unwrap();
    object.remove("compiledIr");
    object.insert(
        "entrypointAddressHex".to_owned(),
        json!("0x401000"),
    );
    bundle
}

/// 冒烟反例:对合法包做定向破坏,断言 Schema 层拒绝。
/// 每条 = (违规原因, 破坏后的包);命名即违规原因登记(WP 纪律)。
pub fn schema_rejected_mutations() -> Vec<(&'static str, Value)> {
    vec![
        // 未知字段(I-1:strictObject → additionalProperties: false)。
        {
            let mut bundle = build_ir_mode_bundle();
            bundle["vmState"] = json!("tamper");
            ("unknown-field-vm-state-tamper", bundle)
        },
        // seed 策略与 seed 互斥(R5):fixed ⇒ seedHex 必填。
        {
            let mut bundle = build_ir_mode_bundle();
            bundle["seedPolicy"] = json!({ "strategy": "fixed" });
            ("seed-policy-fixed-without-seedhex", bundle)
        },
        // DSL Schema Version 冻结为 const 2。
        {
            let mut bundle = build_ir_mode_bundle();
            bundle["dslSchemaVersion"] = json!(3);
            ("dsl-schema-version-not-2", bundle)
        },
        // VMA 页对齐(G3/D2):regionByteLength 必须为 4096 的倍数。
        {
            let mut bundle = build_ir_mode_bundle();
            bundle["initialState"]["memoryRegions"][0]["byteLength"] = json!(4097);
            ("memory-region-not-page-aligned", bundle)
        },
        // 判题配置必填项:谓词求值步数预算缺失。
        {
            let mut bundle = build_ir_mode_bundle();
            bundle["judgingConfig"] = json!({ "verdictRuleVersion": "1.0.0" });
            ("judging-config-missing-predicate-budget", bundle)
        },
        // 隐藏测试期望结果冻结为 7 值可达判定枚举(engine_error 非可授权期望,D6)。
        {
            let mut bundle = build_ir_mode_bundle();
            bundle["judging"]["hiddenTests"] = json!([
                { "testId": "payload-1", "kind": "reference_payload", "payloadHex": "41", "expectedResult": "engine_error" }
            ]);
            ("hidden-test-expected-result-not-authorizable", bundle)
        },
    ]
}

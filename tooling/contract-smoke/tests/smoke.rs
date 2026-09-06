//! 集成测试:`cargo test` 与 `cargo run` 走同一套断言,CI 二选一即可。

use contract_smoke::canonical::{self, CanonicalError, canonicalize_json_text};
use contract_smoke::smoke::run_all;

#[test]
fn golden_fixture_smoke_passes() {
    let report = run_all().expect("契约冒烟应通过");
    assert!(report.schemas_compiled >= 12, "两包 Schema 应全部编译");
    assert!(report.valid_instances_checked >= 39, "有效样例全量校验");
    assert!(report.invalid_instances_rejected >= 93, "非法样例全量校验");
    assert!(report.manifest_entries_compared >= 133, "摘要清单全量比对");
}

#[test]
fn canonicalizer_agrees_with_reference_semantics() {
    use contract_smoke::strict_value::StrictValue;

    // 键序:UTF-16 码元序(与 TS 一致),含 U+E000..U+FFFF 与增补平面的分界样例。
    let canonical = canonicalize_json_text(r#"{"z":1,"é":2,"😀":3,"":4}"#).unwrap();
    assert_eq!(canonical, r#"{"":4,"z":1,"é":2,"😀":3}"#);

    // 数值:指数写法的整数值规范化为十进制;-0 归一;越界拒绝。
    assert_eq!(canonicalize_json_text("1e3").unwrap(), "1000");
    assert_eq!(canonicalize_json_text("-0").unwrap(), "0");
    let overflow = StrictValue::parse("9007199254740992").unwrap();
    assert_eq!(
        canonical::canonicalize(&overflow).unwrap_err(),
        CanonicalError::UnsafeInteger
    );
    assert_eq!(
        canonicalize_json_text("1.5").unwrap_err(),
        CanonicalError::NonIntegerNumber
    );

    // 重复键拒绝;JSON 文本中的 \ud800 转义是孤立代理项,拒绝码与 TS
    // `lone_surrogate` 同串(WP-1 修正:原实现因 serde_json 将其归 Syntax
    // 分类而落到 invalid_json,与 TS 拒绝码不对齐)。
    assert_eq!(
        canonicalize_json_text(r#"{"a":1,"a":2}"#).unwrap_err(),
        CanonicalError::DuplicateKey
    );
    assert_eq!(
        canonicalize_json_text(r#""\ud800""#).unwrap_err(),
        CanonicalError::LoneSurrogate
    );
}

#![no_main]
//! fuzz 目标:题目包解析器(私有判题包 + 公开描述包双包管线,含 IR 装配)。
//!
//! 管线与 `vm_worker::protocol::worker::Worker::handle_load` 同构:字节 →
//! UTF-8 → 严格 JSON → 双包 Schema 校验 → 语义承接 → serde 镜像 → 双包
//! 身份一致 → 会话装配(`session::assemble`,IR 形态校验 / 公开布局互证 /
//! 谓词预算双真相源 / canary 互证等全部装配期复验在此路)。
//!
//! 输入布局:前半段为私有包 JSON 文本,后半段为公开描述包 JSON 文本
//! (等分切分,判定确定性;不提交语料——私有题目包样本永不入 git)。
//!
//! 判定纪律:任意字节输入**不 panic**(装配器逐层 fail-closed 返回
//! `AssembleError`,panic = 装配防线缺陷)。

use libfuzzer_sys::fuzz_target;
use vm_runtime::identity::EngineIdentity;
use vm_worker::contract::mirrors::{PrivateBundleMirror, PublicDescriptorExtract};
use vm_worker::contract::schema::ContractValidators;
use vm_worker::contract::{self, semantic, strict_value::StrictValue};
use vm_worker::session::assemble;

fn validators() -> &'static ContractValidators {
    static VALIDATORS: std::sync::OnceLock<ContractValidators> = std::sync::OnceLock::new();
    VALIDATORS
        .get_or_init(|| ContractValidators::compile().expect("冻结 Schema 编译必须成功"))
}

fuzz_target!(|data: &[u8]| {
    let mid = data.len() / 2;
    let (Some(bundle_text), Some(descriptor_text)) = (
        std::str::from_utf8(&data[..mid]).ok(),
        std::str::from_utf8(&data[mid..]).ok(),
    ) else {
        return;
    };
    let (Ok(bundle_strict), Ok(descriptor_strict)) = (
        StrictValue::parse(bundle_text),
        StrictValue::parse(descriptor_text),
    ) else {
        return;
    };
    let bundle_json = contract::to_json_value(&bundle_strict);
    let descriptor_json = contract::to_json_value(&descriptor_strict);

    let validators = validators();
    if !validators.private_bundle.is_valid(&bundle_json)
        || !validators.public_descriptor.is_valid(&descriptor_json)
    {
        return;
    }
    if semantic::check_document(&contract::strict_from_value(&bundle_json)).is_err()
        || semantic::check_document(&contract::strict_from_value(&descriptor_json)).is_err()
    {
        return;
    }
    let Ok(mirror) = serde_json::from_value::<PrivateBundleMirror>(bundle_json.clone()) else {
        return;
    };
    let Ok(public) = serde_json::from_value::<PublicDescriptorExtract>(descriptor_json.clone())
    else {
        return;
    };
    // 双包身份一致(与 handle_load 同一互证);不一致即拒绝,不进装配。
    if mirror.challenge_id != public.challenge_id
        || mirror.challenge_content_version != public.challenge_content_version
        || mirror.vm_profile_version != public.vm_profile_version
    {
        return;
    }
    // 自报面取包内声明值,使版本锁定通过、装配深层可达;会话种子缺省
    // (fixed 策略)。装配必须全或无:Ok(产物整体丢弃)/ Err(fail-closed),
    // panic 即缺陷。
    let identity = EngineIdentity {
        vm_engine_version: mirror.vm_engine_version.clone(),
        engine_build_id: mirror.engine_build_id.clone().unwrap_or_default(),
    };
    let _ = assemble::assemble(
        &mirror,
        &bundle_json,
        &public,
        &descriptor_json,
        None,
        &identity,
    );
});

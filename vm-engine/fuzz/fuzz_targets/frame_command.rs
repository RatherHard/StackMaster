#![no_main]
//! fuzz 目标:动作 / 命令解析器(引擎进程协议命令面)。
//!
//! 管线与 `vm_worker::protocol::worker::Worker` 同构:字节 → UTF-8 →
//! 严格 JSON(`StrictValue`,重复键 / 孤立代理项拒绝)→ `WorkerCommand`
//! serde 反序列化(deny_unknown_fields)→ apply_action 时动作请求走
//! 完整契约校验管线(语义承接 + 冻结 Schema)。
//!
//! 判定纪律:任意字节输入**不 panic**;一切畸形输入必须被拒绝(Err /
//! 返回假),静默误收即缺陷。

use libfuzzer_sys::fuzz_target;
use vm_worker::contract::mirrors::ActionRequestMirror;
use vm_worker::contract::schema::ContractValidators;
use vm_worker::contract::{self, strict_value::StrictValue};
use vm_worker::protocol::message::WorkerCommand;

fn validators() -> &'static ContractValidators {
    static VALIDATORS: std::sync::OnceLock<ContractValidators> = std::sync::OnceLock::new();
    VALIDATORS
        .get_or_init(|| ContractValidators::compile().expect("冻结 Schema 编译必须成功"))
}

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let Ok(strict) = StrictValue::parse(text) else {
        return;
    };
    let value = contract::to_json_value(&strict);
    let Ok(command) = serde_json::from_value::<WorkerCommand>(value) else {
        return;
    };
    let _ = command.seq();
    if let WorkerCommand::ApplyAction { action_request, .. } = command {
        let strict_action = contract::strict_from_value(&action_request);
        // 拒绝必须显式(Err),不得误收;通过则镜像反序列化同样不 panic。
        if let Ok(validated) =
            contract::validate_strict_value(&validators().action_request, &strict_action)
        {
            let _ = serde_json::from_value::<ActionRequestMirror>(validated);
        }
    }
});

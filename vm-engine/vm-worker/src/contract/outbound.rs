//! 出站契约面 JSON 转换(WP-7):`projection` crate 生成类型 →
//! `serde_json::Value`(冻结 JSON Schema 的校验输入;编排器对 worker 输出
//! 按同一契约重新校验的落点,引擎进程协议 §一 / 投影与错误契约语义 §5.3)。
//!
//! # 无镜像类型的设计(镜像漂移的结构性消除)
//!
//! 入站面(ActionRequest / 私有包)以 serde 镜像类型 + schemars 漂移冒烟
//! 消费;出站面的字段集合**单一来源就是 `projection` crate 的生成类型**——
//! 本模块只提供生成类型到 JSON 值的 1:1 保形转换,不另立第二套字段集合,
//! 镜像漂移在结构上不可能发生。正确性由三重闭环锁定(测试见本模块底部):
//!
//! 1. 转换产物通过阶段一冻结的 JSON Schema(拒绝未知字段,I-1 / ZR-P1);
//! 2. 转换产物经规范化序列化([`super::canonical`])后与 `projection`
//!    crate 的规范化输出文本([`projection::types::CanonicalText`])**逐字节
//!    相等**——两条序列化路径同一内容;
//! 3. `ActionResponse` 信封的 rejected 耦合(delta null / events 空 /
//!    error 必有)由 Schema `if/then` 注入形态承接(语义文档 §六)。

use serde_json::{Value, json};

use projection::types::{
    ActionProjection, ControlFlow, CurrentInstruction, DirtyRange, ErrorAddress, ErrorExplanation,
    ProjectionDelta, PublicCallFrame, PublicError, PublicEvent, PublicRegister,
    PublicStateProjection, PublicStatus, SemanticHighlight, VisibleMemoryRegion,
};

/// 字节序列 → 小写十六进制(与投影规范化文本同一编码原语,单一来源)。
fn bytes_hex(bytes: &[u8]) -> String {
    projection::canon::hex_encode_lower(bytes)
}

/// 地址 → 大写变长十六进制(同一编码原语)。
fn address_hex(address: u64) -> String {
    projection::types::format_address(address)
}

fn visible_region_to_json(region: &VisibleMemoryRegion) -> Value {
    json!({
        "regionId": region.region_id,
        "label": region.label,
        "startAddressHex": address_hex(region.start),
        "byteLength": region.byte_length,
        "permissions": region.permissions,
        "bytesHex": bytes_hex(&region.bytes),
        "truncated": region.truncated,
    })
}

fn register_to_json(register: &PublicRegister) -> Value {
    json!({
        "name": register.name,
        "valueHex": register.value.format_hex(),
    })
}

fn call_frame_to_json(frame: &PublicCallFrame) -> Value {
    let mut object = json!({
        "index": frame.index,
        "functionLabel": frame.function_label,
        "returnAddressHex": address_hex(frame.return_address),
    });
    if frame.truncated {
        object["truncated"] = json!(true);
    }
    object
}

fn control_flow_to_json(flow: &ControlFlow) -> Value {
    let current: &CurrentInstruction = &flow.current_instruction;
    json!({
        "currentInstruction": {
            "addressHex": address_hex(current.address),
            "text": current.text,
        },
        "pausedOn": flow.paused_on.map(paused_on_str),
    })
}

fn paused_on_str(kind: projection::types::PauseKind) -> &'static str {
    match kind {
        projection::types::PauseKind::Read => "read",
        projection::types::PauseKind::Write => "write",
        projection::types::PauseKind::Call => "call",
        projection::types::PauseKind::Ret => "ret",
        projection::types::PauseKind::Exception => "exception",
    }
}

fn highlight_to_json(highlight: &SemanticHighlight) -> Value {
    json!({
        "kind": highlight_kind_str(highlight.kind),
        "targetRegionId": highlight.target_region_id,
        "startAddressHex": address_hex(highlight.start),
        "byteLength": highlight.byte_length,
        "label": highlight.label,
    })
}

fn highlight_kind_str(kind: projection::types::HighlightKind) -> &'static str {
    match kind {
        projection::types::HighlightKind::BufferStart => "buffer_start",
        projection::types::HighlightKind::ReturnAddressSlot => "return_address_slot",
        projection::types::HighlightKind::SavedRbpSlot => "saved_rbp_slot",
        projection::types::HighlightKind::CanarySlot => "canary_slot",
        projection::types::HighlightKind::Custom => "custom",
    }
}

fn status_str(status: PublicStatus) -> &'static str {
    match status {
        PublicStatus::Running => "running",
        PublicStatus::Paused => "paused",
        PublicStatus::Won => "won",
        PublicStatus::Failed => "failed",
    }
}

/// `PublicStateProjection` → JSON(7 字段,I-1 白名单)。
pub fn projection_to_json(projection: &PublicStateProjection) -> Value {
    json!({
        "revision": projection.revision,
        "visibleRegions": projection.visible_regions.iter().map(visible_region_to_json).collect::<Vec<_>>(),
        "visibleRegisters": projection.visible_registers.iter().map(register_to_json).collect::<Vec<_>>(),
        "callStackSummary": projection.call_stack_summary.iter().map(call_frame_to_json).collect::<Vec<_>>(),
        "controlFlow": control_flow_to_json(&projection.control_flow),
        "semanticHighlights": projection.semantic_highlights.iter().map(highlight_to_json).collect::<Vec<_>>(),
        "status": status_str(projection.status),
    })
}

fn dirty_range_to_json(range: &DirtyRange) -> Value {
    let mut object = json!({
        "regionId": range.region_id,
        "startAddressHex": address_hex(range.start),
        "bytesHex": bytes_hex(&range.bytes),
    });
    if range.truncated {
        object["truncated"] = json!(true);
    }
    object
}

/// `ProjectionDelta` → JSON(可选字段缺席 = 键整体缺席,I-4)。
pub fn delta_to_json(delta: &ProjectionDelta) -> Value {
    let mut object = json!({
        "revision": delta.revision,
        "dirtyRanges": delta.dirty_ranges.iter().map(dirty_range_to_json).collect::<Vec<_>>(),
        "changedRegisters": delta.changed_registers.iter().map(register_to_json).collect::<Vec<_>>(),
    });
    if let Some(flow) = &delta.control_flow {
        object["controlFlow"] = control_flow_to_json(flow);
    }
    if let Some(status) = delta.status {
        object["status"] = json!(status_str(status));
    }
    if let Some(frames) = &delta.call_stack_summary {
        object["callStackSummary"] =
            json!(frames.iter().map(call_frame_to_json).collect::<Vec<_>>());
    }
    if let Some(highlights) = &delta.semantic_highlights {
        object["semanticHighlights"] =
            json!(highlights.iter().map(highlight_to_json).collect::<Vec<_>>());
    }
    object
}

fn event_to_json(event: &PublicEvent) -> Value {
    let mut object = json!({
        "seq": event.seq,
        "kind": event_kind_str(event.kind),
    });
    if let Some(address) = event.address {
        object["addressHex"] = json!(address_hex(address));
    }
    if let Some(length) = event.byte_length {
        object["byteLength"] = json!(length);
    }
    if let Some(payload) = &event.payload {
        object["payloadHex"] = json!(bytes_hex(payload));
    }
    if event.truncated {
        object["truncated"] = json!(true);
    }
    object
}

fn event_kind_str(kind: projection::types::PublicEventKind) -> &'static str {
    match kind {
        projection::types::PublicEventKind::Read => "read",
        projection::types::PublicEventKind::Write => "write",
        projection::types::PublicEventKind::Call => "call",
        projection::types::PublicEventKind::Ret => "ret",
        projection::types::PublicEventKind::Syscall => "syscall",
        projection::types::PublicEventKind::Exception => "exception",
    }
}

fn explanation_to_json(explanation: &ErrorExplanation) -> Value {
    let mut object = json!({});
    if let Some(region_id) = &explanation.region_id {
        object["regionId"] = json!(region_id);
    }
    if let Some(permissions) = &explanation.permissions {
        object["permissions"] = json!(permissions);
    }
    if let Some(value) = explanation.value_hex {
        object["valueHex"] = json!(value.format_hex());
    }
    if let Some(interpreted) = explanation.interpreted_as {
        object["interpretedAs"] = json!(interpreted_as_str(interpreted));
    }
    if let Some(alignment) = explanation.alignment_bytes {
        object["alignmentBytes"] = json!(alignment);
    }
    if let Some(expected) = explanation.expected_bytes_length {
        object["expectedBytesLength"] = json!(expected);
    }
    if let Some(actual) = explanation.actual_bytes_length {
        object["actualBytesLength"] = json!(actual);
    }
    if let Some(hints) = &explanation.hints {
        object["hints"] = json!(hints);
    }
    object
}

fn interpreted_as_str(interpreted: projection::types::InterpretedAs) -> &'static str {
    match interpreted {
        projection::types::InterpretedAs::LittleEndianQword => "little_endian_qword",
        projection::types::InterpretedAs::LittleEndianDword => "little_endian_dword",
        projection::types::InterpretedAs::BigEndianQword => "big_endian_qword",
        projection::types::InterpretedAs::BigEndianDword => "big_endian_dword",
    }
}

/// `PublicError` → JSON(addressHex 三态:缺席 = 键缺席,coarse 零解释)。
pub fn error_to_json(error: &PublicError) -> Value {
    let mut object = json!({
        "code": error.code.as_str(),
        "message": error.message,
    });
    match error.address {
        ErrorAddress::Absent => {}
        ErrorAddress::Null => object["addressHex"] = Value::Null,
        ErrorAddress::Real(address) => object["addressHex"] = json!(address_hex(address)),
    }
    if let Some(explanation) = &error.explanation {
        object["explanation"] = explanation_to_json(explanation);
    }
    object
}

/// `ActionResponse` 信封(除 `requestId` 外五字段由生成面承载;
/// `requestId` 由编排器 / worker 签发回传,引擎进程协议 §三)。
pub fn action_response_to_json(request_id: &str, response: &ActionProjection) -> Value {
    let mut object = json!({
        "requestId": request_id,
        "revision": response.revision,
        "status": response_status_str(response.status),
        "projectionDelta": response
            .delta
            .as_ref()
            .map(delta_to_json)
            .unwrap_or(Value::Null),
        "publicEvents": response.events.iter().map(event_to_json).collect::<Vec<_>>(),
    });
    if let Some(error) = &response.error {
        object["userVisibleError"] = error_to_json(error);
    }
    object
}

fn response_status_str(status: projection::types::ResponseStatus) -> &'static str {
    match status {
        projection::types::ResponseStatus::Running => "running",
        projection::types::ResponseStatus::Paused => "paused",
        projection::types::ResponseStatus::Won => "won",
        projection::types::ResponseStatus::Failed => "failed",
        projection::types::ResponseStatus::Rejected => "rejected",
    }
}

/// 快照信封 → JSON(§4.7,D-F5 信封五字段;载荷 1:1 保形)。
pub fn snapshot_envelope_to_json(envelope: &crate::protocol::message::SnapshotEnvelope) -> Value {
    json!({
        "snapshotFormatVersion": envelope.snapshot_format_version,
        "vmEngineVersion": envelope.vm_engine_version,
        "engineBuildId": envelope.engine_build_id,
        "revision": envelope.revision,
        "payload": envelope.payload,
    })
}

/// create_checkpoint 回执信封 → JSON(§4.7,D-F7:checkpointId 在快照信封外)。
pub fn checkpoint_export_to_json(export: &crate::protocol::message::CheckpointExport) -> Value {
    json!({
        "checkpointId": export.checkpoint_id,
        "snapshot": snapshot_envelope_to_json(&export.snapshot),
    })
}

#[cfg(test)]
mod tests {
    use super::super::schema::SchemaValidator;

    use super::super::{canonical, strict_from_value};
    use super::*;
    use projection::types::CanonicalText;
    use projection::types::{
        HighlightKind, InterpretedAs, PauseKind, PublicErrorCode, PublicEventKind,
    };

    /// 测试用架构值构造(64 位容器)。
    fn arch_value(raw: u64) -> vm_core::arch::ArchValue {
        vm_core::arch::ArchValue::new(raw, vm_core::arch::ArchBits::B64)
    }

    /// 双路序列化闭环:转换产物经规范化序列化 == 投影 crate 的规范化文本
    /// (生成面输出与出站 JSON 同一内容,逐字节)。
    #[test]
    fn outbound_json_canonicalizes_to_projection_canonical_text() {
        let event = PublicEvent {
            seq: 0,
            kind: PublicEventKind::Write,
            address: Some(0x1000),
            byte_length: Some(2),
            payload: Some(vec![0xab, 0xcd]),
            truncated: false,
        };
        let delta = ProjectionDelta {
            revision: 3,
            dirty_ranges: vec![DirtyRange {
                region_id: String::from("buffer"),
                start: 0x1000,
                bytes: vec![0xab, 0xcd],
                truncated: true,
            }],
            changed_registers: Vec::new(),
            control_flow: None,
            status: Some(PublicStatus::Paused),
            call_stack_summary: None,
            semantic_highlights: None,
        };
        assert_eq!(
            canonical::canonicalize(&strict_from_value(&delta_to_json(&delta))).unwrap(),
            delta.to_canonical()
        );
        assert_eq!(
            canonical::canonicalize(&strict_from_value(&event_to_json(&event))).unwrap(),
            event.to_canonical()
        );
    }

    /// 全量 Schema 闭环(契约纪律:一切响应先经冻结 Schema 自检):
    /// 生成的投影 / 增量 / 事件 / 错误 / 响应信封全部通过冻结 JSON Schema。
    #[test]
    fn generated_faces_pass_frozen_json_schemas() {
        let root = env!("CARGO_MANIFEST_DIR");
        let load = |name: &str| {
            std::fs::read_to_string(format!("{root}/../../packages/protocol/schema/{name}"))
                .expect("schema 文件存在")
        };
        let projection_schema =
            SchemaValidator::compile(&load("public-state-projection.schema.json")).unwrap();
        let delta_schema = SchemaValidator::compile(&load("projection-delta.schema.json")).unwrap();
        let error_schema = SchemaValidator::compile(&load("public-error.schema.json")).unwrap();
        let response_schema =
            SchemaValidator::compile(&load("action-response.schema.json")).unwrap();

        // 完整投影(含截断区域 / 帧 / 高亮 / 暂停控制流)。
        let projection = PublicStateProjection {
            revision: 7,
            visible_regions: vec![VisibleMemoryRegion {
                region_id: String::from("buffer"),
                label: String::from("缓冲区"),
                start: 0x2000_0000,
                byte_length: 4096,
                permissions: String::from("rw"),
                bytes: vec![0u8; 256],
                truncated: true,
            }],
            visible_registers: vec![PublicRegister {
                name: String::from("RAX"),
                value: arch_value(0xFF10),
            }],
            call_stack_summary: vec![PublicCallFrame {
                index: 0,
                function_label: String::from("0x401"),
                return_address: 2,
                truncated: false,
            }],
            control_flow: ControlFlow {
                current_instruction: CurrentInstruction {
                    address: 1,
                    text: String::from("mov [RSP-0x8], RAX"),
                },
                paused_on: Some(PauseKind::Write),
            },
            semantic_highlights: vec![SemanticHighlight {
                kind: HighlightKind::BufferStart,
                target_region_id: String::from("buffer"),
                start: 0x2000_0000,
                byte_length: 8,
                label: String::from("缓冲区起点"),
            }],
            status: PublicStatus::Paused,
        };
        let projection_json = projection_to_json(&projection);
        assert!(
            projection_schema.is_valid(&projection_json),
            "完整投影应通过冻结 Schema:{projection_json}"
        );
        assert!(
            projection_schema
                .is_valid(&serde_json::from_str::<Value>(&projection.to_canonical()).unwrap()),
            "规范化文本形态同样通过 Schema(双路一致性)"
        );

        // 增量(空 + 满形态)。
        for delta in [minimal_delta(), delta_with_all_optional_fields()] {
            let delta_json = delta_to_json(&delta);
            assert!(
                delta_schema.is_valid(&delta_json),
                "增量应通过冻结 Schema:{delta_json}"
            );
        }

        // 错误:16 码全矩阵,字段形态取自冻结能力矩阵(与生成面一致;
        // 矩阵违规在生成面 fail-closed,不可能到达出站转换)。
        for code in all_codes() {
            let (address_mode, explanation_cap) = projection::error::capabilities(code);
            let address = match address_mode {
                projection::error::AddressHexMode::Forbidden => ErrorAddress::Absent,
                projection::error::AddressHexMode::NullOnly => ErrorAddress::Null,
                _ => ErrorAddress::Real(0x2000_0010),
            };
            // 零解释形态(coarse 级生成面裁剪后的载荷)。
            let explanation = explanation_cap.allowed.then(explanation_fixture);
            let error = PublicError {
                code,
                message: String::from("静态文案"),
                address: address.clone(),
                explanation,
            };
            let error_json = error_to_json(&error);
            assert!(
                error_schema.is_valid(&error_json),
                "code {code:?} 应通过冻结 Schema:{error_json}"
            );
            // 双形态:零解释(coarse)与满解释(educational)都是合法载荷形态。
            if explanation_cap.allowed {
                let rich = PublicError {
                    code,
                    message: String::from("静态文案"),
                    address,
                    explanation: Some(explanation_fixture()),
                };
                let rich_json = error_to_json(&rich);
                assert!(
                    error_schema.is_valid(&rich_json),
                    "code {code:?} 满解释形态应通过冻结 Schema:{rich_json}"
                );
            }
        }

        // 响应信封:已执行(有增量)与拒绝(delta null / events 空 / error 必有)。
        let executed = ActionProjection::executed(
            4,
            PublicStatus::Running,
            minimal_delta(),
            vec![PublicEvent {
                seq: 0,
                kind: PublicEventKind::Syscall,
                address: None,
                byte_length: None,
                payload: None,
                truncated: false,
            }],
            None,
        );
        let rejected = ActionProjection::rejected(
            4,
            PublicError {
                code: PublicErrorCode::InaccessibleAddress,
                message: String::from("目标地址不可访问"),
                address: ErrorAddress::Null,
                explanation: None,
            },
        );
        for response in [executed, rejected] {
            let response_json = action_response_to_json("req_1", &response);
            assert!(
                response_schema.is_valid(&response_json),
                "响应信封应通过冻结 Schema:{response_json}"
            );
        }
    }

    fn minimal_delta() -> ProjectionDelta {
        ProjectionDelta {
            revision: 1,
            dirty_ranges: Vec::new(),
            changed_registers: Vec::new(),
            control_flow: None,
            status: None,
            call_stack_summary: None,
            semantic_highlights: None,
        }
    }

    fn delta_with_all_optional_fields() -> ProjectionDelta {
        ProjectionDelta {
            revision: 2,
            dirty_ranges: vec![DirtyRange {
                region_id: String::from("buffer"),
                start: 0x2000_0000,
                bytes: vec![1, 2, 3],
                truncated: false,
            }],
            changed_registers: vec![PublicRegister {
                name: String::from("RAX"),
                value: arch_value(1),
            }],
            control_flow: Some(ControlFlow {
                current_instruction: CurrentInstruction {
                    address: 0,
                    text: String::from("mov RAX, 0x1"),
                },
                paused_on: None,
            }),
            status: Some(PublicStatus::Won),
            call_stack_summary: Some(vec![PublicCallFrame {
                index: 0,
                function_label: String::from("0x0"),
                return_address: 1,
                truncated: true,
            }]),
            semantic_highlights: Some(vec![SemanticHighlight {
                kind: HighlightKind::CanarySlot,
                target_region_id: String::from("buffer"),
                start: 0x2000_0010,
                byte_length: 8,
                label: String::from("canary"),
            }]),
        }
    }

    fn explanation_fixture() -> ErrorExplanation {
        ErrorExplanation {
            region_id: Some(String::from("buffer")),
            permissions: Some(String::from("rw")),
            value_hex: Some(arch_value(0x1234)),
            interpreted_as: Some(InterpretedAs::LittleEndianDword),
            alignment_bytes: Some(4),
            expected_bytes_length: Some(8),
            actual_bytes_length: Some(16),
            hints: Some(vec![String::from("检查 little-endian 字节序")]),
        }
    }

    fn all_codes() -> Vec<PublicErrorCode> {
        use PublicErrorCode as C;
        vec![
            C::InvalidInputFormat,
            C::InvalidPayloadLength,
            C::OffsetOutOfRange,
            C::EndiannessMismatch,
            C::PermissionDenied,
            C::InvalidRip,
            C::CanaryViolation,
            C::InvalidCallArgument,
            C::ObjectiveNotMet,
            C::InaccessibleAddress,
            C::BudgetExhausted,
            C::StaleBaseRevision,
            C::StaleClientSeq,
            C::IdempotencyConflict,
            C::SessionTerminal,
            C::InternalError,
        ]
    }
}

//! 公开事件管线(WP-1 §4.2 / 决策 D4;WP-7 实现语义)。
//!
//! # 管线五步(全部是确定性纯函数)
//!
//! ```text
//! 私有事件切片(本动作新增段)
//!   1. 类别白名单:六公开类保留;Internal / FileGranted / FileRead 永不入公开面
//!   2. 可见性过滤:read/write/call/ret 的地址范围必须完全落在可见区域覆盖内,
//!      否则整个事件丢弃(无占位、无条目——D4;I-9:不可见访问不可观测)
//!   3. 载荷承载:write 事件载荷 = 动作后权威内存读回(存储面,与 dirty range
//!      同源)——payloadHex 字节长度 == byteLength 的 superRefine 一致性由
//!      生成侧结构性保证
//!   4. 稠密编号:seq 从 0 起,动作内独立(D4:禁止沿用私有序号,序号空洞
//!      即隐藏事件计数侧信道)
//!   5. 确定性聚合:公开事件 > 256 时保留前 255 + 一个聚合事件(truncated
//!      标记;聚合只读取公开事件列表自身,不读取任何私有状态——WP-1 v1.2)
//! ```
//!
//! # 可见性规则(I-8 / I-9)
//!
//! - `read` / `write`:访问范围部分不可见即整事件丢弃(可见部分仍以 dirty
//!   range 承载;事件面不留"部分可见"的探测形态);
//! - `call` / `ret`:地址为代码地址(MVP 公开);不可见即丢弃;
//! - `syscall`:无地址,恒保留;
//! - `exception`:异常本身是玩家可观测事实(响应错误同源),事件恒保留;
//!   地址仅在可见时携带——隐藏映射与未映射地址的异常事件字节形态一致(I-9)。

use alloc::vec::Vec;

use vm_core::arch::ArchValue;
use vm_core::memory::VirtualMemory;
use vm_core::state::{VmEvent, VmEventKind};

use crate::policy::ProjectionPolicy;
use crate::types::PublicEvent;
use crate::types::PublicEventKind;

/// 每动作公开事件数上限(D4 冻结;超限确定性聚合)。
pub const MAX_PUBLIC_EVENTS_PER_ACTION: usize = 256;

/// 聚合后保留的逐条事件数(最后一位留给聚合事件)。
const KEPT_BEFORE_AGGREGATE: usize = MAX_PUBLIC_EVENTS_PER_ACTION - 1;

/// 私有事件类别 → 公开事件类别(白名单映射;`None` = 永不入公开面的内部类)。
fn public_kind(kind: VmEventKind) -> Option<PublicEventKind> {
    match kind {
        VmEventKind::Read => Some(PublicEventKind::Read),
        VmEventKind::Write => Some(PublicEventKind::Write),
        VmEventKind::Call => Some(PublicEventKind::Call),
        VmEventKind::Ret => Some(PublicEventKind::Ret),
        VmEventKind::Syscall => Some(PublicEventKind::Syscall),
        VmEventKind::Exception => Some(PublicEventKind::Exception),
        VmEventKind::Internal | VmEventKind::FileGranted | VmEventKind::FileRead => None,
    }
}

/// 事件可见性判定:`Some(可见)` = 保留(地址是否携带见变体规则);
/// `None` = 整事件丢弃。
fn event_visible(
    policy: &ProjectionPolicy,
    memory: &VirtualMemory,
    kind: PublicEventKind,
    address: Option<u64>,
    byte_length: Option<u64>,
) -> bool {
    match kind {
        PublicEventKind::Read | PublicEventKind::Write => {
            // 访问范围必须完全可见(缺地址 / 缺宽度的形态不产生公开事件——
            // 引擎侧 read/write 事件恒携带两者,缺席即内部缺陷,宁可丢弃)。
            match (address, byte_length) {
                (Some(addr), Some(len)) => {
                    matches!(
                        policy.classify_write_range(memory, addr, len),
                        crate::policy::WriteTargetClass::Covered { .. }
                    )
                }
                _ => false,
            }
        }
        PublicEventKind::Call | PublicEventKind::Ret => {
            address.is_some_and(|addr| policy.is_address_visible(memory, addr))
        }
        // syscall 无地址,恒保留;exception 恒保留(地址携带与否见管线)。
        PublicEventKind::Syscall | PublicEventKind::Exception => true,
    }
}

/// 存储面读回:按页拼接 `[address, address + len)` 的当前权威字节
/// (不走权限检查——写入已成功,读回是其公开表面的内容来源,D-P2)。
/// 页未物化(理论不可达:成功写入必已物化目标页)返回 `None`,载荷缺席。
pub(crate) fn read_storage_bytes(
    memory: &VirtualMemory,
    address: u64,
    len: u64,
) -> Option<Vec<u8>> {
    let page_size = memory.page_size();
    let mut out = Vec::new();
    let mut cursor = address;
    let mut remaining = len;
    while remaining > 0 {
        let page_no = cursor / page_size;
        let offset = (cursor % page_size) as usize;
        let page = memory.page_bytes(page_no)?;
        let take = usize::try_from(remaining).ok()?;
        let take = take
            .min(page.len() - offset)
            .min(page_size as usize - offset);
        out.extend_from_slice(&page[offset..offset + take]);
        cursor += take as u64;
        remaining -= take as u64;
    }
    Some(out)
}

/// 公开事件管线:私有事件切片 → 公开事件列表(D4;规则见模块文档)。
///
/// `new_private_events` 是**本动作新增**的私有事件段(动作前日志长度之后的
/// 切片,由调用方承载;undo / reset 的历史回退不重发历史事件)。
pub fn public_events(
    policy: &ProjectionPolicy,
    memory: &VirtualMemory,
    new_private_events: &[VmEvent],
) -> Vec<PublicEvent> {
    let mut public: Vec<PublicEvent> = Vec::new();
    for event in new_private_events {
        let Some(kind) = public_kind(event.kind) else {
            continue;
        };
        let address = event.address.map(ArchValue::get);
        if !event_visible(policy, memory, kind, address, event.byte_length) {
            continue;
        }
        // exception 地址仅在可见时携带(I-9:隐藏与未映射同形态)。
        let address = match kind {
            PublicEventKind::Exception => {
                address.filter(|addr| policy.is_address_visible(memory, *addr))
            }
            _ => address,
        };
        // 写事件载荷:动作后权威内存读回(可见性已在范围判定保证);
        // 读回失败(理论不可达)按无载荷形态下发,byteLength 保留。
        let payload = match kind {
            PublicEventKind::Write => address
                .zip(event.byte_length)
                .and_then(|(addr, len)| read_storage_bytes(memory, addr, len)),
            _ => None,
        };
        public.push(PublicEvent {
            seq: 0,
            kind,
            address,
            byte_length: event.byte_length,
            payload,
            truncated: false,
        });
    }
    // 确定性聚合(D-P4):只读取公开事件列表自身;聚合事件承载首个被聚合
    // 事件的类别——类别是玩家动作的公开语义,无隐藏信息。
    if public.len() > MAX_PUBLIC_EVENTS_PER_ACTION {
        let aggregate_kind = public[KEPT_BEFORE_AGGREGATE].kind;
        public.truncate(KEPT_BEFORE_AGGREGATE);
        public.push(PublicEvent {
            seq: KEPT_BEFORE_AGGREGATE as u32,
            kind: aggregate_kind,
            address: None,
            byte_length: None,
            payload: None,
            truncated: true,
        });
    }
    for (index, event) in public.iter_mut().enumerate() {
        event.seq = index as u32;
    }
    public
}

#[cfg(test)]
mod tests {
    extern crate std;

    use alloc::string::String;
    use alloc::vec;
    use alloc::vec::Vec;

    use vm_core::arch::ArchBits;
    use vm_core::memory::{ExecutionMode, Permissions, RegionContents, RegionKind, RegionSpec};
    use vm_core::state::VmEvent;

    use super::*;
    use crate::policy::{ErrorDetailLevel, ProjectionPolicy, ProjectionPolicySpec, SecretSinkSet};

    const A32: ArchBits = ArchBits::B32;

    fn event(kind: VmEventKind, address: Option<u64>, byte_length: Option<u64>) -> VmEvent {
        VmEvent {
            seq: 0,
            kind,
            address: address.map(|addr| ArchValue::new(addr, A32)),
            byte_length,
            payload: None,
        }
    }

    fn fixture() -> (ProjectionPolicy, VirtualMemory) {
        let regions = vec![
            RegionSpec::new(
                "stack",
                RegionKind::Stack,
                None,
                0x7FFF_F000,
                4096,
                Permissions::parse("rw").unwrap(),
                A32,
            )
            .unwrap(),
            RegionSpec::new(
                "secret",
                RegionKind::Key,
                None,
                0x5000_0000,
                4096,
                Permissions::parse("rw").unwrap(),
                A32,
            )
            .unwrap(),
        ];
        let memory = VirtualMemory::new(
            A32,
            4096,
            ExecutionMode::Ir,
            regions,
            vec![
                RegionContents {
                    region_id: String::from("stack"),
                    bytes: vec![0u8; 4096],
                },
                RegionContents {
                    region_id: String::from("secret"),
                    bytes: vec![0u8; 4096],
                },
            ],
        )
        .unwrap();
        let policy = ProjectionPolicy::assemble(
            ProjectionPolicySpec {
                visible_regions: vec![String::from("stack")],
                visible_objects: Vec::new(),
                visible_registers: vec![String::from("RAX")],
                max_bytes_per_range: None,
                error_detail_level: ErrorDetailLevel::Educational,
            },
            &SecretSinkSet::default(),
        )
        .unwrap();
        (policy, memory)
    }

    #[test]
    fn internal_kinds_never_enter_public_face() {
        let (policy, memory) = fixture();
        let private = vec![
            event(VmEventKind::Internal, None, None),
            event(VmEventKind::FileGranted, Some(0x7FFF_F000), None),
            event(VmEventKind::FileRead, Some(0x7FFF_F000), None),
            event(VmEventKind::Write, Some(0x7FFF_F000), Some(4)),
        ];
        let public = public_events(&policy, &memory, &private);
        assert_eq!(public.len(), 1);
        assert_eq!(public[0].kind, PublicEventKind::Write);
        assert_eq!(public[0].seq, 0, "seq 独立稠密,无私有空洞(D4)");
    }

    #[test]
    fn invisible_address_events_are_dropped_without_placeholder() {
        let (policy, memory) = fixture();
        let private = vec![
            // 隐藏区域的程序内部读写:整事件丢弃(D4 无占位;I-9 不可观测)。
            event(VmEventKind::Read, Some(0x5000_0000), Some(4)),
            event(VmEventKind::Write, Some(0x5000_0010), Some(4)),
            // 未映射地址:同形态丢弃。
            event(VmEventKind::Read, Some(0x1234), Some(1)),
            // 越出可见边界的部分覆盖写入:整事件丢弃(可见部分走 dirty range)。
            event(VmEventKind::Write, Some(0x7FFF_FFFC), Some(8)),
            // 完全可见:保留。
            event(VmEventKind::Read, Some(0x7FFF_F000), Some(4)),
        ];
        let public = public_events(&policy, &memory, &private);
        assert_eq!(public.len(), 1);
        assert_eq!(public[0].kind, PublicEventKind::Read);
        assert_eq!(public[0].address, Some(0x7FFF_F000));
    }

    #[test]
    fn write_payload_matches_byte_length_from_authoritative_memory() {
        let (policy, mut memory) = fixture();
        // 预置可见区域内容(模拟已发生的写入)。
        memory
            .write_slice(
                vm_core::arch::ArchValue::new(0x7FFF_F010, A32),
                &[0xde, 0xad, 0xbe, 0xef],
            )
            .unwrap();
        let private = vec![event(VmEventKind::Write, Some(0x7FFF_F010), Some(4))];
        let public = public_events(&policy, &memory, &private);
        assert_eq!(public.len(), 1);
        assert_eq!(
            public[0].payload.as_deref(),
            Some(&[0xde, 0xad, 0xbe, 0xef][..])
        );
        assert_eq!(public[0].byte_length, Some(4));
        // superRefine 一致性:payloadHex 字节长度 == byteLength(生成侧保证)。
        assert_eq!(public[0].payload.as_ref().unwrap().len() as u64, 4);
    }

    #[test]
    fn exception_address_only_when_visible_syscall_always_kept() {
        let (policy, memory) = fixture();
        let private = vec![
            // 隐藏地址异常:事件保留、地址缺席(隐藏映射与未映射同形态,I-9)。
            event(VmEventKind::Exception, Some(0x5000_0000), None),
            // 未映射地址异常:同形态。
            event(VmEventKind::Exception, Some(0x9999_9999), None),
            // 可见地址异常:地址携带。
            event(VmEventKind::Exception, Some(0x7FFF_F000), None),
            // syscall 无地址,恒保留。
            event(VmEventKind::Syscall, None, None),
        ];
        let public = public_events(&policy, &memory, &private);
        assert_eq!(public.len(), 4);
        assert_eq!(public[0].address, None);
        assert_eq!(public[1].address, None);
        assert_eq!(public[2].address, Some(0x7FFF_F000));
        assert_eq!(public[3].kind, PublicEventKind::Syscall);
        assert_eq!(public[3].address, None);
    }

    #[test]
    fn over_limit_aggregates_deterministically() {
        let (policy, memory) = fixture();
        // 300 个完全可见写事件 → 255 逐条 + 1 聚合(共 256)。
        let private: Vec<VmEvent> = (0..300)
            .map(|i| event(VmEventKind::Write, Some(0x7FFF_F000 + i * 4), Some(4)))
            .collect();
        let public = public_events(&policy, &memory, &private);
        assert_eq!(public.len(), MAX_PUBLIC_EVENTS_PER_ACTION);
        assert!(public[..255].iter().all(|event| !event.truncated));
        let aggregate = &public[255];
        assert!(aggregate.truncated);
        assert_eq!(
            aggregate.kind,
            PublicEventKind::Write,
            "聚合类别 = 首个被聚合事件"
        );
        assert_eq!(aggregate.address, None);
        assert_eq!(aggregate.payload, None);
        // seq 稠密 0..=255。
        for (index, event) in public.iter().enumerate() {
            assert_eq!(event.seq, index as u32);
        }
        // 确定性:同输入两次生成的公开事件列表逐字节一致(I-4)。
        let again = public_events(&policy, &memory, &private);
        let text_a: Vec<String> = public
            .iter()
            .map(crate::types::CanonicalText::to_canonical)
            .collect();
        let text_b: Vec<String> = again
            .iter()
            .map(crate::types::CanonicalText::to_canonical)
            .collect();
        assert_eq!(text_a, text_b);
    }
}

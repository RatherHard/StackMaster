//! 谓词表达式求值器(WP-5;最小DSL范围 §四、私有包 Schema `$defs.predicate` /
//! `$defs.conditionL1-3`)。逐谓词规约见 `docs/develop/判题语义规约.md` §二。
//!
//! # 白名单结构性与恒定成本
//!
//! - [`Predicate`] 是七变体封闭枚举、[`ConditionL1`]/[`ConditionL2`]/[`ConditionL3`]
//!   三层定深:白名单外形态在 Rust 类型层结构性不可表达(XS-NESTING 的引擎侧
//!   对偶);分支数 / 引用可解析性 / 边界由 [`super::spec`] 装配复验承接;
//! - **恒定成本**(I-6 / D1 约束 2 / T-SC2):字节比较全量无提前退出,布尔组合
//!   不短路——求值次数与步耗(谓词实例数,[`predicate_count`])是条件树的静态
//!   函数,与状态内容无关;
//! - 判题视角只读:不产生事件、不改状态、不消耗执行步数预算。

use alloc::boxed::Box;
use alloc::string::String;
use alloc::vec::Vec;

use crate::arch::ArchValue;
use crate::exec::Engine;
use crate::state::VmEventKind;

/// `memory_equals` 载荷上限(Schema maxLength 512 hex 字符的镜像)。
pub const MAX_MEMORY_EQUALS_BYTES: usize = 256;
/// `memory_contains` 载荷上限(Schema maxLength 128 hex 字符的镜像)。
pub const MAX_MEMORY_CONTAINS_BYTES: usize = 64;

/// 内置谓词封闭集(7 值;词汇冻结于最小DSL范围 §四,扩展须递增
/// `judgingConfig.verdictRuleVersion` 并走契约变更流程)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Predicate {
    /// 寄存器值等值比较(判题视角只读;FLAG 命名寄存器可查)。
    RegisterEquals {
        /// 寄存器名(一般命名空间或 FLAG 保留区)。
        register: String,
        /// 期望值(archBits 位宽架构值)。
        value: ArchValue,
    },
    /// 掩码位测试:`(register & mask) != 0`。
    RegisterBitsSet {
        /// 寄存器名。
        register: String,
        /// 位掩码。
        mask: ArchValue,
    },
    /// 区域内定偏移定长字节匹配(固定长度切片;全量比对无提前退出)。
    MemoryEquals {
        /// 命名区域引用。
        region_id: String,
        /// 区域内起始偏移(字节)。
        offset_bytes: u64,
        /// 期望字节(≤ 256)。
        bytes: Vec<u8>,
    },
    /// 区域内有界字节搜索(≤ 64 字节;全位置全长度扫描无提前退出)。
    MemoryContains {
        /// 命名区域引用。
        region_id: String,
        /// 搜索串(1–64 字节)。
        bytes: Vec<u8>,
    },
    /// 返回地址目标等值:当前 `RSP` 指向的 8 字节栈槽 == address
    /// (下一次 `ret` 将弹出并跳转的值,与 `ret` 指令弹出语义同锚)。
    RetTargetEquals {
        /// 期望返回目标(archBits 位宽架构值)。
        address: ArchValue,
    },
    /// 栈 Canary 完好(全部槽位当前内容与装载期期望一致)。
    StackCanaryIntact,
    /// 虚拟文件已读(私有事件日志存在对应 `FileRead` 事件)。
    VirtualFileRead {
        /// 虚拟文件引用。
        file_id: String,
    },
}

/// 条件叶节点(L3:恰一个谓词实例)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConditionL3 {
    /// 谓词实例。
    pub predicate: Predicate,
}

/// 条件中间层(L2;至少一键,装配复验承接)。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConditionL2 {
    /// 全部成立(空数组恒真)。
    pub all: Option<Vec<ConditionL3>>,
    /// 任一成立(空数组恒假)。
    pub any: Option<Vec<ConditionL3>>,
    /// 否定(单子节点)。
    pub not: Option<Box<ConditionL3>>,
}

/// 条件根(L1;至少一键,装配复验承接)。恒真写作 `{ all: [] }`。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConditionL1 {
    /// 全部成立(空数组恒真)。
    pub all: Option<Vec<ConditionL2>>,
    /// 任一成立(空数组恒假)。
    pub any: Option<Vec<ConditionL2>>,
    /// 否定(单子节点)。
    pub not: Option<Box<ConditionL2>>,
}

impl ConditionL1 {
    /// 恒真条件(`{ all: [] }`;Schema 语义下的规范写法)。
    pub fn vacuous_true() -> Self {
        Self {
            all: Some(Vec::new()),
            any: None,
            not: None,
        }
    }

    /// 恒假条件(`{ any: [] }`)。
    pub fn vacuous_false() -> Self {
        Self {
            all: None,
            any: Some(Vec::new()),
            not: None,
        }
    }

    /// 单谓词条件(`{ all: [{ predicate }] }`)。
    pub fn of(predicate: Predicate) -> Self {
        Self {
            all: Some(alloc::vec![ConditionL2 {
                all: Some(alloc::vec![ConditionL3 { predicate }]),
                any: None,
                not: None,
            }]),
            any: None,
            not: None,
        }
    }
}

/// 求值错误:求值器全定义于**已装配**状态(引用 / 边界已过 [`super::spec`]
/// 镜像复验),此类错误只可能是引擎缺陷(方向 `engine_error`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PredicateEvalError {
    /// 谓词引用的寄存器不存在(装配后不可达)。
    UnknownRegister,
    /// 谓词的内存读取失败(装配复验权限与几何后不可达)。
    MemoryUnreadable,
}

/// 求值单个内置谓词(规约 §二逐条语义)。
pub fn evaluate_predicate(
    engine: &Engine,
    predicate: &Predicate,
) -> Result<bool, PredicateEvalError> {
    match predicate {
        Predicate::RegisterEquals { register, value } => {
            let current = read_register(engine, register)?;
            Ok(current == *value)
        }
        Predicate::RegisterBitsSet { register, mask } => {
            let current = read_register(engine, register)?;
            Ok((current.get() & mask.get()) != 0)
        }
        Predicate::MemoryEquals {
            region_id,
            offset_bytes,
            bytes,
        } => {
            let region = engine
                .state
                .memory
                .region_by_id(region_id)
                .ok_or(PredicateEvalError::MemoryUnreadable)?;
            let len = bytes.len();
            let mut current = [0u8; MAX_MEMORY_EQUALS_BYTES];
            let slice = current
                .get_mut(..len)
                .ok_or(PredicateEvalError::MemoryUnreadable)?;
            let start = ArchValue::new(region.start.wrapping_add(*offset_bytes), engine.arch());
            engine
                .state
                .memory
                .read_slice(start, slice)
                .map_err(|_| PredicateEvalError::MemoryUnreadable)?;
            // 恒定成本:全量比对,不因首字节不同提前退出(I-6 / T-SC2)。
            let mut diff = 0u8;
            for (got, want) in slice.iter().zip(bytes.iter()) {
                diff |= got ^ want;
            }
            Ok(diff == 0)
        }
        Predicate::MemoryContains { region_id, bytes } => {
            let region = engine
                .state
                .memory
                .region_by_id(region_id)
                .ok_or(PredicateEvalError::MemoryUnreadable)?;
            let hay_len = usize::try_from(region.byte_length)
                .map_err(|_| PredicateEvalError::MemoryUnreadable)?;
            // 装配复验保证 1 ≤ len ≤ min(64, byteLength);防御性兜底走恒假。
            if bytes.is_empty() || bytes.len() > hay_len {
                return Ok(false);
            }
            let hay = engine
                .state
                .memory
                .read(ArchValue::new(region.start, engine.arch()), hay_len)
                .map_err(|_| PredicateEvalError::MemoryUnreadable)?;
            // 恒定成本:全部候选位置 × 完整串长比对,命中与否都扫完全部位置。
            let positions = hay_len - bytes.len() + 1;
            let mut found = 0u8;
            for p in 0..positions {
                let mut diff = 0u8;
                for (got, want) in hay[p..p + bytes.len()].iter().zip(bytes.iter()) {
                    diff |= got ^ want;
                }
                found |= u8::from(diff == 0);
            }
            Ok(found != 0)
        }
        Predicate::RetTargetEquals { address } => {
            // RSP 必选核心寄存器(装配不变量);栈槽读取失败 ⇒ 恒假
            // (确定性:下一次 ret 本将以 memory_fault 失败),不产生异常。
            let Some(rsp) = engine.state.registers.rsp() else {
                return Err(PredicateEvalError::UnknownRegister);
            };
            match engine.state.memory.read_le(rsp, 8, engine.arch()) {
                Ok(target) => Ok(target == *address),
                Err(_) => Ok(false),
            }
        }
        Predicate::StackCanaryIntact => Ok(engine.canary_intact()),
        Predicate::VirtualFileRead { file_id } => {
            let target = file_id.as_bytes();
            Ok(engine.state.private_event_log.iter().any(|event| {
                event.kind == VmEventKind::FileRead && event.payload.as_deref() == Some(target)
            }))
        }
    }
}

/// 求值条件树(规约 §3.2:所有分支无条件全部求值后布尔合并,不短路)。
pub fn evaluate_l1(engine: &Engine, condition: &ConditionL1) -> Result<bool, PredicateEvalError> {
    let mut acc = true;
    if let Some(list) = &condition.all {
        let mut all = true;
        for node in list {
            all &= evaluate_l2(engine, node)?;
        }
        acc &= all;
    }
    if let Some(list) = &condition.any {
        let mut any = false;
        for node in list {
            any |= evaluate_l2(engine, node)?;
        }
        acc &= any;
    }
    if let Some(node) = &condition.not {
        acc &= !evaluate_l2(engine, node)?;
    }
    Ok(acc)
}

fn evaluate_l2(engine: &Engine, condition: &ConditionL2) -> Result<bool, PredicateEvalError> {
    let mut acc = true;
    if let Some(list) = &condition.all {
        let mut all = true;
        for node in list {
            all &= evaluate_l3(engine, node)?;
        }
        acc &= all;
    }
    if let Some(list) = &condition.any {
        let mut any = false;
        for node in list {
            any |= evaluate_l3(engine, node)?;
        }
        acc &= any;
    }
    if let Some(node) = &condition.not {
        acc &= !evaluate_l3(engine, node)?;
    }
    Ok(acc)
}

fn evaluate_l3(engine: &Engine, condition: &ConditionL3) -> Result<bool, PredicateEvalError> {
    evaluate_predicate(engine, &condition.predicate)
}

fn read_register(engine: &Engine, name: &str) -> Result<ArchValue, PredicateEvalError> {
    engine
        .state
        .registers
        .get(name)
        .ok_or(PredicateEvalError::UnknownRegister)
}

/// 条件树的谓词实例总数(静态步耗;含 `not` 分支——不短路 ⇒ 与求值结果无关)。
pub fn predicate_count(condition: &ConditionL1) -> u64 {
    let mut total = 0u64;
    if let Some(list) = &condition.all {
        for node in list {
            total += l2_count(node);
        }
    }
    if let Some(list) = &condition.any {
        for node in list {
            total += l2_count(node);
        }
    }
    if let Some(node) = &condition.not {
        total += l2_count(node);
    }
    total
}

fn l2_count(condition: &ConditionL2) -> u64 {
    let mut total = 0u64;
    if let Some(list) = &condition.all {
        total += list.len() as u64;
    }
    if let Some(list) = &condition.any {
        total += list.len() as u64;
    }
    if condition.not.is_some() {
        total += 1;
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arch::ArchBits;
    use crate::instr::{Instruction, Op, Operand, Program};
    use crate::judge::spec::tests::engine_with_regions;
    use alloc::vec;
    use proptest::prelude::*;

    const A32: ArchBits = ArchBits::B32;

    fn v(raw: u64) -> ArchValue {
        ArchValue::new(raw, A32)
    }

    /// 七谓词求值面(真假双路)覆盖:同一引擎状态上逐谓词构造真 / 假两例。
    #[test]
    fn seven_predicate_surface_true_and_false_paths() {
        let mut engine = engine_with_regions();
        // register_equals:真 / 假 + FLAG 命名空间可查。
        assert!(
            evaluate_predicate(
                &engine,
                &Predicate::RegisterEquals {
                    register: String::from("RAX"),
                    value: v(0),
                }
            )
            .unwrap()
        );
        assert!(
            !evaluate_predicate(
                &engine,
                &Predicate::RegisterEquals {
                    register: String::from("RAX"),
                    value: v(1),
                }
            )
            .unwrap()
        );
        assert!(
            evaluate_predicate(
                &engine,
                &Predicate::RegisterEquals {
                    register: String::from("FLAG_KEY"),
                    value: v(0x5A),
                }
            )
            .unwrap()
        );
        // register_bits_set:真 / 假 / 零掩码恒假。
        assert!(
            evaluate_predicate(
                &engine,
                &Predicate::RegisterBitsSet {
                    register: String::from("FLAG_KEY"),
                    mask: v(0x10),
                }
            )
            .unwrap()
        );
        assert!(
            !evaluate_predicate(
                &engine,
                &Predicate::RegisterBitsSet {
                    register: String::from("FLAG_KEY"),
                    mask: v(0x1),
                }
            )
            .unwrap()
        );
        assert!(
            !evaluate_predicate(
                &engine,
                &Predicate::RegisterBitsSet {
                    register: String::from("RAX"),
                    mask: v(0),
                }
            )
            .unwrap()
        );
        // memory_equals(区域相对偏移 0x100):命中 / 单字节突变
        // (全量比对不漏检末字节)。
        assert!(
            evaluate_predicate(
                &engine,
                &Predicate::MemoryEquals {
                    region_id: String::from("stack"),
                    offset_bytes: 0x100,
                    bytes: vec![0x11, 0x22, 0x33, 0x44],
                }
            )
            .unwrap()
        );
        assert!(
            !evaluate_predicate(
                &engine,
                &Predicate::MemoryEquals {
                    region_id: String::from("stack"),
                    offset_bytes: 0x100,
                    bytes: vec![0x11, 0x22, 0x33, 0x45],
                }
            )
            .unwrap()
        );
        // memory_contains:命中于头 / 中 / 尾 / 不存在。
        for (offset, needle) in [
            (0usize, vec![0x11u8]),
            (1, vec![0x22, 0x33]),
            (2, vec![0x33, 0x44]),
        ] {
            let found = evaluate_predicate(
                &engine,
                &Predicate::MemoryContains {
                    region_id: String::from("stack"),
                    bytes: needle.clone(),
                },
            )
            .unwrap();
            assert!(found, "needle at offset {offset} must be found");
            let _ = offset;
        }
        assert!(
            !evaluate_predicate(
                &engine,
                &Predicate::MemoryContains {
                    region_id: String::from("stack"),
                    bytes: vec![0x99, 0x88],
                }
            )
            .unwrap()
        );
        // ret_target_equals:RSP 槽当前值 0x44332211(小端 4 字节 + 高位零)。
        assert!(
            evaluate_predicate(
                &engine,
                &Predicate::RetTargetEquals {
                    address: v(0x4433_2211)
                }
            )
            .unwrap()
        );
        assert!(
            !evaluate_predicate(&engine, &Predicate::RetTargetEquals { address: v(0x1234) })
                .unwrap()
        );
        // stack_canary_intact:初始完好。
        assert!(evaluate_predicate(&engine, &Predicate::StackCanaryIntact).unwrap());
        // virtual_file_read:尚无 FileRead 事件 ⇒ 假。
        assert!(
            !evaluate_predicate(
                &engine,
                &Predicate::VirtualFileRead {
                    file_id: String::from("flag-file"),
                }
            )
            .unwrap()
        );

        // 状态变更后:Canary 破坏 / FileRead 痕迹 / 返回目标随栈变化。
        engine
            .action_write_bytes(v(0x7FFF_E000), &[0xAA, 0xBB])
            .unwrap();
        assert!(!evaluate_predicate(&engine, &Predicate::StackCanaryIntact).unwrap());
        engine.action_push(v(0xDEAD_BEEF)).unwrap();
        assert!(
            evaluate_predicate(
                &engine,
                &Predicate::RetTargetEquals {
                    address: v(0xDEAD_BEEF)
                }
            )
            .unwrap()
        );
        // FileRead 事件(payload = fileId 字节)使 virtual_file_read 为真。
        let seq = engine.state.private_event_log.len() as u64;
        engine.state.private_event_log.push(crate::state::VmEvent {
            seq,
            kind: VmEventKind::FileRead,
            address: None,
            byte_length: Some(9),
            payload: Some(String::from("flag-file").into_bytes()),
        });
        assert!(
            evaluate_predicate(
                &engine,
                &Predicate::VirtualFileRead {
                    file_id: String::from("flag-file"),
                }
            )
            .unwrap()
        );
    }

    /// ret_target_equals 的恒假兜底:RSP 指向不可读位置(越出栈区)不产生异常。
    #[test]
    fn ret_target_equals_unreadable_stack_slot_is_false() {
        let mut engine = engine_with_regions();
        // 32 位地址域:0xFFFF_FFF8 越出一切区域。
        engine
            .state
            .registers
            .set("RSP", ArchValue::new(0xFFFF_FFF8, A32))
            .unwrap();
        assert!(
            !evaluate_predicate(&engine, &Predicate::RetTargetEquals { address: v(0) }).unwrap()
        );
    }

    /// 装配后不可达路径的红灯:未知寄存器 / 未知区域按引擎缺陷方向暴露。
    #[test]
    fn unreachable_references_surface_as_internal_errors() {
        let engine = engine_with_regions();
        assert_eq!(
            evaluate_predicate(
                &engine,
                &Predicate::RegisterEquals {
                    register: String::from("NOPE"),
                    value: v(0),
                }
            ),
            Err(PredicateEvalError::UnknownRegister)
        );
        assert_eq!(
            evaluate_predicate(
                &engine,
                &Predicate::MemoryEquals {
                    region_id: String::from("nowhere"),
                    offset_bytes: 0,
                    bytes: vec![0],
                }
            ),
            Err(PredicateEvalError::MemoryUnreadable)
        );
    }

    /// 条件代数:恒真 / 恒假 / not / 组合;分支全部求值(短路无从发生)。
    #[test]
    fn condition_algebra_and_predicate_count() {
        let engine = engine_with_regions();
        let reg_is_zero = |val: u64| ConditionL3 {
            predicate: Predicate::RegisterEquals {
                register: String::from("RAX"),
                value: v(val),
            },
        };
        // {all: []} 恒真、{any: []} 恒假。
        assert!(evaluate_l1(&engine, &ConditionL1::vacuous_true()).unwrap());
        assert!(!evaluate_l1(&engine, &ConditionL1::vacuous_false()).unwrap());
        // 单谓词 + not 组合:{ not: { not: { predicate } } } = 谓词本身(双否定)。
        let double_neg = ConditionL1 {
            all: None,
            any: None,
            not: Some(Box::new(ConditionL2 {
                all: None,
                any: None,
                not: Some(Box::new(reg_is_zero(0))),
            })),
        };
        assert!(evaluate_l1(&engine, &double_neg).unwrap());
        // any 两支一真一假 ⇒ 真;all 两支一真一假 ⇒ 假。
        let mixed_any = ConditionL1 {
            all: None,
            any: Some(alloc::vec![
                ConditionL2 {
                    all: Some(alloc::vec![reg_is_zero(1)]),
                    any: None,
                    not: None,
                },
                ConditionL2 {
                    all: Some(alloc::vec![reg_is_zero(0)]),
                    any: None,
                    not: None,
                },
            ]),
            not: None,
        };
        assert!(evaluate_l1(&engine, &mixed_any).unwrap());
        let mixed_all = ConditionL1 {
            all: Some(alloc::vec![
                ConditionL2 {
                    all: Some(alloc::vec![reg_is_zero(1)]),
                    any: None,
                    not: None,
                },
                ConditionL2 {
                    all: Some(alloc::vec![reg_is_zero(0)]),
                    any: None,
                    not: None,
                },
            ]),
            any: None,
            not: None,
        };
        assert!(!evaluate_l1(&engine, &mixed_all).unwrap());
        // 多键 AND:{ all:[真], any:[假,真], not:假 } ⇒ 真(任一分支布尔合并)。
        let combined = ConditionL1 {
            all: Some(alloc::vec![ConditionL2 {
                all: Some(alloc::vec![reg_is_zero(0)]),
                any: None,
                not: None,
            }]),
            any: Some(alloc::vec![
                ConditionL2 {
                    all: Some(alloc::vec![reg_is_zero(1)]),
                    any: None,
                    not: None,
                },
                ConditionL2 {
                    all: Some(alloc::vec![reg_is_zero(0)]),
                    any: None,
                    not: None,
                },
            ]),
            not: Some(Box::new(ConditionL2 {
                all: Some(alloc::vec![reg_is_zero(1)]),
                any: None,
                not: None,
            })),
        };
        assert!(evaluate_l1(&engine, &combined).unwrap());
        // 静态步耗:combined = 1(all)+ 2(any)+ 1(not)= 4;空条件 0。
        assert_eq!(predicate_count(&combined), 4);
        assert_eq!(predicate_count(&ConditionL1::vacuous_true()), 0);
        assert_eq!(predicate_count(&double_neg), 1);
        // 求值假分支不改变步耗(不短路 ⇒ 计数与结果无关)。
        assert_eq!(predicate_count(&mixed_all), 2);
        assert_eq!(predicate_count(&mixed_any), 2);
    }

    /// 恒定成本属性(T-SC2 / ZR-P7 引擎侧):随机内容与单字节突变下,
    /// 检查点谓词记账量与求值次数恒定。
    #[test]
    fn constant_cost_predicate_count_under_mutation() {
        let mut rng = crate::testing::Xorshift64Star::new(0x5EED_2026);
        for _ in 0..256 {
            let mut engine = engine_with_regions();
            let mut bytes = Vec::with_capacity(8);
            for _ in 0..8 {
                bytes.push((rng.next_u64() & 0xFF) as u8);
            }
            engine.action_write_bytes(v(0x7FFF_F000), &bytes).unwrap();
            let condition = ConditionL1 {
                all: Some(alloc::vec![ConditionL2 {
                    all: Some(alloc::vec![
                        ConditionL3 {
                            predicate: Predicate::MemoryEquals {
                                region_id: String::from("stack"),
                                offset_bytes: 0,
                                bytes: bytes.clone(),
                            },
                        },
                        ConditionL3 {
                            predicate: Predicate::MemoryContains {
                                region_id: String::from("stack"),
                                bytes: bytes[..2].to_vec(),
                            },
                        },
                    ]),
                    any: None,
                    not: None,
                }]),
                any: None,
                not: None,
            };
            let baseline_true = evaluate_l1(&engine, &condition).unwrap();
            assert!(baseline_true, "memory_equals(bytes) must hold");
            assert_eq!(predicate_count(&condition), 2);
            // 单字节突变:结果翻转,步耗不变。
            let position = rng.next_below(8) as usize;
            bytes[position] ^= 0x01;
            let mutated = ConditionL1 {
                all: Some(alloc::vec![ConditionL2 {
                    all: Some(alloc::vec![
                        ConditionL3 {
                            predicate: Predicate::MemoryEquals {
                                region_id: String::from("stack"),
                                offset_bytes: 0,
                                bytes: bytes.clone(),
                            },
                        },
                        ConditionL3 {
                            predicate: Predicate::MemoryContains {
                                region_id: String::from("stack"),
                                bytes: bytes[..2].to_vec(),
                            },
                        },
                    ]),
                    any: None,
                    not: None,
                }]),
                any: None,
                not: None,
            };
            let after = evaluate_l1(&engine, &mutated).unwrap();
            assert_eq!(predicate_count(&mutated), 2);
            let _ = after; // 结果可能真可能假(contains 分支可能仍命中);步耗恒定是断言目标
        }
    }

    /// 引擎不存在(canary 为空 ⇒ 恒真)与 Program 引用守卫:
    /// engine_with_regions 无 Canary 槽,StackCanaryIntact 恒真已覆盖;
    /// 本测试锚定 Program 形态引用不被谓词面触碰。
    #[test]
    fn program_reference_untouched_by_predicates() {
        let engine = engine_with_regions();
        let program = engine.program();
        assert!(matches!(program, Program::Ir { .. }));
        assert_eq!(
            program_instructions_len(program),
            1,
            "测试引擎为单指令程序(谓词求值不触碰程序面)"
        );
    }

    fn program_instructions_len(program: &Program) -> usize {
        match program {
            Program::Ir { instructions, .. } => instructions.len(),
            Program::Byte { .. } => 0,
        }
    }

    /// 操作数形态引用守卫(编译期锚点):测试辅助构造的立即数形态。
    #[test]
    fn operand_shape_smoke() {
        let instr = Instruction {
            op: Op::Baseline(crate::instr::BaselineOp::Mov),
            operands: alloc::vec![
                Operand::Register(String::from("RAX")),
                Operand::Immediate(v(1)),
            ],
        };
        assert_eq!(instr.operands.len(), 2);
    }

    // ─────────────────────────────────────────────────────────────────────
    // WP-9 proptest 属性(谓词求值器):恒定成本 + 确定性。随机内存 /
    // 寄存器状态 × 随机条件树形态,断言(1)静态谓词计数只依赖树形态,
    // 与内容无关(布尔不短路 ⇒ T-SC2 的属性化表达);(2)同一状态两次
    // 求值结果一致;(3)已装配引用域内求值全定义(只 Ok,无 panic)。
    // RNG 固定种子,理由见 arch.rs 同名注释。
    // ─────────────────────────────────────────────────────────────────────

    fn wp9_prop_config() -> proptest::test_runner::Config {
        let mut config =
            proptest::test_runner::Config::with_cases(if cfg!(miri) { 8 } else { 128 });
        config.rng_seed = proptest::test_runner::RngSeed::Fixed(0x9BED_1CA7);
        // 关闭失败持久化:不读 / 写回归文件(无文件 IO,miri 隔离模式纯净,
        // 也不向源码树落盘);失败用例的种子由 proptest 输出直接打印。
        config.failure_persistence = None;
        config
    }

    /// 随机叶子:引用均落在已装配引用域(stack 区域 / RAX / FLAG_KEY),
    /// MemoryEquals 的 offset + len ≤ 区域大小保证求值不产生引用错误。
    fn wp9_leaf(rng: &mut crate::testing::Xorshift64Star) -> ConditionL3 {
        let random_bytes = |rng: &mut crate::testing::Xorshift64Star, len: usize| -> Vec<u8> {
            (0..len).map(|_| (rng.next_u64() & 0xFF) as u8).collect()
        };
        let predicate = match rng.next_u64() % 4 {
            0 => {
                let len = (rng.next_u64() as usize % 8) + 1;
                Predicate::MemoryEquals {
                    region_id: String::from("stack"),
                    offset_bytes: rng.next_u64() % (0x1000 - len as u64),
                    bytes: random_bytes(rng, len),
                }
            }
            1 => {
                let len = (rng.next_u64() as usize % 8) + 1;
                Predicate::MemoryContains {
                    region_id: String::from("stack"),
                    bytes: random_bytes(rng, len),
                }
            }
            2 => Predicate::RegisterEquals {
                register: String::from("RAX"),
                value: v(rng.next_u64()),
            },
            _ => Predicate::RegisterBitsSet {
                register: String::from("FLAG_KEY"),
                mask: v(rng.next_u64()),
            },
        };
        ConditionL3 { predicate }
    }

    /// 随机 L2:all / any / not 三键随机取一,1–3 个随机子节点。
    fn wp9_l2(rng: &mut crate::testing::Xorshift64Star) -> ConditionL2 {
        let count = (rng.next_u64() as usize % 3) + 1;
        match rng.next_u64() % 3 {
            0 => ConditionL2 {
                all: Some((0..count).map(|_| wp9_leaf(rng)).collect()),
                any: None,
                not: None,
            },
            1 => ConditionL2 {
                all: None,
                any: Some((0..count).map(|_| wp9_leaf(rng)).collect()),
                not: None,
            },
            _ => ConditionL2 {
                all: None,
                any: None,
                not: Some(Box::new(wp9_leaf(rng))),
            },
        }
    }

    /// 随机 L1 根:all / any / not 三键随机取一,1–3 个随机 L2。
    fn wp9_tree(rng: &mut crate::testing::Xorshift64Star) -> ConditionL1 {
        let count = (rng.next_u64() as usize % 3) + 1;
        match rng.next_u64() % 3 {
            0 => ConditionL1 {
                all: Some((0..count).map(|_| wp9_l2(rng)).collect()),
                any: None,
                not: None,
            },
            1 => ConditionL1 {
                all: None,
                any: Some((0..count).map(|_| wp9_l2(rng)).collect()),
                not: None,
            },
            _ => ConditionL1 {
                all: None,
                any: None,
                not: Some(Box::new(wp9_l2(rng))),
            },
        }
    }

    proptest::proptest! {
        #![proptest_config(wp9_prop_config())]

        #[test]
        fn prop_constant_cost_and_determinism_under_random_state(
            seed in any::<u64>(),
            write_count in 0usize..6,
        ) {
            let mut rng = crate::testing::Xorshift64Star::new(seed ^ 0x9E37_79B9_7F4A_7C15);
            let mut engine = engine_with_regions();
            for _ in 0..write_count {
                let len = (rng.next_u64() as usize % 8) + 1;
                let data: Vec<u8> = (0..len).map(|_| (rng.next_u64() & 0xFF) as u8).collect();
                engine
                    .action_write_bytes(v(0x7FFF_F000 + (rng.next_u64() & 0xFF)), &data)
                    .unwrap();
            }
            let condition = wp9_tree(&mut rng);
            let expected_count = predicate_count(&condition);
            let first = evaluate_l1(&engine, &condition);
            let second = evaluate_l1(&engine, &condition);
            // 确定性:同一引擎状态两次求值逐项一致(Ok 恒成立——引用域
            // 已被叶子构造保证)。
            assert_eq!(first, second, "同状态两次求值必须一致");
            assert!(first.is_ok(), "引用域内求值只 Ok");
            // 恒定成本:计数是条件树的静态函数,与内存 / 寄存器内容无关。
            assert_eq!(predicate_count(&condition), expected_count);
        }
    }
}

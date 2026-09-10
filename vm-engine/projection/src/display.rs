//! 调试通道展示数据生成(阶段四 WP-41;ADR-DC1 条款 8、D5 边界)。
//!
//! 伪指令流与函数表是服务端生成的**展示数据**:源 = 公开代码区字节(字节
//! 模式逐 token 译码)或已装载程序结构(IR 模式按索引直取),与执行共用同
//! 一层 1 表示的译码语义——但本模块产出的是展示文本与字节回显,**引擎可执
//! 行 IR 本体不出进程**(D5 边界在调试通道同样适用)。
//!
//! 调试通道的"全可见"以零装载在构造上保证(变体镜像无秘密),本模块不做
//! 任何白名单过滤;确定性纯函数(同输入恒同输出,I-4)。

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec;
use alloc::vec::Vec;

use vm_core::arch::ArchBits;
use vm_core::decode::{EncodingIndex, decode_slice};
use vm_core::instr::{CustomInstructionDef, Op, Operand, Program};
use vm_core::memory::VirtualMemory;

use crate::project::{UNDECODABLE_TEXT, render_instruction};

/// 伪指令流单条展示条目(调试通道 `debug_instruction_stream` 的载荷原子)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DebugInstructionEntry {
    /// 指令起始地址(字节模式 = 代码区字节地址;IR 模式 = 指令索引)。
    pub address: u64,
    /// 该地址处的公开代码区字节(恰为该指令的编码字节;IR 模式为空)。
    pub bytes: Vec<u8>,
    /// 伪汇编展示文本(非可执行 IR,D5)。
    pub text: String,
    /// 跳转目标(仅控制转移条目携带立即数目标时出现;pwndbg 式跳转链)。
    pub jump_target: Option<u64>,
}

/// 函数表单条(调试通道 `debug_function_table` 的载荷原子):label / 起址 /
/// 字节长度三字段,与冻结契约同构。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DebugFunctionEntry {
    /// 函数标签(字节模式线性扫描派生:`sub_<hex>` 确定性形态)。
    pub label: String,
    /// 函数起始地址。
    pub start_address: u64,
    /// 字节长度(至下一函数起点或代码区末尾)。
    pub byte_length: u64,
}

/// 取指窗口余量:单指令 ≤ 1 token + 操作数内联字节;与 D5 展示译码同宽。
const FETCH_WINDOW_BYTES: usize = 65;

/// 单条译码结果(字节模式):指令 + 编码字节 + 消耗长度。
fn decode_at(
    index: &EncodingIndex,
    arch: ArchBits,
    memory: &VirtualMemory,
    address: u64,
) -> Option<(vm_core::instr::Instruction, Vec<u8>)> {
    let window = memory
        .read(
            vm_core::arch::ArchValue::new(address, arch),
            FETCH_WINDOW_BYTES,
        )
        .ok()?;
    let (instruction, consumed) = decode_slice(index, arch, &window, 0).ok()?;
    Some((instruction, window[..consumed].to_vec()))
}

/// 控制转移指令的立即数跳转目标(仅立即数操作数形态;间接 / 寄存器目标
/// 为运行时值,展示层不预测)。
fn immediate_jump_target(instruction: &vm_core::instr::Instruction) -> Option<u64> {
    let is_control_transfer = matches!(
        instruction.op,
        Op::Baseline(
            vm_core::instr::BaselineOp::Jmp
                | vm_core::instr::BaselineOp::Je
                | vm_core::instr::BaselineOp::Jne
                | vm_core::instr::BaselineOp::Jb
                | vm_core::instr::BaselineOp::Jae
                | vm_core::instr::BaselineOp::Call
        )
    );
    if !is_control_transfer {
        return None;
    }
    instruction.operands.iter().find_map(|operand| match operand {
        Operand::Immediate(value) => Some(value.get()),
        _ => None,
    })
}

/// 伪指令流批量生成(调试通道;ADR-DC1 条款 8)。
///
/// 从 `start` 起顺序译码至 `max_items` 条或程序源耗尽;返回 `(条目,
/// truncated)`,`truncated = true` 表示源中仍有未携带的后续指令
/// (presence-only 截断标记,不含省略条目数)。译码失败(未知 token /
/// 截断 / 未映射)以统一占位文本条目呈现并终止(地址照显,D5 同纪律)。
pub fn render_instruction_stream(
    program: &Program,
    customs: &BTreeMap<String, CustomInstructionDef>,
    memory: &VirtualMemory,
    start: u64,
    max_items: usize,
) -> (Vec<DebugInstructionEntry>, bool) {
    let arch = memory.arch();
    let mut entries = Vec::new();
    match program {
        Program::Ir { instructions, .. } => {
            // IR 模式:地址 = 指令索引;字节回显不适用(空)。
            let mut index = start;
            for _ in 0..max_items {
                match instructions.get(index as usize) {
                    Some(instruction) => {
                        entries.push(DebugInstructionEntry {
                            address: index,
                            bytes: Vec::new(),
                            text: render_instruction(instruction, customs, arch),
                            jump_target: None,
                        });
                        index += 1;
                    }
                    None => return (entries, false),
                }
            }
            (entries, (index as usize) < instructions.len())
        }
        Program::Byte { table, .. } => {
            let index = EncodingIndex::new(table);
            let mut address = start;
            for _ in 0..max_items {
                match decode_at(&index, arch, memory, address) {
                    Some((instruction, bytes)) => {
                        let jump_target = immediate_jump_target(&instruction);
                        let text = render_instruction(&instruction, customs, arch);
                        let consumed = bytes.len().max(1) as u64;
                        entries.push(DebugInstructionEntry {
                            address,
                            bytes,
                            text,
                            jump_target,
                        });
                        address += consumed;
                    }
                    None => {
                        entries.push(DebugInstructionEntry {
                            address,
                            bytes: Vec::new(),
                            text: String::from(UNDECODABLE_TEXT),
                            jump_target: None,
                        });
                        return (entries, false);
                    }
                }
            }
            // 截断观察:再译码一条,成功即源中仍有后续指令。
            let truncated = decode_at(&index, arch, memory, address).is_some();
            (entries, truncated)
        }
    }
}

/// 函数表派生(调试通道;源 = 已装载程序结构 + 公开代码区)。
///
/// 字节模式:对入口所在代码区做一次线性扫描,收集 `call` 立即数目标与程序
/// 入口为函数起点(确定性派生,`sub_<hex>` 标签);IR 模式:无符号面来源,
/// 返回空表(调用方以 presence-only 语义呈现)。返回 `(条目, truncated)`。
pub fn derive_function_table(
    program: &Program,
    memory: &VirtualMemory,
    max_entries: usize,
) -> (Vec<DebugFunctionEntry>, bool) {
    let Program::Byte {
        table,
        entrypoint_address,
    } = program
    else {
        return (Vec::new(), false);
    };
    let arch = memory.arch();
    let entrypoint = entrypoint_address.get();
    let Some(region) = memory.region_at(entrypoint) else {
        return (Vec::new(), false);
    };
    let region_start = region.start;
    let region_end = region_start + region.byte_length;
    let index = EncodingIndex::new(table);
    let mut starts = vec![entrypoint];
    let mut address = region_start;
    // 线性扫描:逐 token 译码,遇 call 立即数目标(落在代码区内)登记起点;
    // 译码失败(数据面 / pad 边界)即终止——派生面确定性与扫描起点无关。
    while address < region_end {
        let Some((instruction, bytes)) = decode_at(&index, arch, memory, address) else {
            break;
        };
        if instruction.op == Op::Baseline(vm_core::instr::BaselineOp::Call)
            && let Some(target) = immediate_jump_target(&instruction)
            && target >= region_start
            && target < region_end
            && !starts.contains(&target)
        {
            starts.push(target);
        }
        address += bytes.len().max(1) as u64;
    }
    starts.sort_unstable();
    starts.dedup();
    let total = starts.len();
    let mut functions = Vec::new();
    for (position, start) in starts.iter().enumerate().take(max_entries) {
        let end = starts.get(position + 1).copied().unwrap_or(region_end);
        functions.push(DebugFunctionEntry {
            label: alloc::format!("sub_{:x}", start),
            start_address: *start,
            byte_length: end.saturating_sub(*start).max(1),
        });
    }
    (functions, total > max_entries)
}

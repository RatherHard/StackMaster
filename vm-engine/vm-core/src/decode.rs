//! 字节模式取指译码:纯函数层(WP-4;最小DSL范围 §三.4、D4.4 / D4.6 / D4.7)。
//!
//! # 译码模型(D4.4)
//!
//! 译码是**纯函数** `(编码表, 代码字节, 地址) → 指令`:无时钟、无随机、无 IO,
//! 确定性纪律(6.3)天然满足。表层机器码是唯一权威执行空间:地址 = 代码区内
//! 字节偏移,不维护第二套指令索引;取指可从**任意**字节地址开始(指令中间
//! gadget 是合法执行路径,ROP 教学底座)。
//!
//! 编码形态(D4.7):token 定宽 1 字节;寄存器 / 接口号**烘焙**进 token;
//! 立即数 / 位移**内联**在指令字节流中,定宽 `archBits/8` 字节小端——
//! 任意位型都在掩蔽域内(`XS-ARCH-WIDTH` 在译码中结构性不触发,D4.6),
//! 有符号位移以二进制补码形态承载。
//!
//! # 缓存立场(D4.4)
//!
//! 取指译码缓存是**性能优化不是状态**:W^X(D4.5)保证字节模式代码区内容在
//! 会话内不变,缓存永不失效;缓存不进入 COW 快照,可按代码区内容随时重建
//! (见 [`crate::exec::Engine`] 的 `decode_cache`,键 = 指令首地址)。
//!
//! # 失败方向
//!
//! 未知 token / 操作数字节截断 → [`DecodeError`];引擎内由取指方
//! ([`crate::exec`])按 `invalid_rip` 方向兜底(与 `ret` 弹出不可执行值同规则,
//! 最小DSL范围 §三.4.4 第 4 条)。

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use crate::arch::{ArchBits, ArchValue};
use crate::instr::{EncodingOperandShape, EncodingTableEntry, Instruction, Operand};

/// 译码失败(运行时方向 = `invalid_rip`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    /// token 不在编码表。
    UnknownToken {
        /// 未知 token 字节。
        token: u8,
        /// 取指地址。
        address: u64,
    },
    /// 指令在可用字节内被截断(内联操作数不完整)。
    Truncated {
        /// 取指地址。
        address: u64,
        /// 需要的总字节数。
        needed: usize,
        /// 实际可用字节数。
        available: usize,
    },
}

/// 编码表索引(token → 条目;装载期一次构建,查询 O(log n),确定性序)。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EncodingIndex {
    by_token: BTreeMap<u8, EncodingTableEntry>,
}

impl EncodingIndex {
    /// 构建(表应为已通过装载校验的唯一 token 集;重复 token 时后者覆盖,
    /// 校验层 [`crate::instr::validate_program`] 已拒绝,此处防御性保留末条)。
    pub fn new(table: &[EncodingTableEntry]) -> Self {
        Self {
            by_token: table.iter().cloned().map(|e| (e.token, e)).collect(),
        }
    }

    /// 按 token 查条目。
    pub fn get(&self, token: u8) -> Option<&EncodingTableEntry> {
        self.by_token.get(&token)
    }

    /// 条目数。
    pub fn len(&self) -> usize {
        self.by_token.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.by_token.is_empty()
    }
}

/// 译码单条指令的核心:表项 + token 之后的内联操作数字节 → 层 1 指令。
///
/// 纯函数;`operand_bytes` 为 token 之后的字节(调用方保证长度,不足即
/// [`DecodeError::Truncated`])。立即数 / 位移各消费 `archBits/8` 字节小端,
/// 任意位型直接落入掩蔽域(值型检查不在译码层,归装载探测与运行时派发)。
pub fn decode_entry(
    entry: &EncodingTableEntry,
    arch: ArchBits,
    address: u64,
    operand_bytes: &[u8],
) -> Result<Instruction, DecodeError> {
    let width = arch.bits() as usize / 8;
    let total = entry.total_bytes(arch);
    // 截断统一前置判定(token 1 字节 + 内联操作数必须整体可用)。
    if operand_bytes.len() < entry.inline_bytes(arch) {
        return Err(DecodeError::Truncated {
            address,
            needed: total,
            available: operand_bytes.len() + 1,
        });
    }
    let mut cursor = 0usize;
    let mut operands = Vec::with_capacity(entry.operand_shapes.len());
    for shape in &entry.operand_shapes {
        match shape {
            EncodingOperandShape::Register(name) => {
                operands.push(Operand::Register(name.clone()));
            }
            EncodingOperandShape::ImmediateArch => {
                let raw = read_le(operand_bytes, &mut cursor, width);
                operands.push(Operand::Immediate(ArchValue::new(raw, arch)));
            }
            EncodingOperandShape::Memory { base } => {
                let raw = read_le(operand_bytes, &mut cursor, width);
                operands.push(Operand::Memory {
                    base: Some(base.clone()),
                    // 有符号位移以补码形态承载于掩蔽域容器;EA 计算按模加完成。
                    displacement: ArchValue::new(raw, arch),
                });
            }
            EncodingOperandShape::Interface(interface_id) => {
                operands.push(Operand::Interface(*interface_id));
            }
        }
    }
    Ok(Instruction {
        op: entry.op.clone(),
        operands,
    })
}

/// 切片视角的完整取指译码:自 `at` 偏移取 token → 查表 → 连同内联操作数
/// 译码为层 1 指令,返回 `(指令, 下一条指令偏移)`。
///
/// 供测试与探测译码(XS-ENC-PROBE 同构)复用;引擎内以内存取指为字节源
/// (见 `crate::exec::Engine::fetch_decode`)。
pub fn decode_slice(
    index: &EncodingIndex,
    arch: ArchBits,
    code: &[u8],
    at: usize,
) -> Result<(Instruction, usize), DecodeError> {
    if at >= code.len() {
        return Err(DecodeError::Truncated {
            address: at as u64,
            needed: 1,
            available: code.len().saturating_sub(at),
        });
    }
    let token = code[at];
    let entry = index.get(token).ok_or(DecodeError::UnknownToken {
        token,
        address: at as u64,
    })?;
    let total = entry.total_bytes(arch);
    if at + total > code.len() {
        return Err(DecodeError::Truncated {
            address: at as u64,
            needed: total,
            available: code.len() - at,
        });
    }
    let instruction = decode_entry(entry, arch, at as u64, &code[at + 1..at + total])?;
    Ok((instruction, at + total))
}

fn read_le(bytes: &[u8], cursor: &mut usize, width: usize) -> u64 {
    let mut buf = [0u8; 8];
    buf[..width].copy_from_slice(&bytes[*cursor..*cursor + width]);
    *cursor += width;
    u64::from_le_bytes(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instr::{BaselineOp, EncodingOperandShape, EncodingTableEntry, Op};
    use alloc::string::String;
    use alloc::vec;
    use proptest::prelude::*;

    const A32: ArchBits = ArchBits::B32;
    const A64: ArchBits = ArchBits::B64;

    fn entry(token: u8, op: Op, shapes: Vec<EncodingOperandShape>) -> EncodingTableEntry {
        EncodingTableEntry {
            token,
            op,
            operand_shapes: shapes,
        }
    }

    fn table() -> Vec<EncodingTableEntry> {
        vec![
            entry(
                0x50,
                Op::Baseline(BaselineOp::Push),
                vec![EncodingOperandShape::Register(String::from("RAX"))],
            ),
            entry(
                0x68,
                Op::Baseline(BaselineOp::Push),
                vec![EncodingOperandShape::ImmediateArch],
            ),
            entry(
                0x8B,
                Op::Baseline(BaselineOp::Mov),
                vec![
                    EncodingOperandShape::Register(String::from("RAX")),
                    EncodingOperandShape::Memory {
                        base: String::from("RBP"),
                    },
                ],
            ),
            entry(0xC3, Op::Baseline(BaselineOp::Ret), vec![]),
            entry(
                0xE8,
                Op::Baseline(BaselineOp::Call),
                vec![EncodingOperandShape::ImmediateArch],
            ),
            entry(0x9C, Op::Custom(String::from("MYNOP")), vec![]),
        ]
    }

    // ─────────────────────────────────────────────────────────────────────
    // 纯函数性:同输入恒同输出(属性循环)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn decode_is_pure_function_of_table_bytes_address() {
        let index = EncodingIndex::new(&table());
        let mut code = vec![0xE8u8];
        code.extend_from_slice(&0x0040_0100u32.to_le_bytes()); // call 0x400100
        code.push(0x50); // push RAX
        for _ in 0..100 {
            let (a, next_a) = decode_slice(&index, A32, &code, 0).unwrap();
            let (b, next_b) = decode_slice(&index, A32, &code, 0).unwrap();
            assert_eq!(a, b);
            assert_eq!(next_a, next_b);
            assert_eq!(next_a, 5);
            assert_eq!(
                a,
                Instruction {
                    op: Op::Baseline(BaselineOp::Call),
                    operands: vec![Operand::Immediate(ArchValue::new(0x0040_0100, A32))],
                }
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 内联操作数形态(D4.7:寄存器 / 接口烘焙,立即数 / 位移内联小端)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn baked_register_and_interface_decode_without_inline() {
        let index = EncodingIndex::new(&table());
        let code = [0x50u8];
        let (instr, next) = decode_slice(&index, A32, &code, 0).unwrap();
        assert_eq!(next, 1);
        assert_eq!(
            instr,
            Instruction {
                op: Op::Baseline(BaselineOp::Push),
                operands: vec![Operand::Register(String::from("RAX"))],
            }
        );
        // 自定义助记符零内联。
        let (instr, next) = decode_slice(&index, A32, &[0x9C], 0).unwrap();
        assert_eq!(next, 1);
        assert_eq!(instr.op, Op::Custom(String::from("MYNOP")));
        assert!(instr.operands.is_empty());
    }

    #[test]
    fn immediate_inline_is_little_endian_arch_width() {
        let index = EncodingIndex::new(&table());
        // 32 位:push imm32 小端 0xDEADBEEF。
        let mut code = vec![0x68u8];
        code.extend_from_slice(&0xDEAD_BEEFu32.to_le_bytes());
        let (instr, next) = decode_slice(&index, A32, &code, 0).unwrap();
        assert_eq!(next, 5);
        assert_eq!(
            instr.operands[0],
            Operand::Immediate(ArchValue::new(0xDEAD_BEEF, A32))
        );
        // 64 位:同 token 宽度 8,高 32 位参与值。
        let mut code64 = vec![0x68u8];
        code64.extend_from_slice(&0x0123_4567_89AB_CDEFu64.to_le_bytes());
        let (instr, next) = decode_slice(&index, A64, &code64, 0).unwrap();
        assert_eq!(next, 9);
        assert_eq!(
            instr.operands[0],
            Operand::Immediate(ArchValue::new(0x0123_4567_89AB_CDEF, A64))
        );
    }

    #[test]
    fn memory_displacement_inline_is_twos_complement() {
        let index = EncodingIndex::new(&table());
        // mov RAX, [RBP − 8]:位移 −8 的补码 0xFFFFFFF8。
        let mut code = vec![0x8Bu8];
        code.extend_from_slice(&0xFFFF_FFF8u32.to_le_bytes());
        let (instr, next) = decode_slice(&index, A32, &code, 0).unwrap();
        assert_eq!(next, 5);
        assert_eq!(
            instr.operands[1],
            Operand::Memory {
                base: Some(String::from("RBP")),
                displacement: ArchValue::new(0xFFFF_FFF8, A32),
            }
        );
        // 掩蔽域容器内的补码:EA 计算按模加(RBP + (−8) ≡ RBP − 8 mod 2^32)。
        let rbp = ArchValue::new(0x7FFF_FFF0, A32);
        let ea = rbp.add(ArchValue::new(0xFFFF_FFF8, A32), A32);
        assert_eq!(ea.get(), 0x7FFF_FFE8);
    }

    #[test]
    fn any_bit_pattern_lands_in_masked_domain() {
        // D4.6:内联宽度恰 archBits/8,任意位型都在掩蔽域内——XS-ARCH-WIDTH
        // 在译码中结构性不触发;64 位全 1、32 位全 1 均直接合法。
        let index = EncodingIndex::new(&table());
        let mut code = vec![0x68u8];
        code.extend_from_slice(&u64::MAX.to_le_bytes());
        let (instr, _) = decode_slice(&index, A64, &code, 0).unwrap();
        assert_eq!(
            instr.operands[0],
            Operand::Immediate(ArchValue::new(u64::MAX, A64))
        );
        let mut code = vec![0x68u8];
        code.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        let (instr, _) = decode_slice(&index, A32, &code, 0).unwrap();
        assert_eq!(
            instr.operands[0],
            Operand::Immediate(ArchValue::new(0xFFFF_FFFF, A32))
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // gadget:任意字节边界取指 + 红灯(未知 token / 截断)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn fetch_from_mid_instruction_boundary_is_legal() {
        // 指令中间 gadget:自另一条指令的内联立即数字节起取指。
        // code = [E8][68 50 34 12][C3]:偏移 2 = 0x50(push RAX 烘焙 token)。
        let index = EncodingIndex::new(&table());
        let mut code = vec![0xE8u8];
        code.extend_from_slice(&0x1234_5068u32.to_le_bytes());
        code.push(0xC3);
        // 偏移 2:合法 gadget 起点得到 push RAX,长度 1。
        let (instr, next) = decode_slice(&index, A32, &code, 2).unwrap();
        assert_eq!(
            instr,
            Instruction {
                op: Op::Baseline(BaselineOp::Push),
                operands: vec![Operand::Register(String::from("RAX"))],
            }
        );
        assert_eq!(next, 3);
        // 偏移 1 = 0x68:push imm32,内联吃 [50 34 12 C3](恰有 4 字节,完整)。
        let (instr, next) = decode_slice(&index, A32, &code, 1).unwrap();
        assert_eq!(
            instr.operands[0],
            Operand::Immediate(ArchValue::new(0xC312_3450, A32))
        );
        assert_eq!(next, 6);
        // 偏移 4 = 0x12:未知 token(运行时 invalid_rip 方向)。
        assert!(matches!(
            decode_slice(&index, A32, &code, 4),
            Err(DecodeError::UnknownToken { token: 0x12, .. })
        ));
    }

    #[test]
    fn unknown_token_and_truncation_red_lights() {
        let index = EncodingIndex::new(&table());
        // 未知 token。
        assert_eq!(
            decode_slice(&index, A32, &[0x00], 0),
            Err(DecodeError::UnknownToken {
                token: 0x00,
                address: 0
            })
        );
        // 越出可用字节(token 都不存在)。
        assert!(matches!(
            decode_slice(&index, A32, &[0xC3], 1),
            Err(DecodeError::Truncated { needed: 1, .. })
        ));
        // 空切片。
        assert!(matches!(
            decode_slice(&index, A32, &[], 0),
            Err(DecodeError::Truncated { .. })
        ));
        // 指令截断:call 只有 2 字节内联。
        let short = [0xE8u8, 0x01, 0x02];
        assert_eq!(
            decode_slice(&index, A32, &short, 0),
            Err(DecodeError::Truncated {
                address: 0,
                needed: 5,
                available: 3,
            })
        );
        // 恰好完整:4 字节内联齐全。
        let mut exact = vec![0xE8u8];
        exact.extend_from_slice(&0u32.to_le_bytes());
        assert!(decode_slice(&index, A32, &exact, 0).is_ok());
    }

    #[test]
    fn encoding_index_lookup() {
        let index = EncodingIndex::new(&table());
        assert_eq!(index.len(), 6);
        assert!(!index.is_empty());
        assert!(index.get(0x50).is_some());
        assert!(index.get(0x00).is_none());
        assert_eq!(
            EncodingIndex::default(),
            EncodingIndex::new(&[]),
            "空表构建与默认同构"
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // WP-9 proptest 属性(译码纯函数):全定义性(任意输入不 panic,失败
    // 只会是 UnknownToken / Truncated)、确定性(同输入两次译码逐项相等)、
    // 有界推进(Ok 时 next 严格前进且不越界)、立即数落掩蔽域(D4.6)。
    // RNG 固定种子,理由见 arch.rs 同名注释。
    // ─────────────────────────────────────────────────────────────────────

    fn wp9_prop_config() -> proptest::test_runner::Config {
        let mut config =
            proptest::test_runner::Config::with_cases(if cfg!(miri) { 8 } else { 128 });
        config.rng_seed = proptest::test_runner::RngSeed::Fixed(0x0DEC_0DE5);
        // 关闭失败持久化:不读 / 写回归文件(无文件 IO,miri 隔离模式纯净,
        // 也不向源码树落盘);失败用例的种子由 proptest 输出直接打印。
        config.failure_persistence = None;
        config
    }

    fn wp9_arch_strategy() -> impl proptest::strategy::Strategy<Value = ArchBits> {
        proptest::prop_oneof![Just(A32), Just(A64)]
    }

    /// 由随机种子确定性导出编码表条目(token 不去重:索引防御性保留末条,
    /// 译码层行为不变)。
    fn wp9_entries(seeds: &[u64]) -> Vec<EncodingTableEntry> {
        const OPS: &[fn() -> Op] = &[
            || Op::Baseline(BaselineOp::Mov),
            || Op::Baseline(BaselineOp::Add),
            || Op::Baseline(BaselineOp::Push),
            || Op::Baseline(BaselineOp::Jmp),
        ];
        const SHAPES: &[fn() -> EncodingOperandShape] = &[
            || EncodingOperandShape::Register(alloc::string::String::from("RAX")),
            || EncodingOperandShape::ImmediateArch,
            || EncodingOperandShape::Memory {
                base: alloc::string::String::from("RSP"),
            },
            || EncodingOperandShape::Interface(0x20),
        ];
        seeds
            .iter()
            .map(|seed| EncodingTableEntry {
                token: *seed as u8,
                op: OPS[(seed >> 8) as usize % OPS.len()](),
                operand_shapes: (0..((seed >> 16) as usize % 3))
                    .map(|i| SHAPES[(seed >> (24 + 4 * i)) as usize % SHAPES.len()]())
                    .collect(),
            })
            .collect()
    }

    proptest::proptest! {
        #![proptest_config(wp9_prop_config())]

        #[test]
        fn prop_decode_slice_total_deterministic_bounded(
            seeds in proptest::collection::vec(any::<u64>(), 0..6),
            code in proptest::collection::vec(any::<u8>(), 0..48),
            at in 0usize..64,
            arch in wp9_arch_strategy(),
        ) {
            let entries = wp9_entries(&seeds);
            let index = EncodingIndex::new(&entries);
            // 纯函数:同一输入两次译码结果逐项相等。
            let first = decode_slice(&index, arch, &code, at);
            assert_eq!(decode_slice(&index, arch, &code, at), first);
            match first {
                Ok((instruction, next)) => {
                    // 有界推进:next 严格前进且不越过可用字节。
                    assert!(next > at, "译码必须推进:{at} → {next}");
                    assert!(next <= code.len(), "next 越界:{next} > {}", code.len());
                    // 任意位型立即数落掩蔽域(D4.6:译码层结构性不越界)。
                    for operand in &instruction.operands {
                        if let Operand::Immediate(value) = operand {
                            assert!(value.get() <= arch.mask());
                        }
                    }
                }
                Err(DecodeError::UnknownToken { .. } | DecodeError::Truncated { .. }) => {}
            }
        }
    }
}

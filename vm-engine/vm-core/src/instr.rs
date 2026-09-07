//! 统一层 1 指令表示与程序装载校验(WP-4;最小DSL范围 §三 / §八)。
//!
//! # 三层指令结构(G5/D6)
//!
//! ```text
//! 层 1  执行语义   20 基线 opcode ∪ 大写自定义助记符(本模块;引擎解释的权威)
//! 层 2  表层机器码  token 字典(公开包 encodingTable;字节模式经 decode.rs 取指译码到层 1)
//! 层 3  汇编显示   displayText / 助记符文本(不参与执行)
//! ```
//!
//! IR 模式(编译产物直读)与字节模式(取指译码)在此汇合为同一 [`Instruction`],
//! 执行语义唯一([`crate::exec`])——"字节模式只是给同一语义层换了取指方式,
//! 不引入第二套指令语义"(最小DSL范围 §一)。
//!
//! # 装载校验(fail-closed,方向 = challenge_invalid)
//!
//! 引擎侧对上游(challenge-compiler 装载管线)已校验的内容做**镜像复验**
//! (引擎进程协议 §5.2 基线 #6:操作数与引用的执行域内权威校验点):
//! 操作数形态冻结表(XC-OPCODE-SHAPE 引擎镜像)、寄存器 / 基址引用可解析
//! (XC-OPERAND-REF)、自定义助记符声明(XS-CUSTOM-REF)、`syscall` 派发号声明
//! (XS-SYSCALL-DECL)、`interface` 引用声明(XS-IFACE-REF)、编码表自检
//! (XS-ENC-TOKEN 引擎镜像:token 唯一、形态匹配、FLAG 不可编码 R11、
//! 空表失败关闭 R13)、入口落可执行代码区(XS-ENC-PROBE)。
//! 上游漏检在装载即拒绝,不进入执行。

use alloc::borrow::Cow;
use alloc::collections::{BTreeMap, BTreeSet};
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

use crate::arch::{ArchBits, ArchValue};
use crate::memory::{RegionKind, VirtualMemory};
use crate::registers::is_flag_name;

/// IR 指令数上限(契约 `MAX_IR_INSTRUCTIONS`;4096)。
pub const MAX_IR_INSTRUCTIONS: usize = 4096;
/// 编码表条目上限(`MAX_ENCODING_TABLE_ENTRIES`;D4.7)。
pub const MAX_ENCODING_TABLE_ENTRIES: usize = 64;
/// 自定义指令声明上限(`MAX_CUSTOM_INSTRUCTIONS`)。
pub const MAX_CUSTOM_INSTRUCTIONS: usize = 16;
/// 作者接口声明上限(`MAX_INTERFACES`)。
pub const MAX_INTERFACES: usize = 16;
/// 单条自定义指令微算子上限(`MAX_MICRO_OPS_PER_INSTRUCTION`)。
pub const MAX_MICRO_OPS: usize = 16;
/// 单接口效果原语上限(`MAX_EFFECTS_PER_INTERFACE`)。
pub const MAX_EFFECTS: usize = 16;
/// 每指令操作数上限(契约 `MAX_OPERANDS_PER_INSTRUCTION`)。
pub const MAX_OPERANDS: usize = 4;
/// `syscall` 保留系统号带上界(含;内置 `exit`)。下界为 0。
pub const SYSCALL_RESERVED_MAX: u64 = 0xFF;
/// 作者接口号下界(含;与保留带结构性不相交,D4.1)。
pub const INTERFACE_ID_MIN: u32 = 0x0100;
/// 作者接口号上界(含)。
pub const INTERFACE_ID_MAX: u32 = 0xFFFF;

/// 基线 opcode(封闭 20 枚举;最小DSL范围 §三.1,G4 v2)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BaselineOp {
    Mov,
    Push,
    Pop,
    Leave,
    Add,
    Sub,
    Cmp,
    And,
    Or,
    Xor,
    Shl,
    Shr,
    Jmp,
    Je,
    Jne,
    Jb,
    Jae,
    Call,
    Ret,
    Syscall,
}

impl BaselineOp {
    /// 全部基线 opcode(冻结序,文档表同序)。
    pub const ALL: [BaselineOp; 20] = [
        BaselineOp::Mov,
        BaselineOp::Push,
        BaselineOp::Pop,
        BaselineOp::Leave,
        BaselineOp::Add,
        BaselineOp::Sub,
        BaselineOp::Cmp,
        BaselineOp::And,
        BaselineOp::Or,
        BaselineOp::Xor,
        BaselineOp::Shl,
        BaselineOp::Shr,
        BaselineOp::Jmp,
        BaselineOp::Je,
        BaselineOp::Jne,
        BaselineOp::Jb,
        BaselineOp::Jae,
        BaselineOp::Call,
        BaselineOp::Ret,
        BaselineOp::Syscall,
    ];

    /// 基线小写 opcode 字符串(契约 `DSL_OPCODES` 同串)。
    pub fn mnemonic(self) -> &'static str {
        match self {
            BaselineOp::Mov => "mov",
            BaselineOp::Push => "push",
            BaselineOp::Pop => "pop",
            BaselineOp::Leave => "leave",
            BaselineOp::Add => "add",
            BaselineOp::Sub => "sub",
            BaselineOp::Cmp => "cmp",
            BaselineOp::And => "and",
            BaselineOp::Or => "or",
            BaselineOp::Xor => "xor",
            BaselineOp::Shl => "shl",
            BaselineOp::Shr => "shr",
            BaselineOp::Jmp => "jmp",
            BaselineOp::Je => "je",
            BaselineOp::Jne => "jne",
            BaselineOp::Jb => "jb",
            BaselineOp::Jae => "jae",
            BaselineOp::Call => "call",
            BaselineOp::Ret => "ret",
            BaselineOp::Syscall => "syscall",
        }
    }

    /// 基线小写 opcode 字符串 → 枚举(大小写敏感;大写输入即自定义助记符域)。
    pub fn parse(s: &str) -> Option<Self> {
        BaselineOp::ALL.into_iter().find(|op| op.mnemonic() == s)
    }
}

/// 层 1 操作数类别(冻结表左列记法;R/I/M/F)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperandClass {
    /// 寄存器(一般命名空间 ∪ FLAG 保留区)。
    Reg,
    /// 立即数(无符号,archBits 位宽域)。
    Imm,
    /// 内存(base 寄存器 + 有符号位移)。
    Mem,
    /// 作者接口结构化引用。
    Iface,
}

impl OperandClass {
    fn label(self) -> &'static str {
        match self {
            OperandClass::Reg => "R",
            OperandClass::Imm => "I",
            OperandClass::Mem => "M",
            OperandClass::Iface => "F",
        }
    }
}

/// 逐 opcode 冻结操作数形态表(最小DSL范围 §三.1;与
/// `packages/challenge-compiler/src/ir/opcode-shapes.ts` 的 `OPCODE_OPERAND_SHAPES`
/// 一一对应,跨语言一致性由形态矩阵测试锁定)。
pub fn opcode_operand_shapes(op: BaselineOp) -> &'static [(&'static [OperandClass], &'static str)] {
    use OperandClass::{Iface, Imm, Mem, Reg};
    match op {
        BaselineOp::Mov => &[
            (&[Reg, Imm], "R,I"),
            (&[Reg, Reg], "R,R"),
            (&[Reg, Mem], "R,M"),
            (&[Mem, Reg], "M,R"),
        ],
        BaselineOp::Push => &[(&[Reg], "R"), (&[Imm], "I")],
        BaselineOp::Pop => &[(&[Reg], "R")],
        BaselineOp::Leave => &[(&[], "")],
        BaselineOp::Add | BaselineOp::Sub | BaselineOp::Cmp => &[
            (&[Reg, Reg], "R,R"),
            (&[Reg, Imm], "R,I"),
            (&[Reg, Mem], "R,M"),
        ],
        BaselineOp::And | BaselineOp::Or | BaselineOp::Xor | BaselineOp::Shl | BaselineOp::Shr => {
            &[(&[Reg, Reg], "R,R"), (&[Reg, Imm], "R,I")]
        }
        BaselineOp::Jmp => &[(&[Imm], "I"), (&[Reg], "R"), (&[Mem], "M")],
        BaselineOp::Je | BaselineOp::Jne | BaselineOp::Jb | BaselineOp::Jae => &[(&[Imm], "I")],
        BaselineOp::Call => &[(&[Imm], "I"), (&[Reg], "R"), (&[Iface], "F")],
        BaselineOp::Ret => &[(&[], "")],
        BaselineOp::Syscall => &[(&[Imm], "I")],
    }
}

/// 层 1 opcode:基线枚举 ∪ 大写自定义助记符(双形态结构性不相交,大小写判别)。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Op {
    /// 基线 opcode。
    Baseline(BaselineOp),
    /// 大写自定义助记符(必须在 `customInstructions[]` 声明)。
    Custom(String),
}

impl Op {
    /// 助记符文本(基线小写 / 自定义原样)。
    pub fn as_str(&self) -> Cow<'_, str> {
        match self {
            Op::Baseline(op) => Cow::Borrowed(op.mnemonic()),
            Op::Custom(name) => Cow::Borrowed(name),
        }
    }
}

/// 层 1 操作数槽(与契约 `IrOperand` 四 kind 同构;编译器内部的 `label` 形态
/// 在编译期已消解为立即数,永不进入引擎)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Operand {
    /// 寄存器。
    Register(String),
    /// 立即数(无符号;跳转 / `call` 的 I 形态在 IR 模式承载指令索引、
    /// 字节模式承载绝对字节地址——由程序形态决定,本类型不区分)。
    Immediate(ArchValue),
    /// 内存(base 寄存器 + 有符号位移;两者均可缺省,缺省即 0)。
    Memory {
        /// 基址寄存器(可缺省)。
        base: Option<String>,
        /// 有符号位移(二进制补码,掩蔽域容器承载)。
        displacement: ArchValue,
    },
    /// 作者接口结构化引用(`call` 第四形态,D4.2)。
    Interface(u32),
}

impl Operand {
    /// 冻结表类别。
    pub fn class(&self) -> OperandClass {
        match self {
            Operand::Register(_) => OperandClass::Reg,
            Operand::Immediate(_) => OperandClass::Imm,
            Operand::Memory { .. } => OperandClass::Mem,
            Operand::Interface(_) => OperandClass::Iface,
        }
    }
}

/// 层 1 指令。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instruction {
    /// opcode。
    pub op: Op,
    /// 操作数(≤ 4;形态由冻结表约束)。
    pub operands: Vec<Operand>,
}

/// 微算子封闭集 v1(最小DSL范围 §三.2;直线语义——封闭集内无控制转移,
/// 恒定步数 = 微算子条数,与操作数值无关,T-SC2 结构性成立)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MicroOp {
    /// 立即数装载。
    LoadImm {
        /// 目标一般寄存器。
        dst: String,
        /// 无符号立即数。
        value: ArchValue,
    },
    /// 寄存器间传送。
    MovReg {
        /// 目标一般寄存器。
        dst: String,
        /// 源一般寄存器。
        src: String,
    },
    /// 基址 + 位移内存读(统一权限检查与 I-9 统一拒绝路径)。
    LoadMem {
        /// 目标一般寄存器。
        dst: String,
        /// 基址寄存器。
        base: String,
        /// 有符号位移。
        displacement: ArchValue,
    },
    /// 基址 + 位移内存写(同上)。
    StoreMem {
        /// 基址寄存器。
        base: String,
        /// 有符号位移。
        displacement: ArchValue,
        /// 源一般寄存器。
        src: String,
    },
    /// 标志置位(FLAG 写入的唯一微算子;I-3 污点检查落点——FLAG 值永不进公开面)。
    SetFlag {
        /// FLAG 保留区寄存器。
        flag_register: String,
        /// 置位值。
        value: ArchValue,
    },
    /// 位掩蔽运算。
    BitMask {
        /// 目标一般寄存器。
        dst: String,
        /// 源一般寄存器。
        src: String,
        /// 掩码。
        mask: ArchValue,
        /// 运算类别。
        logic: BitLogic,
    },
}

/// 位掩蔽运算类别(封闭三枚举)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BitLogic {
    /// 按位与。
    And,
    /// 按位或。
    Or,
    /// 按位异或。
    Xor,
}

/// 作者自定义指令声明(私有包 `customInstructions[]` 条目的引擎形态)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomInstructionDef {
    /// 大写助记符(`^[A-Z][A-Z0-9_]{0,15}$`,与基线小写结构性不相交)。
    pub mnemonic: String,
    /// 展示文本(层 3,不参与执行)。
    pub display_text: String,
    /// 微算子有序组合(1–16,直线)。
    pub semantics: Vec<MicroOp>,
}

/// 效果原语封闭集 v1(最小DSL范围 §三.3)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EffectPrimitive {
    /// 程序终止(等效内置 `exit(0)`)。
    Exit,
    /// 授予虚拟文件 capability(结构化 fileId 引用)。
    GrantVirtualFile {
        /// 虚拟文件标识。
        file_id: String,
    },
    /// 标记虚拟文件已读(衔接谓词 `virtual_file_read`)。
    VirtualFileRead {
        /// 虚拟文件标识。
        file_id: String,
    },
    /// 置 FLAG 汇寄存器(经 I-3 污点检查)。
    SetFlag {
        /// FLAG 保留区寄存器。
        flag_register: String,
        /// 置位值。
        value: ArchValue,
    },
    /// 无操作(占位 / 组合填充)。
    Noop,
}

/// 作者接口声明(私有包 `interfaces[]` 条目的引擎形态)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InterfaceDef {
    /// 整数接口号([0x0100, 0xFFFF],与保留带结构性不相交)。
    pub interface_id: u32,
    /// 展示文本(层 3,不参与执行)。
    pub display_text: String,
    /// 效果原语有序列表(1–16;恒定步数 = 条数)。
    pub effects: Vec<EffectPrimitive>,
}

/// 编码表操作数形态声明(公开包 `vmProfile.encodingTable[].operands`;
/// 寄存器 / 接口号烘焙进 token,立即数 / 位移内联 `archBits/8` 字节小端,D4.7)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodingOperandShape {
    /// 寄存器烘焙(一般命名空间;FLAG 不可编码,R11)。
    Register(String),
    /// 立即数内联(定宽 `archBits/8` 小端;width 恒 "arch",R12)。
    ImmediateArch,
    /// 位移内联(定宽 `archBits/8` 小端、有符号;baseRegister 烘焙)。
    Memory {
        /// 基址寄存器。
        base: String,
    },
    /// 接口号烘焙。
    Interface(u32),
}

impl EncodingOperandShape {
    /// 冻结表类别。
    pub fn class(&self) -> OperandClass {
        match self {
            EncodingOperandShape::Register(_) => OperandClass::Reg,
            EncodingOperandShape::ImmediateArch => OperandClass::Imm,
            EncodingOperandShape::Memory { .. } => OperandClass::Mem,
            EncodingOperandShape::Interface(_) => OperandClass::Iface,
        }
    }
}

/// 编码表条目。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodingTableEntry {
    /// token(定宽 1 字节;表内唯一)。
    pub token: u8,
    /// 层 1 opcode(基线 ∪ 自定义助记符)。
    pub op: Op,
    /// 操作数形态声明(基线无操作数指令省略)。
    pub operand_shapes: Vec<EncodingOperandShape>,
}

impl EncodingTableEntry {
    /// 内联操作数字节数:立即数 / 位移各 `archBits/8`(寄存器 / 接口烘焙不内联)。
    pub fn inline_bytes(&self, arch: ArchBits) -> usize {
        (arch.bits() as usize / 8)
            * self
                .operand_shapes
                .iter()
                .filter(|s| {
                    matches!(
                        s,
                        EncodingOperandShape::ImmediateArch | EncodingOperandShape::Memory { .. }
                    )
                })
                .count()
    }

    /// 指令总长(字节):token 1 字节 + 内联操作数。
    pub fn total_bytes(&self, arch: ArchBits) -> usize {
        1 + self.inline_bytes(arch)
    }
}

/// 程序(双形态恰一,XS-PROG-MODE 由上游裁定;引擎按形态取指)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Program {
    /// IR 模式:编译产物直读;`instructionPointer` = 指令索引,
    /// 跳转 / `call` 立即数与返回地址同为索引。
    Ir {
        /// 指令序列(1..=4096)。
        instructions: Vec<Instruction>,
        /// 入口索引。
        entrypoint_index: u64,
    },
    /// 字节模式:表层机器码为唯一权威执行空间(D4.4);
    /// `instructionPointer` = 代码区字节地址,地址 = 字节偏移。
    Byte {
        /// 编码表(token 字典)。
        table: Vec<EncodingTableEntry>,
        /// 入口字节地址(须落可执行代码区)。
        entrypoint_address: ArchValue,
    },
}

/// 程序与声明面装载错误(方向 = challenge_invalid;公开面粗化归 WP-7)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProgramError {
    /// IR 程序为空。
    EmptyIrProgram,
    /// IR 指令数超 4096。
    TooManyIrInstructions {
        /// 实际数量。
        count: usize,
    },
    /// 入口索引出界。
    EntrypointIndexOutOfRange {
        /// 给定索引。
        index: u64,
        /// 指令数。
        len: usize,
    },
    /// 操作数形态不符合冻结表(XC-OPCODE-SHAPE 引擎镜像)。
    OperandShape {
        /// 位置(IR 指令序或字节 token)。
        site: String,
        /// opcode 文本。
        op: String,
        /// 实际形态串(如 "R,I")。
        got: String,
        /// 合法形态串清单。
        expected: String,
    },
    /// 寄存器 / 基址引用不可解析(XC-OPERAND-REF 引擎镜像)。
    UnknownRegister {
        /// 位置。
        site: String,
        /// 寄存器名。
        name: String,
    },
    /// 自定义助记符未声明(XS-CUSTOM-REF 引擎镜像)。
    UndeclaredMnemonic {
        /// 位置。
        site: String,
        /// 助记符。
        mnemonic: String,
    },
    /// `syscall` 派发号既不在保留带也未声明(XS-SYSCALL-DECL 引擎镜像)。
    UndeclaredSyscallNumber {
        /// 指令序。
        index: u64,
        /// 派发号。
        value: u64,
    },
    /// `interface` 引用未声明(XS-IFACE-REF 引擎镜像)。
    UndeclaredInterface {
        /// 位置。
        site: String,
        /// 接口号。
        interface_id: u32,
    },
    /// 自定义指令数量超 16。
    TooManyCustomInstructions {
        /// 实际数量。
        count: usize,
    },
    /// 接口数量超 16。
    TooManyInterfaces {
        /// 实际数量。
        count: usize,
    },
    /// 微算子条数超 16。
    TooManyMicroOps {
        /// 助记符。
        mnemonic: String,
        /// 实际数量。
        count: usize,
    },
    /// 效果原语条数超 16。
    TooManyEffects {
        /// 接口号。
        interface_id: u32,
        /// 实际数量。
        count: usize,
    },
    /// 自定义助记符形态非法(空 / 非大写模式 / 撞基线小写)。
    InvalidMnemonic(String),
    /// 自定义助记符条目重复。
    DuplicateMnemonic(String),
    /// 接口号出界([0x0100, 0xFFFF] 之外)。
    InterfaceIdOutOfRange {
        /// 接口号。
        interface_id: u32,
    },
    /// 接口号重复。
    DuplicateInterfaceId(u32),
    /// 微算子目标 / 源 / 基址寄存器不可解析。
    MicroOpUnknownRegister {
        /// 助记符。
        mnemonic: String,
        /// 寄存器名。
        name: String,
    },
    /// 微算子数据寄存器落在 FLAG 保留区(契约限一般命名空间)。
    MicroOpFlagOperand {
        /// 助记符。
        mnemonic: String,
        /// 寄存器名。
        name: String,
    },
    /// `set_flag` 目标不是已声明的 FLAG 寄存器。
    SetFlagNotDeclaredFlag {
        /// 位置(助记符或接口号)。
        site: String,
        /// 寄存器名。
        name: String,
    },
    /// 微算子序列为空(契约 1..=16)。
    EmptySemantics {
        /// 助记符。
        mnemonic: String,
    },
    /// 效果序列为空(契约 1..=16)。
    EmptyEffects {
        /// 接口号。
        interface_id: u32,
    },
    /// 编码表为空(空表失败关闭,不回退 IR 模式,R13)。
    EmptyEncodingTable,
    /// 编码表条目超 64(D4.7)。
    TooManyEncodingEntries {
        /// 实际数量。
        count: usize,
    },
    /// token 重复(XS-ENC-TOKEN)。
    DuplicateToken(u8),
    /// 编码表操作数形态不符合冻结表(XS-ENC-TOKEN)。
    EncodingShape {
        /// token。
        token: u8,
        /// opcode 文本。
        op: String,
        /// 实际形态串。
        got: String,
        /// 合法形态串清单。
        expected: String,
    },
    /// 编码表寄存器烘焙不可解析。
    EncodingUnknownRegister {
        /// token。
        token: u8,
        /// 寄存器名。
        name: String,
    },
    /// 编码表寄存器烘焙落在 FLAG 保留区(R11:FLAG 不可编码)。
    EncodingFlagRegister {
        /// token。
        token: u8,
        /// 寄存器名。
        name: String,
    },
    /// 编码表接口号引用未声明。
    EncodingUndeclaredInterface {
        /// token。
        token: u8,
        /// 接口号。
        interface_id: u32,
    },
    /// 字节模式入口未落在可执行代码区(XS-ENC-PROBE)。
    EntrypointNotExecutable {
        /// 入口地址。
        address: u64,
    },
}

/// 装载校验环境(寄存器封闭集与声明面的名称 / 编号集合)。
#[derive(Debug, Clone, Default)]
pub struct ProgramContext {
    /// 全体已装载寄存器名(运行时封闭集,含 FLAG)。
    pub register_names: BTreeSet<String>,
    /// 已声明 FLAG 寄存器名。
    pub flag_names: BTreeSet<String>,
    /// 已声明自定义助记符。
    pub custom_mnemonics: BTreeSet<String>,
    /// 已声明接口号。
    pub interface_ids: BTreeSet<u32>,
}

fn classes_label(classes: &[OperandClass]) -> String {
    classes
        .iter()
        .map(|c| c.label())
        .collect::<Vec<_>>()
        .join(",")
}

fn expected_label(op: BaselineOp) -> String {
    opcode_operand_shapes(op)
        .iter()
        .map(|(_, label)| *label)
        .collect::<Vec<_>>()
        .join(" / ")
}

impl ProgramContext {
    /// 校验单条层 1 指令(形态表 + 引用可解析;`site` 标记诊断位置)。
    pub fn validate_instruction(
        &self,
        instr: &Instruction,
        site: &str,
    ) -> Result<(), ProgramError> {
        let op_text = instr.op.as_str().into_owned();
        match &instr.op {
            Op::Baseline(base) => {
                let classes: Vec<OperandClass> = instr.operands.iter().map(|o| o.class()).collect();
                let shapes = opcode_operand_shapes(*base);
                if instr.operands.len() > MAX_OPERANDS
                    || !shapes.iter().any(|(shape, _)| *shape == classes.as_slice())
                {
                    return Err(ProgramError::OperandShape {
                        site: String::from(site),
                        op: op_text,
                        got: if instr.operands.len() > MAX_OPERANDS {
                            format!("{} 个操作数", instr.operands.len())
                        } else {
                            classes_label(&classes)
                        },
                        expected: expected_label(*base),
                    });
                }
            }
            Op::Custom(mnemonic) => {
                if !self.custom_mnemonics.contains(mnemonic) {
                    return Err(ProgramError::UndeclaredMnemonic {
                        site: String::from(site),
                        mnemonic: mnemonic.clone(),
                    });
                }
                if !instr.operands.is_empty() {
                    return Err(ProgramError::OperandShape {
                        site: String::from(site),
                        op: op_text,
                        got: format!("{} 个操作数", instr.operands.len()),
                        expected: String::from("自定义助记符:零操作数"),
                    });
                }
            }
        }
        for operand in &instr.operands {
            match operand {
                Operand::Register(name) => {
                    if !self.register_names.contains(name) {
                        return Err(ProgramError::UnknownRegister {
                            site: String::from(site),
                            name: name.clone(),
                        });
                    }
                }
                Operand::Memory { base, .. } => {
                    if let Some(name) = base
                        && !self.register_names.contains(name)
                    {
                        return Err(ProgramError::UnknownRegister {
                            site: String::from(site),
                            name: name.clone(),
                        });
                    }
                }
                Operand::Interface(interface_id) => {
                    if !self.interface_ids.contains(interface_id) {
                        return Err(ProgramError::UndeclaredInterface {
                            site: String::from(site),
                            interface_id: *interface_id,
                        });
                    }
                }
                Operand::Immediate(_) => {}
            }
        }
        // syscall 值型:保留带内置或已声明接口(XS-SYSCALL-DECL;IR 模式静态全量,
        // 字节模式探测外路径由运行时 invalid_action 兜底)。
        if instr.op == Op::Baseline(BaselineOp::Syscall)
            && let Some(Operand::Immediate(value)) = instr.operands.first()
        {
            let id = value.get();
            if id > SYSCALL_RESERVED_MAX
                && u32::try_from(id).map_or(true, |id32| !self.interface_ids.contains(&id32))
            {
                return Err(ProgramError::UndeclaredSyscallNumber {
                    index: 0,
                    value: id,
                });
            }
        }
        Ok(())
    }
}

/// 校验自定义指令声明面(上限 / 助记符形态 / 微算子引用)。
pub fn validate_custom_instructions(
    defs: &[CustomInstructionDef],
    context: &mut ProgramContext,
) -> Result<BTreeMap<String, CustomInstructionDef>, ProgramError> {
    if defs.len() > MAX_CUSTOM_INSTRUCTIONS {
        return Err(ProgramError::TooManyCustomInstructions { count: defs.len() });
    }
    let mut map = BTreeMap::new();
    for def in defs {
        if def.mnemonic.is_empty()
            || BaselineOp::parse(&def.mnemonic).is_some()
            || !is_custom_mnemonic_shape(&def.mnemonic)
        {
            return Err(ProgramError::InvalidMnemonic(def.mnemonic.clone()));
        }
        if map.contains_key(&def.mnemonic) {
            return Err(ProgramError::DuplicateMnemonic(def.mnemonic.clone()));
        }
        if def.semantics.is_empty() {
            return Err(ProgramError::EmptySemantics {
                mnemonic: def.mnemonic.clone(),
            });
        }
        if def.semantics.len() > MAX_MICRO_OPS {
            return Err(ProgramError::TooManyMicroOps {
                mnemonic: def.mnemonic.clone(),
                count: def.semantics.len(),
            });
        }
        for micro in &def.semantics {
            validate_micro_op(micro, &def.mnemonic, context)?;
        }
        map.insert(def.mnemonic.clone(), def.clone());
    }
    for def in map.values() {
        context.custom_mnemonics.insert(def.mnemonic.clone());
    }
    Ok(map)
}

/// 大写自定义助记符形态(`^[A-Z][A-Z0-9_]{0,15}$`)。
pub fn is_custom_mnemonic_shape(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 16
        && bytes[0].is_ascii_uppercase()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
}

fn validate_micro_op(
    micro: &MicroOp,
    mnemonic: &str,
    context: &ProgramContext,
) -> Result<(), ProgramError> {
    /// 数据寄存器必须可解析且落一般命名空间(FLAG 只可作 set_flag 目标)。
    fn data_reg(name: &str, mnemonic: &str, context: &ProgramContext) -> Result<(), ProgramError> {
        if !context.register_names.contains(name) {
            return Err(ProgramError::MicroOpUnknownRegister {
                mnemonic: String::from(mnemonic),
                name: String::from(name),
            });
        }
        if is_flag_name(name) {
            return Err(ProgramError::MicroOpFlagOperand {
                mnemonic: String::from(mnemonic),
                name: String::from(name),
            });
        }
        Ok(())
    }
    match micro {
        MicroOp::LoadImm { dst, .. } => data_reg(dst, mnemonic, context),
        MicroOp::MovReg { dst, src } => {
            data_reg(dst, mnemonic, context)?;
            data_reg(src, mnemonic, context)
        }
        MicroOp::LoadMem { dst, base, .. } => {
            data_reg(dst, mnemonic, context)?;
            data_reg(base, mnemonic, context)
        }
        MicroOp::StoreMem { base, src, .. } => {
            data_reg(base, mnemonic, context)?;
            data_reg(src, mnemonic, context)
        }
        MicroOp::SetFlag { flag_register, .. } => {
            if !context.flag_names.contains(flag_register) {
                return Err(ProgramError::SetFlagNotDeclaredFlag {
                    site: String::from(mnemonic),
                    name: flag_register.clone(),
                });
            }
            Ok(())
        }
        MicroOp::BitMask { dst, src, .. } => {
            data_reg(dst, mnemonic, context)?;
            data_reg(src, mnemonic, context)
        }
    }
}

/// 校验接口声明面(上限 / 号域 / 唯一 / 效果引用)。
pub fn validate_interfaces(
    defs: &[InterfaceDef],
    context: &mut ProgramContext,
) -> Result<BTreeMap<u32, InterfaceDef>, ProgramError> {
    if defs.len() > MAX_INTERFACES {
        return Err(ProgramError::TooManyInterfaces { count: defs.len() });
    }
    let mut map = BTreeMap::new();
    for def in defs {
        if !(INTERFACE_ID_MIN..=INTERFACE_ID_MAX).contains(&def.interface_id) {
            return Err(ProgramError::InterfaceIdOutOfRange {
                interface_id: def.interface_id,
            });
        }
        if map.contains_key(&def.interface_id) {
            return Err(ProgramError::DuplicateInterfaceId(def.interface_id));
        }
        if def.effects.is_empty() {
            return Err(ProgramError::EmptyEffects {
                interface_id: def.interface_id,
            });
        }
        if def.effects.len() > MAX_EFFECTS {
            return Err(ProgramError::TooManyEffects {
                interface_id: def.interface_id,
                count: def.effects.len(),
            });
        }
        for effect in &def.effects {
            if let EffectPrimitive::SetFlag { flag_register, .. } = effect
                && !context.flag_names.contains(flag_register)
            {
                return Err(ProgramError::SetFlagNotDeclaredFlag {
                    site: format!("iface 0x{:X}", def.interface_id),
                    name: flag_register.clone(),
                });
            }
        }
        map.insert(def.interface_id, def.clone());
    }
    for id in map.keys() {
        context.interface_ids.insert(*id);
    }
    Ok(map)
}

/// 校验程序整体(IR:逐条 + 入口;字节:编码表自检 + 入口落可执行代码区)。
pub fn validate_program(
    program: &Program,
    memory: &VirtualMemory,
    context: &ProgramContext,
) -> Result<(), ProgramError> {
    match program {
        Program::Ir {
            instructions,
            entrypoint_index,
        } => {
            if instructions.is_empty() {
                return Err(ProgramError::EmptyIrProgram);
            }
            if instructions.len() > MAX_IR_INSTRUCTIONS {
                return Err(ProgramError::TooManyIrInstructions {
                    count: instructions.len(),
                });
            }
            if *entrypoint_index >= instructions.len() as u64 {
                return Err(ProgramError::EntrypointIndexOutOfRange {
                    index: *entrypoint_index,
                    len: instructions.len(),
                });
            }
            for (index, instr) in instructions.iter().enumerate() {
                context.validate_instruction(instr, &format!("ir[{index}]"))?;
            }
        }
        Program::Byte {
            table,
            entrypoint_address,
        } => {
            if table.is_empty() {
                return Err(ProgramError::EmptyEncodingTable);
            }
            if table.len() > MAX_ENCODING_TABLE_ENTRIES {
                return Err(ProgramError::TooManyEncodingEntries { count: table.len() });
            }
            let mut seen_tokens = [false; 256];
            for entry in table {
                if seen_tokens[usize::from(entry.token)] {
                    return Err(ProgramError::DuplicateToken(entry.token));
                }
                seen_tokens[usize::from(entry.token)] = true;
                validate_encoding_entry(entry, context)?;
            }
            // 入口:落在代码区(允许非首字节——gadget 场景)且可执行。
            let addr = entrypoint_address.get();
            match memory.region_at(addr) {
                Some(region)
                    if region.kind == RegionKind::Code && region.permissions.can_exec() => {}
                _ => return Err(ProgramError::EntrypointNotExecutable { address: addr }),
            }
        }
    }
    Ok(())
}

fn validate_encoding_entry(
    entry: &EncodingTableEntry,
    context: &ProgramContext,
) -> Result<(), ProgramError> {
    let token = entry.token;
    let op_text = entry.op.as_str().into_owned();
    match &entry.op {
        Op::Baseline(base) => {
            let classes: Vec<OperandClass> =
                entry.operand_shapes.iter().map(|s| s.class()).collect();
            let shapes = opcode_operand_shapes(*base);
            if entry.operand_shapes.len() > MAX_OPERANDS
                || !shapes.iter().any(|(shape, _)| *shape == classes.as_slice())
            {
                return Err(ProgramError::EncodingShape {
                    token,
                    op: op_text,
                    got: if entry.operand_shapes.len() > MAX_OPERANDS {
                        format!("{} 个操作数", entry.operand_shapes.len())
                    } else {
                        classes_label(&classes)
                    },
                    expected: expected_label(*base),
                });
            }
        }
        Op::Custom(mnemonic) => {
            if !context.custom_mnemonics.contains(mnemonic) {
                return Err(ProgramError::UndeclaredMnemonic {
                    site: format!("token 0x{token:02X}"),
                    mnemonic: mnemonic.clone(),
                });
            }
            if !entry.operand_shapes.is_empty() {
                return Err(ProgramError::EncodingShape {
                    token,
                    op: op_text,
                    got: format!("{} 个操作数", entry.operand_shapes.len()),
                    expected: String::from("自定义助记符:零操作数"),
                });
            }
        }
    }
    for shape in &entry.operand_shapes {
        match shape {
            EncodingOperandShape::Register(name) | EncodingOperandShape::Memory { base: name } => {
                if is_flag_name(name) {
                    return Err(ProgramError::EncodingFlagRegister {
                        token,
                        name: name.clone(),
                    });
                }
                if !context.register_names.contains(name) {
                    return Err(ProgramError::EncodingUnknownRegister {
                        token,
                        name: name.clone(),
                    });
                }
            }
            EncodingOperandShape::Interface(interface_id) => {
                if !context.interface_ids.contains(interface_id) {
                    return Err(ProgramError::EncodingUndeclaredInterface {
                        token,
                        interface_id: *interface_id,
                    });
                }
            }
            EncodingOperandShape::ImmediateArch => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    const A32: ArchBits = ArchBits::B32;

    fn v(raw: u64) -> ArchValue {
        ArchValue::new(raw, A32)
    }

    fn reg(name: &str) -> Operand {
        Operand::Register(String::from(name))
    }

    fn imm(raw: u64) -> Operand {
        Operand::Immediate(v(raw))
    }

    fn baseline(op: BaselineOp, operands: Vec<Operand>) -> Instruction {
        Instruction {
            op: Op::Baseline(op),
            operands,
        }
    }

    fn context() -> ProgramContext {
        ProgramContext {
            register_names: ["RAX", "RBX", "RBP"]
                .iter()
                .map(|s| String::from(*s))
                .chain(["RSP", "RIP", "FLAG_KEY"].iter().map(|s| String::from(*s)))
                .collect(),
            flag_names: [String::from("FLAG_KEY")].into_iter().collect(),
            custom_mnemonics: [String::from("MYNOP")].into_iter().collect(),
            interface_ids: [0x100, 0xFFFF].into_iter().collect(),
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 冻结表镜像:20 opcode 词汇与形态表
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn baseline_op_vocabulary_is_exactly_twenty() {
        let all: Vec<&str> = BaselineOp::ALL.iter().map(|op| op.mnemonic()).collect();
        assert_eq!(
            all,
            vec![
                "mov", "push", "pop", "leave", "add", "sub", "cmp", "and", "or", "xor", "shl",
                "shr", "jmp", "je", "jne", "jb", "jae", "call", "ret", "syscall",
            ]
        );
        // 大小写敏感:大写不是基线(自定义域)。
        assert!(BaselineOp::parse("MOV").is_none());
        assert_eq!(BaselineOp::parse("mov"), Some(BaselineOp::Mov));
        assert!(BaselineOp::parse("read").is_none(), "read/write 已废止(v2)");
        assert!(BaselineOp::parse("write").is_none());
    }

    #[test]
    fn shape_table_green_matrix() {
        // 每条合法形态都过(与编译器 OPCODE_OPERAND_SHAPES 同集)。
        let mem = |base: Option<&str>, disp: u64| Operand::Memory {
            base: base.map(String::from),
            displacement: v(disp),
        };
        let cases: Vec<(BaselineOp, Vec<Operand>)> = vec![
            (BaselineOp::Mov, vec![reg("RAX"), imm(1)]),
            (BaselineOp::Mov, vec![reg("RAX"), reg("RBX")]),
            (BaselineOp::Mov, vec![reg("RAX"), mem(Some("RBP"), 8)]),
            (BaselineOp::Mov, vec![mem(None, 0x100), reg("RAX")]),
            (BaselineOp::Push, vec![reg("RAX")]),
            (BaselineOp::Push, vec![imm(5)]),
            (BaselineOp::Pop, vec![reg("RAX")]),
            (BaselineOp::Leave, vec![]),
            (BaselineOp::Add, vec![reg("RAX"), reg("RBX")]),
            (BaselineOp::Add, vec![reg("RAX"), imm(5)]),
            (BaselineOp::Add, vec![reg("RAX"), mem(Some("RAX"), 4)]),
            (BaselineOp::Xor, vec![reg("RAX"), reg("RBX")]),
            (BaselineOp::Shr, vec![reg("RAX"), imm(3)]),
            (BaselineOp::Jmp, vec![imm(0x4000)]),
            (BaselineOp::Jmp, vec![reg("RAX")]),
            (BaselineOp::Jmp, vec![mem(Some("RAX"), 0)]),
            (BaselineOp::Je, vec![imm(2)]),
            (BaselineOp::Jne, vec![imm(2)]),
            (BaselineOp::Jb, vec![imm(2)]),
            (BaselineOp::Jae, vec![imm(2)]),
            (BaselineOp::Call, vec![imm(2)]),
            (BaselineOp::Call, vec![reg("RAX")]),
            (BaselineOp::Call, vec![Operand::Interface(0x100)]),
            (BaselineOp::Ret, vec![]),
            (BaselineOp::Syscall, vec![imm(0)]),
        ];
        let ctx = context();
        for (op, operands) in cases {
            let instruction = Instruction {
                op: Op::Baseline(op),
                operands,
            };
            ctx.validate_instruction(&instruction, "ir[0]")
                .unwrap_or_else(|e| panic!("{op:?} 合法形态被拒:{e:?}"));
        }
    }

    #[test]
    fn shape_table_red_matrix() {
        let ctx = context();
        // 形态不符:mov 单操作数 / push 双操作数 / je 寄存器形态 / leave 带操作数 /
        // and 内存形态 / ret 带操作数 / syscall 寄存器形态 / pop 立即数。
        for (op, operands) in [
            (BaselineOp::Mov, vec![reg("RAX")]),
            (BaselineOp::Push, vec![reg("RAX"), reg("RBP")]),
            (BaselineOp::Je, vec![reg("RAX")]),
            (BaselineOp::Leave, vec![imm(1)]),
            (
                BaselineOp::And,
                vec![
                    reg("RAX"),
                    Operand::Memory {
                        base: Some(String::from("RBP")),
                        displacement: v(0),
                    },
                ],
            ),
            (BaselineOp::Ret, vec![reg("RAX")]),
            (BaselineOp::Syscall, vec![reg("RAX")]),
            (BaselineOp::Pop, vec![imm(1)]),
            (
                BaselineOp::Call,
                vec![Operand::Interface(0x100), reg("RAX")],
            ),
        ] {
            let instruction = Instruction {
                op: Op::Baseline(op),
                operands,
            };
            assert!(
                matches!(
                    ctx.validate_instruction(&instruction, "ir[0]"),
                    Err(ProgramError::OperandShape { .. })
                ),
                "{op:?} 非法形态必须红灯"
            );
        }
        // 引用不可解析。
        let bad_reg = baseline(BaselineOp::Mov, vec![reg("GHOST"), imm(1)]);
        assert!(matches!(
            ctx.validate_instruction(&bad_reg, "ir[0]"),
            Err(ProgramError::UnknownRegister { name, .. }) if name == "GHOST"
        ));
        let bad_base = Instruction {
            op: Op::Baseline(BaselineOp::Mov),
            operands: vec![
                reg("RAX"),
                Operand::Memory {
                    base: Some(String::from("GHOST")),
                    displacement: v(0),
                },
            ],
        };
        assert!(matches!(
            ctx.validate_instruction(&bad_base, "ir[0]"),
            Err(ProgramError::UnknownRegister { .. })
        ));
        // 未声明助记符 / 未声明接口。
        let bad_custom = Instruction {
            op: Op::Custom(String::from("GHOSTOP")),
            operands: vec![],
        };
        assert!(matches!(
            ctx.validate_instruction(&bad_custom, "ir[0]"),
            Err(ProgramError::UndeclaredMnemonic { .. })
        ));
        let bad_iface = baseline(BaselineOp::Call, vec![Operand::Interface(0x9999)]);
        assert!(matches!(
            ctx.validate_instruction(&bad_iface, "ir[0]"),
            Err(ProgramError::UndeclaredInterface { .. })
        ));
        // 已声明助记符零操作数绿灯;带操作数红灯。
        let good_custom = Instruction {
            op: Op::Custom(String::from("MYNOP")),
            operands: vec![],
        };
        assert!(ctx.validate_instruction(&good_custom, "ir[0]").is_ok());
        let custom_with_operands = Instruction {
            op: Op::Custom(String::from("MYNOP")),
            operands: vec![imm(1)],
        };
        assert!(matches!(
            ctx.validate_instruction(&custom_with_operands, "ir[0]"),
            Err(ProgramError::OperandShape { .. })
        ));
    }

    #[test]
    fn syscall_dispatch_band_is_enforced() {
        let ctx = context();
        // 保留带内置。
        for built_in in [0u64, 1, 0x80, 0xFF] {
            let instruction = baseline(BaselineOp::Syscall, vec![imm(built_in)]);
            ctx.validate_instruction(&instruction, "ir[0]")
                .unwrap_or_else(|e| panic!("保留带 {built_in:#x} 应内置受理:{e:?}"));
        }
        // 已声明接口(声明集 = {0x100, 0xFFFF})。
        let instruction = baseline(BaselineOp::Syscall, vec![imm(0xFFFF)]);
        ctx.validate_instruction(&instruction, "ir[0]")
            .unwrap_or_else(|e| panic!("已声明接口 0xFFFF 应受理:{e:?}"));
        // 未声明(带内带外各一)。
        for undeclared in [0x101u64, 0x1234, 0x2000] {
            let instruction = baseline(BaselineOp::Syscall, vec![imm(undeclared)]);
            assert!(matches!(
                ctx.validate_instruction(&instruction, "ir[1]"),
                Err(ProgramError::UndeclaredSyscallNumber { value, .. }) if value == undeclared
            ));
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 声明面校验:customInstructions / interfaces
    // ─────────────────────────────────────────────────────────────────────

    fn custom_defs() -> Vec<CustomInstructionDef> {
        vec![
            CustomInstructionDef {
                mnemonic: String::from("SETKEY"),
                display_text: String::from("setkey"),
                semantics: vec![
                    MicroOp::LoadImm {
                        dst: String::from("RAX"),
                        value: v(7),
                    },
                    MicroOp::SetFlag {
                        flag_register: String::from("FLAG_KEY"),
                        value: v(1),
                    },
                ],
            },
            CustomInstructionDef {
                mnemonic: String::from("NOPX"),
                display_text: String::from("nop"),
                semantics: vec![MicroOp::BitMask {
                    dst: String::from("RAX"),
                    src: String::from("RAX"),
                    mask: v(0xFFFF_FFFF),
                    logic: BitLogic::And,
                }],
            },
        ]
    }

    fn iface_defs() -> Vec<InterfaceDef> {
        vec![InterfaceDef {
            interface_id: 0x100,
            display_text: String::from("grant"),
            effects: vec![
                EffectPrimitive::GrantVirtualFile {
                    file_id: String::from("notes.txt"),
                },
                EffectPrimitive::Noop,
            ],
        }]
    }

    fn register_set() -> BTreeSet<String> {
        ["RAX", "RBX", "RSP", "RBP", "RIP", "FLAG_KEY"]
            .iter()
            .map(|s| String::from(*s))
            .collect()
    }

    fn flag_set() -> BTreeSet<String> {
        [String::from("FLAG_KEY")].into_iter().collect()
    }

    #[test]
    fn custom_instructions_validate_green() {
        let mut ctx = ProgramContext {
            register_names: register_set(),
            flag_names: flag_set(),
            ..ProgramContext::default()
        };
        let map = validate_custom_instructions(&custom_defs(), &mut ctx).unwrap();
        assert_eq!(map.len(), 2);
        assert!(map.contains_key("SETKEY"));
        assert!(ctx.custom_mnemonics.contains("NOPX"), "声明面回填上下文");
        // displayText 不参与执行语义(仅层 3 展示)。
        assert_eq!(map["NOPX"].display_text, "nop");
    }

    #[test]
    fn custom_instructions_red_matrix() {
        let base_ctx = || ProgramContext {
            register_names: register_set(),
            flag_names: flag_set(),
            ..ProgramContext::default()
        };
        // 上限 16。
        let seventeen: Vec<CustomInstructionDef> = (0..17)
            .map(|i| CustomInstructionDef {
                mnemonic: format!("OP{i:02}"),
                display_text: String::from("x"),
                semantics: vec![MicroOp::LoadImm {
                    dst: String::from("RAX"),
                    value: v(1),
                }],
            })
            .collect();
        assert!(matches!(
            validate_custom_instructions(&seventeen, &mut base_ctx()),
            Err(ProgramError::TooManyCustomInstructions { count: 17 })
        ));
        // 助记符:空 / 撞基线小写 / 非大写形态 / 超长。
        for bad in ["", "mov", "read", "MyOp", "lower", "TOOLONG_NAME_17XX"] {
            let def = CustomInstructionDef {
                mnemonic: String::from(bad),
                display_text: String::from("x"),
                semantics: vec![MicroOp::LoadImm {
                    dst: String::from("RAX"),
                    value: v(1),
                }],
            };
            assert!(
                matches!(
                    validate_custom_instructions(&alloc::vec![def], &mut base_ctx()),
                    Err(ProgramError::InvalidMnemonic(_))
                ),
                "助记符 {bad:?} 必须红灯"
            );
        }
        // 重复助记符。
        let mut dup2 = custom_defs();
        dup2.push(dup2[1].clone());
        assert!(matches!(
            validate_custom_instructions(&dup2, &mut base_ctx()),
            Err(ProgramError::DuplicateMnemonic(_))
        ));
        // 空语义 / 超上限。
        let empty = alloc::vec![CustomInstructionDef {
            mnemonic: String::from("EMPTY"),
            display_text: String::from("x"),
            semantics: vec![],
        }];
        assert!(matches!(
            validate_custom_instructions(&empty, &mut base_ctx()),
            Err(ProgramError::EmptySemantics { .. })
        ));
        let mut seventeen_ops = custom_defs();
        seventeen_ops[0].semantics = (0..17)
            .map(|_| MicroOp::LoadImm {
                dst: String::from("RAX"),
                value: v(1),
            })
            .collect();
        assert!(matches!(
            validate_custom_instructions(&seventeen_ops, &mut base_ctx()),
            Err(ProgramError::TooManyMicroOps { count: 17, .. })
        ));
        // 微算子数据寄存器:未知 / FLAG 保留区。
        let bad_reg = alloc::vec![CustomInstructionDef {
            mnemonic: String::from("BADREG"),
            display_text: String::from("x"),
            semantics: vec![MicroOp::MovReg {
                dst: String::from("GHOST"),
                src: String::from("RAX"),
            }],
        }];
        assert!(matches!(
            validate_custom_instructions(&bad_reg, &mut base_ctx()),
            Err(ProgramError::MicroOpUnknownRegister { .. })
        ));
        let flag_data = alloc::vec![CustomInstructionDef {
            mnemonic: String::from("FLGDATA"),
            display_text: String::from("x"),
            semantics: vec![MicroOp::LoadImm {
                dst: String::from("FLAG_KEY"),
                value: v(1),
            }],
        }];
        assert!(matches!(
            validate_custom_instructions(&flag_data, &mut base_ctx()),
            Err(ProgramError::MicroOpFlagOperand { .. })
        ));
        // set_flag 目标不是声明 FLAG。
        let bad_flag = alloc::vec![CustomInstructionDef {
            mnemonic: String::from("BADFLG"),
            display_text: String::from("x"),
            semantics: vec![MicroOp::SetFlag {
                flag_register: String::from("RAX"),
                value: v(1),
            }],
        }];
        assert!(matches!(
            validate_custom_instructions(&bad_flag, &mut base_ctx()),
            Err(ProgramError::SetFlagNotDeclaredFlag { .. })
        ));
    }

    #[test]
    fn interfaces_validate_green_and_red() {
        let mut ctx = ProgramContext {
            flag_names: [String::from("FLAG_DONE")].into_iter().collect(),
            ..ProgramContext::default()
        };
        let map = validate_interfaces(&iface_defs(), &mut ctx).unwrap();
        assert_eq!(map.len(), 1);
        assert!(ctx.interface_ids.contains(&0x100));
        // 号域 / 重复 / 空 / 超限 / set_flag 目标。
        let out_of_range = alloc::vec![InterfaceDef {
            interface_id: 0xFF,
            display_text: String::from("x"),
            effects: vec![EffectPrimitive::Noop],
        }];
        assert!(matches!(
            validate_interfaces(&out_of_range, &mut ctx),
            Err(ProgramError::InterfaceIdOutOfRange { interface_id: 0xFF })
        ));
        let out_of_range2 = alloc::vec![InterfaceDef {
            interface_id: 0x1_0000,
            display_text: String::from("x"),
            effects: vec![EffectPrimitive::Noop],
        }];
        assert!(matches!(
            validate_interfaces(&out_of_range2, &mut ctx),
            Err(ProgramError::InterfaceIdOutOfRange {
                interface_id: 0x1_0000
            })
        ));
        let mut dup2 = iface_defs();
        dup2.push(dup2[0].clone());
        assert!(matches!(
            validate_interfaces(&dup2, &mut ctx),
            Err(ProgramError::DuplicateInterfaceId(0x100))
        ));
        let empty = alloc::vec![InterfaceDef {
            interface_id: 0x100,
            display_text: String::from("x"),
            effects: vec![],
        }];
        assert!(matches!(
            validate_interfaces(&empty, &mut ctx),
            Err(ProgramError::EmptyEffects { .. })
        ));
        let mut many = iface_defs();
        many[0].effects = (0..17).map(|_| EffectPrimitive::Noop).collect();
        assert!(matches!(
            validate_interfaces(&many, &mut ctx),
            Err(ProgramError::TooManyEffects { count: 17, .. })
        ));
        let bad_flag = alloc::vec![InterfaceDef {
            interface_id: 0x100,
            display_text: String::from("x"),
            effects: vec![EffectPrimitive::SetFlag {
                flag_register: String::from("RAX"),
                value: v(1),
            }],
        }];
        assert!(matches!(
            validate_interfaces(&bad_flag, &mut ctx),
            Err(ProgramError::SetFlagNotDeclaredFlag { .. })
        ));
        let seventeen_ifaces: Vec<InterfaceDef> = (0..17)
            .map(|i| InterfaceDef {
                interface_id: 0x100 + i,
                display_text: String::from("x"),
                effects: vec![EffectPrimitive::Noop],
            })
            .collect();
        assert!(matches!(
            validate_interfaces(&seventeen_ifaces, &mut ctx),
            Err(ProgramError::TooManyInterfaces { count: 17 })
        ));
    }

    // ─────────────────────────────────────────────────────────────────────
    // 编码表条目(D4.7 宽度;XS-ENC-TOKEN 红灯)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn encoding_entry_lengths() {
        let entry = EncodingTableEntry {
            token: 0x10,
            op: Op::Baseline(BaselineOp::Mov),
            operand_shapes: vec![
                EncodingOperandShape::Register(String::from("RAX")),
                EncodingOperandShape::ImmediateArch,
            ],
        };
        assert_eq!(entry.inline_bytes(ArchBits::B32), 4);
        assert_eq!(entry.total_bytes(ArchBits::B32), 5);
        assert_eq!(entry.inline_bytes(ArchBits::B64), 8);
        assert_eq!(entry.total_bytes(ArchBits::B64), 9);
        let none = EncodingTableEntry {
            token: 0xC3,
            op: Op::Baseline(BaselineOp::Ret),
            operand_shapes: vec![],
        };
        assert_eq!(none.total_bytes(ArchBits::B64), 1);
    }

    #[test]
    fn encoding_entry_red_matrix() {
        let ctx = context();
        // 形态不符:ret 带寄存器烘焙 / je 带立即数+寄存器 / mov 单烘焙。
        for (token, op, shapes) in [
            (
                0xC3u8,
                BaselineOp::Ret,
                vec![EncodingOperandShape::Register(String::from("RAX"))],
            ),
            (
                0x20,
                BaselineOp::Je,
                vec![
                    EncodingOperandShape::ImmediateArch,
                    EncodingOperandShape::Register(String::from("RAX")),
                ],
            ),
            (
                0x21,
                BaselineOp::Mov,
                vec![EncodingOperandShape::Register(String::from("RAX"))],
            ),
        ] {
            let entry = EncodingTableEntry {
                token,
                op: Op::Baseline(op),
                operand_shapes: shapes,
            };
            assert!(
                matches!(
                    validate_encoding_entry(&entry, &ctx),
                    Err(ProgramError::EncodingShape { .. })
                ),
                "token {token:#04X} 非法形态必须红灯"
            );
        }
        // FLAG 寄存器烘焙(R11)。
        let flag_baked = EncodingTableEntry {
            token: 0x30,
            op: Op::Baseline(BaselineOp::Push),
            operand_shapes: vec![EncodingOperandShape::Register(String::from("FLAG_KEY"))],
        };
        assert!(matches!(
            validate_encoding_entry(&flag_baked, &ctx),
            Err(ProgramError::EncodingFlagRegister { token: 0x30, .. })
        ));
        // 未知寄存器烘焙。
        let ghost = EncodingTableEntry {
            token: 0x31,
            op: Op::Baseline(BaselineOp::Push),
            operand_shapes: vec![EncodingOperandShape::Register(String::from("GHOST"))],
        };
        assert!(matches!(
            validate_encoding_entry(&ghost, &ctx),
            Err(ProgramError::EncodingUnknownRegister { .. })
        ));
        // 未声明接口烘焙。
        let ghost_iface = EncodingTableEntry {
            token: 0x32,
            op: Op::Baseline(BaselineOp::Call),
            operand_shapes: vec![EncodingOperandShape::Interface(0x9999)],
        };
        assert!(matches!(
            validate_encoding_entry(&ghost_iface, &ctx),
            Err(ProgramError::EncodingUndeclaredInterface { .. })
        ));
        // 未声明自定义助记符。
        let ghost_custom = EncodingTableEntry {
            token: 0x33,
            op: Op::Custom(String::from("GHOSTOP")),
            operand_shapes: vec![],
        };
        assert!(matches!(
            validate_encoding_entry(&ghost_custom, &ctx),
            Err(ProgramError::UndeclaredMnemonic { .. })
        ));
        // 绿灯:合法 call imm / push RAX 烘焙。
        let ok_call = EncodingTableEntry {
            token: 0xE8,
            op: Op::Baseline(BaselineOp::Call),
            operand_shapes: vec![EncodingOperandShape::ImmediateArch],
        };
        assert!(validate_encoding_entry(&ok_call, &ctx).is_ok());
        let ok_push = EncodingTableEntry {
            token: 0x50,
            op: Op::Baseline(BaselineOp::Push),
            operand_shapes: vec![EncodingOperandShape::Register(String::from("RAX"))],
        };
        assert!(validate_encoding_entry(&ok_push, &ctx).is_ok());
        let ok_mem = EncodingTableEntry {
            token: 0x8B,
            op: Op::Baseline(BaselineOp::Mov),
            operand_shapes: vec![
                EncodingOperandShape::Register(String::from("RAX")),
                EncodingOperandShape::Memory {
                    base: String::from("RBP"),
                },
            ],
        };
        assert!(validate_encoding_entry(&ok_mem, &ctx).is_ok());
    }

    #[test]
    fn custom_mnemonic_shape_boundaries() {
        assert!(is_custom_mnemonic_shape("A"));
        assert!(is_custom_mnemonic_shape("SETKEY"));
        assert!(is_custom_mnemonic_shape("OP_1"));
        assert!(!is_custom_mnemonic_shape(""));
        assert!(!is_custom_mnemonic_shape("a"));
        assert!(!is_custom_mnemonic_shape("SetKEY"));
        assert!(!is_custom_mnemonic_shape("1OP"));
        assert!(!is_custom_mnemonic_shape("OP-1"));
        assert!(!is_custom_mnemonic_shape("TOOLONG_NAME_17XX"));
    }
}

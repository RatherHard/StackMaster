//! 指令执行引擎(WP-4;计划书 6.1 / 6.2、最小DSL范围 §三、D4.2 / D4.4、
//! R14 遗留项)。逐 opcode 规约见 `docs/develop/指令规约.md`(权威语义文档)。
//!
//! # 统一执行语义入口
//!
//! [`Engine`] 持有 [`VmState`](crate::state::VmState) 与 [`Program`],对 IR 模式
//! (编译产物直读,`instructionPointer` = 指令索引)与字节模式(表层机器码为
//! 唯一权威执行空间,`instructionPointer` = 代码区字节地址,D4.4)提供同一
//! [`Engine::step`] / [`Engine::run_to_event`] 语义入口——两种形态只差取指方式,
//! 执行语义唯一。字节模式取指译码走 [`crate::decode`](纯函数),译码结果按
//! 首地址缓存(**性能优化不是状态**,D4.4:W^X 保证代码区会话内不变,缓存
//! 永不失效、不进快照、可随时重建)。
//!
//! # 关键语义裁决(规约文档同源)
//!
//! - **栈槽定宽 8 字节**(冻结于最小DSL范围 §三.1 "`RSP -= 8` 后写栈"),
//!   与 archBits 无关;值按掩蔽域容器小端落盘(32 位题目高 4 字节为零);
//! - **标志模型**:`zf` / `cf` / `sf` 三件套,承载于 `registers` 字段
//!   (冻结表 "+ FLAG 位");`add`/`sub`/`cmp` 置 zf cf sf,`and`/`or`/`xor`/
//!   `shl`/`shr` 只置 zf sf(cf 不动);条件跳转只消费标志;`cmp` 不写回;
//! - **移位量按 archBits 取模**(§三.1);
//! - **`leave`** = `mov rsp,rbp; pop rbp` + Canary 检查 + 返回地址槽位以
//!   `ret` 同规则校验(G4 裁决:后续将被弹出的值不可执行 → `invalid_rip`,
//!   教学上在 `leave` 即报,早于其后的 `ret`);
//! - **`ret` / `leave` 前置 Canary 检查**(破坏 → `canary_violation`,状态
//!   `failed`);`call_frames` 是引擎侧影子栈(`call` 压、`ret` 弹,与玩家
//!   栈独立——被劫持的 `ret` 不因影子栈为空而拒绝);
//! - **接口派发不占玩家栈**(D4.2 ①:引擎管理调用——执行效果后返回下一条
//!   指令,不压返回地址、不建调用帧);
//! - **每指令单一主事件类别**:`call`/`ret` 的栈访问并入 Call/Ret 事件,
//!   `push`/`pop`/`mov R,M`/`mov M,R`/`jmp M`/自定义指令内存微算子发
//!   Read/Write 事件;`syscall` 发 Syscall 事件(不属 `pauseOn` 枚举,
//!   伪 syscall 不作为暂停事件提供);
//! - **异常方向**:`未知 token / 不可执行 RIP / 指令截断 → invalid_rip`;
//!   数据访问越权 → `memory_fault`(统一拒绝路径 I-9);Canary 破坏 →
//!   `canary_violation`;步数 / 调用深度超限 → `resource_limit`;Rust 算术
//!   溢出 panic(ENG-3)由宿主按 `engine_error` 安全终止——引擎内一切地址
//!   / 指针算术都在掩蔽域模运算内完成,溢出 panic 只可能是引擎缺陷;
//!   字节模式探测译码外的未声明派发号(运行期 gadget 路径)→ `invalid_action`。
//!
//! # 预算
//!
//! 基线指令步耗 1;自定义指令步耗 = 微算子条数(恒定,与操作数值无关,
//! T-SC2);接口效果步耗 = 效果原语条数(同恒定)。全部计入 `constraints.steps`
//! (可回退预算,随快照回退)。

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

use crate::arch::{ArchBits, ArchValue};
use crate::decode::{EncodingIndex, decode_entry};
use crate::instr::{
    BaselineOp, BitLogic, CustomInstructionDef, EffectPrimitive, INTERFACE_ID_MAX,
    INTERFACE_ID_MIN, Instruction, InterfaceDef, MicroOp, Op, Operand, Program, ProgramContext,
    ProgramError, SYSCALL_RESERVED_MAX, validate_custom_instructions, validate_interfaces,
    validate_program,
};
use crate::memory::MemoryFault;
use crate::registers::Flags;
use crate::state::{
    CallFrame, ResourceLimitError, StateInitError, VmEvent, VmEventKind, VmState, VmStateConfig,
    VmStatus,
};

/// `run_to_event` 暂停事件类别(协议 `PauseEventSchema` 五值;指令级暂停由
/// `step` 动作承载,不属本枚举;伪 `syscall` 不作为暂停事件提供)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseOn {
    /// 读内存事件。
    Read,
    /// 写内存事件。
    Write,
    /// 调用事件。
    Call,
    /// 返回事件。
    Ret,
    /// 异常边界(引擎侧异常恒终止为 `failed`;本类别的响应面归 WP-7 / WP-8)。
    Exception,
}

impl PauseOn {
    /// 协议字符串形态。
    pub fn as_str(self) -> &'static str {
        match self {
            PauseOn::Read => "read",
            PauseOn::Write => "write",
            PauseOn::Call => "call",
            PauseOn::Ret => "ret",
            PauseOn::Exception => "exception",
        }
    }

    /// 协议字符串 → 枚举。
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "read" => Some(PauseOn::Read),
            "write" => Some(PauseOn::Write),
            "call" => Some(PauseOn::Call),
            "ret" => Some(PauseOn::Ret),
            "exception" => Some(PauseOn::Exception),
            _ => None,
        }
    }
}

/// 执行异常(方向注释为公开错误码 / 结果类型的映射依据;粗化归 WP-7)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecError {
    /// 取指位置不可执行:未映射 / 无执行权限 / 未知 token / 指令截断 /
    /// IR 索引出界 / `ret`·`leave` 弹出值不可作为执行位置(方向 `invalid_rip`)。
    InvalidRip {
        /// 不可执行的地址(或 IR 索引)。
        address: u64,
    },
    /// 运行期 `syscall` 派发号不可解析(字节模式探测译码外的 gadget 路径;
    /// 方向 `invalid_action`,XS-SYSCALL-DECL 运行时兜底)。
    InvalidSyscallDispatch {
        /// 派发号。
        value: u64,
    },
    /// 数据访问越权 / 越界(统一拒绝路径 I-9;方向 `memory_fault`)。
    MemoryFault(MemoryFault),
    /// Canary 槽位内容被改写(方向 `canary_violation`;状态转 `failed`)。
    CanaryViolation {
        /// 槽位起始地址。
        address: u64,
        /// 槽位字节长度。
        byte_length: u64,
    },
    /// 预算耗尽(步数 / 调用深度;方向 `resource_limit`)。
    ResourceLimit(crate::state::ResourceLimitError),
    /// 引擎内部不变量破坏(装载校验后理论不可达;宿主按 `engine_error` 终止)。
    InvariantBroken(&'static str),
}

impl ExecError {
    /// 异常事件地址(私有 Exception 事件的 address 字段来源)。
    fn event_address(&self) -> Option<u64> {
        match self {
            ExecError::InvalidRip { address }
            | ExecError::InvalidSyscallDispatch { value: address } => Some(*address),
            ExecError::MemoryFault(fault) => Some(fault.addr),
            ExecError::CanaryViolation { address, .. } => Some(*address),
            ExecError::ResourceLimit(_) | ExecError::InvariantBroken(_) => None,
        }
    }
}

/// 单次 `step` / `run_to_event` 的执行结局。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    /// `step`:恰好一条指令执行完毕,仍在运行(状态 `running`)。
    Stepped,
    /// `run_to_event`:命中暂停事件(状态 `paused`)。
    Paused {
        /// 命中的事件类别。
        on: PauseOn,
    },
    /// 程序终止(`syscall exit(I)` 内置或接口 `exit` 效果);会话仍可继续
    /// (`undo` / 判题归 WP-5 / WP-6,状态保持 `running`,由 `halted` 标记停执行)。
    Exited {
        /// 退出码(内置 `exit(I)` 为 I;接口 `exit` 效果等效 `exit(0)`)。
        code: u64,
    },
    /// 异常终止(状态 `failed`;方向见 [`ExecError`])。
    Failed {
        /// 异常。
        error: ExecError,
    },
    /// 无执行:程序已 `exit` 或状态已终态(won / failed)。
    Halted,
}

/// Canary 槽位规约(来源 = 私有包 `privateObjects` 中 `kind = "canary"` 的对象;
/// 由装载管线换算,期望值在引擎初始化时从初始内存截取)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanarySlotSpec {
    /// 槽位起始地址。
    pub address: u64,
    /// 槽位字节长度(1–8;区域内部对象不受对齐约束)。
    pub byte_length: usize,
}

/// Canary 槽位(含期望字节;只存在于引擎内,值即秘密——公开面经 WP-7 粗化)。
#[derive(Debug, Clone, PartialEq, Eq)]
struct CanarySlot {
    address: u64,
    byte_length: usize,
    expected: Vec<u8>,
}

/// 引擎装配输入。
#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// VM 状态装配(寄存器 / 内存 / 约束 / seed;WP-3)。
    pub state: VmStateConfig,
    /// 程序(IR / 字节恰一,形态由上游裁定)。
    pub program: Program,
    /// 作者自定义指令声明面。
    pub custom_instructions: Vec<CustomInstructionDef>,
    /// 作者接口声明面。
    pub interfaces: Vec<InterfaceDef>,
    /// Canary 槽位(私有对象 `kind = "canary"`;空集 = 本题无 Canary)。
    pub canary_slots: Vec<CanarySlotSpec>,
}

/// 引擎装配错误(方向 = challenge_invalid)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineInitError {
    /// 状态装配拒绝。
    State(StateInitError),
    /// 程序 / 声明面校验拒绝。
    Program(ProgramError),
    /// Canary 槽位不可读(初始内存截取失败)。
    CanarySlotUnreadable {
        /// 槽位地址。
        address: u64,
    },
}

/// 译码缓存条目(字节模式;键 = 指令首地址)。
#[derive(Debug, Clone)]
struct CachedDecode {
    instr: Instruction,
    next: u64,
}

/// 指令执行引擎。纯同步状态机;时钟 / 随机源由上层注入(本模块无此需求面)。
#[derive(Debug, Clone)]
pub struct Engine {
    /// 权威 VM 状态(冻结 8 字段)。
    pub state: VmState,
    /// 初始状态快照(`reset` 的恢复源;引擎内克隆,COW 优化归 WP-6)。
    initial_state: VmState,
    /// 程序(IR / 字节)。
    program: Program,
    /// 编码表索引(字节模式;IR 模式为空)。
    encoding_index: EncodingIndex,
    /// 自定义指令表(助记符 → 定义)。
    custom_instructions: BTreeMap<String, CustomInstructionDef>,
    /// 接口表(接口号 → 定义)。
    interfaces: BTreeMap<u32, InterfaceDef>,
    /// Canary 槽位(含期望值)。
    canary_slots: Vec<CanarySlot>,
    /// 程序已终止(`exit`);会话仍可继续。
    halted: bool,
    /// 译码缓存(字节模式;性能优化非状态,D4.4——W^X 保证代码区会话内
    /// 不变,缓存永不失效,不进快照,`reset` 后保持有效)。
    decode_cache: BTreeMap<u64, CachedDecode>,
}

impl Engine {
    /// 装配:状态 → 声明面(自定义指令 / 接口)→ 程序镜像复验 → Canary
    /// 期望值截取。任一步拒绝即整体拒绝(fail-closed)。
    pub fn new(config: EngineConfig) -> Result<Self, EngineInitError> {
        let EngineConfig {
            state: state_config,
            program,
            custom_instructions,
            interfaces,
            canary_slots,
        } = config;
        let flag_names: BTreeSet<String> =
            state_config.flag_register_names.iter().cloned().collect();
        let register_names: BTreeSet<String> = state_config
            .registers
            .iter()
            .map(|(name, _)| name.clone())
            .collect();
        let mut state = VmState::new(state_config).map_err(EngineInitError::State)?;
        let mut context = ProgramContext {
            register_names,
            flag_names,
            ..ProgramContext::default()
        };
        let customs = validate_custom_instructions(&custom_instructions, &mut context)
            .map_err(EngineInitError::Program)?;
        let ifaces =
            validate_interfaces(&interfaces, &mut context).map_err(EngineInitError::Program)?;
        validate_program(&program, &state.memory, &context).map_err(EngineInitError::Program)?;
        let encoding_index = match &program {
            Program::Byte { table, .. } => EncodingIndex::new(table),
            Program::Ir { .. } => EncodingIndex::default(),
        };
        let arch = state.memory.arch();
        let mut slots = Vec::with_capacity(canary_slots.len());
        for spec in canary_slots {
            let expected = state
                .memory
                .read(ArchValue::new(spec.address, arch), spec.byte_length)
                .map_err(|_| EngineInitError::CanarySlotUnreadable {
                    address: spec.address,
                })?;
            slots.push(CanarySlot {
                address: spec.address,
                byte_length: spec.byte_length,
                expected,
            });
        }
        // RIP 寄存器与 instructionPointer 是同一执行位置的两个架构视图
        // (冻结表两者并存;RIP 可进 visibleRegisters,装载即同步,此后由
        // set_ip 统一维护,不产生双真相源)。
        let initial_ip = state.instruction_pointer;
        state
            .registers
            .set("RIP", initial_ip)
            .map_err(|e| EngineInitError::State(StateInitError::Registers(e)))?;
        let initial_state = state.clone();
        Ok(Self {
            state,
            initial_state,
            program,
            encoding_index,
            custom_instructions: customs,
            interfaces: ifaces,
            canary_slots: slots,
            halted: false,
            decode_cache: BTreeMap::new(),
        })
    }

    /// 架构位宽。
    pub fn arch(&self) -> ArchBits {
        self.state.memory.arch()
    }

    /// 程序已终止(`exit`)。
    pub fn is_halted(&self) -> bool {
        self.halted
    }

    /// 程序引用。
    pub fn program(&self) -> &Program {
        &self.program
    }

    /// 自定义指令表引用。
    pub fn custom_instructions(&self) -> &BTreeMap<String, CustomInstructionDef> {
        &self.custom_instructions
    }

    /// 接口表引用。
    pub fn interfaces(&self) -> &BTreeMap<u32, InterfaceDef> {
        &self.interfaces
    }

    /// 单步:恰好执行一条指令(动作 `step` 的引擎落点)。
    pub fn step(&mut self) -> RunOutcome {
        self.step_once(None)
    }

    /// 运行至暂停事件(动作 `run_to_event` 的引擎落点):循环执行至
    /// 命中 `pause_on` 类事件、程序 `exit`、异常或预算耗尽。
    pub fn run_to_event(&mut self, pause_on: PauseOn) -> RunOutcome {
        loop {
            match self.step_once(Some(pause_on)) {
                RunOutcome::Stepped => continue,
                outcome => return outcome,
            }
        }
    }

    /// 暂停(动作 `pause` 的引擎落点):在当前指令边界将 `running` 置 `paused`。
    pub fn pause(&mut self) {
        if self.state.status == VmStatus::Running {
            self.state.status = VmStatus::Paused;
        }
    }

    /// 重置:恢复装载时初始状态(`reset` 动作的引擎落点;revision 与投影
    /// 语义归 WP-6 / WP-8)。译码缓存保留——字节模式 W^X ⇒ 代码区内容
    /// 会话内不变,缓存跨 reset 恒有效(D4.4)。
    pub fn reset(&mut self) {
        self.state = self.initial_state.clone();
        self.halted = false;
    }

    // ─────────────────────────────────────────────────────────────────────
    // 会话动作原语(WP-8 接线;响应面语义归编排层)
    // ─────────────────────────────────────────────────────────────────────

    /// 动作 `write_bytes`:写可见内存(统一权限路径 + Write 私有事件)。
    pub fn action_write_bytes(&mut self, addr: ArchValue, data: &[u8]) -> Result<(), ExecError> {
        self.state
            .memory
            .write_slice(addr, data)
            .map_err(ExecError::MemoryFault)?;
        self.log_event(
            VmEventKind::Write,
            Some(addr.get()),
            Some(data.len() as u64),
            None,
        );
        Ok(())
    }

    /// 动作 `push`:压栈(语义与 `push` 指令一致,值来自动作参数)。
    pub fn action_push(&mut self, value: ArchValue) -> Result<(), ExecError> {
        self.stack_push(value)?;
        let rsp = self.read_reg("RSP")?.get();
        self.log_event(VmEventKind::Write, Some(rsp), Some(8), None);
        Ok(())
    }

    /// 动作 `pop`:出栈,返回弹出值。
    pub fn action_pop(&mut self) -> Result<ArchValue, ExecError> {
        let old_rsp = self.read_reg("RSP")?;
        let value = self.stack_pop()?;
        self.log_event(VmEventKind::Read, Some(old_rsp.get()), Some(8), None);
        Ok(value)
    }

    /// 动作 `call`:调用目标地址(压返回地址 = 当前 `instructionPointer`,
    /// 建调用帧,`RIP ← target`;与 `call` 指令同语义)。
    pub fn action_call(&mut self, target: ArchValue) -> Result<(), ExecError> {
        let next = self.state.instruction_pointer;
        self.do_call(target, next)
    }

    /// 动作 `ret`:返回(与 `ret` 指令同语义,含 Canary 检查)。
    pub fn action_ret(&mut self) -> Result<(), ExecError> {
        self.do_ret()
    }

    // ─────────────────────────────────────────────────────────────────────
    // 取指译码(统一入口;IR 索引直读 / 字节模式缓存译码)
    // ─────────────────────────────────────────────────────────────────────

    /// 取指译码:返回(指令, 下一条执行位置)。一切取指失败(未映射 /
    /// 无执行权限 / 未知 token / 截断 / IR 索引出界)统一 `invalid_rip`。
    fn fetch_decode(&mut self) -> Result<(Instruction, u64), ExecError> {
        let ip = self.state.instruction_pointer.get();
        if let Program::Ir { instructions, .. } = &self.program {
            let index = usize::try_from(ip)
                .ok()
                .filter(|i| *i < instructions.len())
                .ok_or(ExecError::InvalidRip { address: ip })?;
            return Ok((instructions[index].clone(), ip + 1));
        }
        if let Some(cached) = self.decode_cache.get(&ip) {
            return Ok((cached.instr.clone(), cached.next));
        }
        let (instr, next) = self
            .probe_decode(ip)
            .ok_or(ExecError::InvalidRip { address: ip })?;
        self.decode_cache.insert(
            ip,
            CachedDecode {
                instr: instr.clone(),
                next,
            },
        );
        Ok((instr, next))
    }

    /// 只探测不执行(返回地址槽位校验 / 译码缓存共用;只读)。
    fn probe_decode(&self, addr: u64) -> Option<(Instruction, u64)> {
        if !matches!(self.program, Program::Byte { .. }) {
            return None;
        }
        let arch = self.state.memory.arch();
        let at = ArchValue::new(addr, arch);
        let token = self.state.memory.fetch(at, 1).ok()?;
        let entry = self.encoding_index.get(token[0])?;
        let total = entry.total_bytes(arch);
        let bytes = self.state.memory.fetch(at, total).ok()?;
        let instr = decode_entry(entry, arch, addr, &bytes[1..]).ok()?;
        Some((instr, addr + total as u64))
    }

    /// 地址是否为有效执行位置(IR:索引界内;字节:取指译码整体成功)。
    fn is_valid_exec_position(&self, target: ArchValue) -> bool {
        match &self.program {
            Program::Ir { instructions, .. } => {
                usize::try_from(target.get()).is_ok_and(|i| i < instructions.len())
            }
            Program::Byte { .. } => self.probe_decode(target.get()).is_some(),
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 主循环与执行核心
    // ─────────────────────────────────────────────────────────────────────

    fn step_once(&mut self, pause_on: Option<PauseOn>) -> RunOutcome {
        if self.halted || self.state.status.is_terminal() {
            return RunOutcome::Halted;
        }
        self.state.status = VmStatus::Running;
        let (instr, next_ip) = match self.fetch_decode() {
            Ok(pair) => pair,
            Err(error) => return self.fail(error),
        };
        let cost = self.instruction_cost(&instr);
        if let Err(err) = self.state.constraints.steps.charge(cost) {
            return self.fail(ExecError::ResourceLimit(err));
        }
        let next_val = ArchValue::new(next_ip, self.arch());
        // 默认推进到下一条;控制流指令覆写。set_ip 只会因引擎缺陷失败
        //(RIP 必选核心寄存器),按 InvariantBroken 走 fail 路径。
        if let Err(error) = self.set_ip(next_ip) {
            return self.fail(error);
        }
        match self.execute(&instr, next_val) {
            Ok(Executed::Exited { code }) => {
                self.halted = true;
                RunOutcome::Exited { code }
            }
            Ok(Executed::Evented(on)) => {
                if pause_on == Some(on) {
                    self.state.status = VmStatus::Paused;
                    RunOutcome::Paused { on }
                } else {
                    RunOutcome::Stepped
                }
            }
            Ok(Executed::Plain) => RunOutcome::Stepped,
            Err(error) => self.fail(error),
        }
    }

    fn instruction_cost(&self, instr: &Instruction) -> u64 {
        match &instr.op {
            Op::Baseline(_) => 1,
            Op::Custom(mnemonic) => self
                .custom_instructions
                .get(mnemonic)
                .map_or(1, |def| def.semantics.len() as u64),
        }
    }

    fn fail(&mut self, error: ExecError) -> RunOutcome {
        self.log_event(VmEventKind::Exception, error.event_address(), None, None);
        self.state.status = VmStatus::Failed;
        RunOutcome::Failed { error }
    }

    fn execute(&mut self, instr: &Instruction, next_val: ArchValue) -> Result<Executed, ExecError> {
        match &instr.op {
            Op::Baseline(op) => self.exec_baseline(*op, &instr.operands, next_val),
            Op::Custom(mnemonic) => self.exec_custom(mnemonic),
        }
    }

    fn exec_baseline(
        &mut self,
        op: BaselineOp,
        operands: &[Operand],
        next_val: ArchValue,
    ) -> Result<Executed, ExecError> {
        match op {
            BaselineOp::Mov => self.exec_mov(operands),
            BaselineOp::Push => {
                let value = match operands.first() {
                    Some(Operand::Register(name)) => self.read_reg(name)?,
                    Some(Operand::Immediate(value)) => *value,
                    _ => return Err(ExecError::InvariantBroken("push 形态已由冻结表封闭")),
                };
                self.stack_push(value)?;
                let rsp = self.read_reg("RSP")?.get();
                self.log_event(VmEventKind::Write, Some(rsp), Some(8), None);
                Ok(Executed::Evented(PauseOn::Write))
            }
            BaselineOp::Pop => {
                let Operand::Register(dst) = operands.first().ok_or(invariant())? else {
                    return Err(invariant());
                };
                let old_rsp = self.read_reg("RSP")?;
                let value = self.stack_pop()?;
                self.log_event(VmEventKind::Read, Some(old_rsp.get()), Some(8), None);
                self.write_reg(dst, value)?;
                Ok(Executed::Evented(PauseOn::Read))
            }
            BaselineOp::Leave => {
                // ① Canary 检查(破坏 → canary_violation,先于栈语义报错)。
                self.check_canary()?;
                // ② RSP ← RBP。
                let rbp = self.read_reg("RBP")?;
                self.write_reg("RSP", rbp)?;
                // ③ pop RBP(读取 saved RBP 槽)。
                let old_rsp = self.read_reg("RSP")?;
                let saved = self.stack_pop()?;
                self.log_event(VmEventKind::Read, Some(old_rsp.get()), Some(8), None);
                self.write_reg("RBP", saved)?;
                // ④ 返回地址槽位以 ret 同规则校验(G4:后续将被弹出的值
                //    不可执行 → invalid_rip;教学上在 leave 即报)。
                let slot = self.stack_peek()?;
                if !self.is_valid_exec_position(slot) {
                    return Err(ExecError::InvalidRip {
                        address: slot.get(),
                    });
                }
                Ok(Executed::Evented(PauseOn::Read))
            }
            BaselineOp::Add
            | BaselineOp::Sub
            | BaselineOp::Cmp
            | BaselineOp::And
            | BaselineOp::Or
            | BaselineOp::Xor
            | BaselineOp::Shl
            | BaselineOp::Shr => self.exec_arith(op, operands),
            BaselineOp::Jmp => {
                let target = self.read_target(operands.first())?;
                self.set_ip(target.get())?;
                Ok(Executed::Plain)
            }
            BaselineOp::Je | BaselineOp::Jne | BaselineOp::Jb | BaselineOp::Jae => {
                let flags = self.state.registers.flags;
                let taken = match op {
                    BaselineOp::Je => flags.zf,
                    BaselineOp::Jne => !flags.zf,
                    BaselineOp::Jb => flags.cf,
                    BaselineOp::Jae => !flags.cf,
                    _ => return Err(invariant()),
                };
                let Some(Operand::Immediate(target)) = operands.first() else {
                    return Err(invariant());
                };
                if taken {
                    self.set_ip(target.get())?;
                }
                Ok(Executed::Plain)
            }
            BaselineOp::Call => {
                if let Some(Operand::Interface(interface_id)) = operands.first() {
                    // D4.2 ①:引擎管理调用,不占玩家栈(无压栈、无调用帧)。
                    self.log_event(
                        VmEventKind::Call,
                        None,
                        None,
                        Some(u64::from(*interface_id).to_le_bytes().to_vec()),
                    );
                    let exited = self.dispatch_interface(*interface_id)?;
                    Ok(Self::exited_or(exited, PauseOn::Call))
                } else {
                    let target = self.read_target(operands.first())?;
                    self.do_call(target, next_val)?;
                    Ok(Executed::Evented(PauseOn::Call))
                }
            }
            BaselineOp::Ret => {
                self.do_ret()?;
                Ok(Executed::Evented(PauseOn::Ret))
            }
            BaselineOp::Syscall => {
                let Some(Operand::Immediate(value)) = operands.first() else {
                    return Err(invariant());
                };
                let id = value.get();
                self.log_event(
                    VmEventKind::Syscall,
                    None,
                    None,
                    Some(id.to_le_bytes().to_vec()),
                );
                if id <= SYSCALL_RESERVED_MAX {
                    // 内置 exit(I):语义不变,程序终止、退出码 = I。
                    Ok(Executed::Exited { code: id })
                } else {
                    // 作者接口派发;Syscall 事件不属 pauseOn(伪 syscall 不作为
                    // 暂停事件提供),未终止即 Plain。
                    let exited = self.dispatch_syscall_id(id)?;
                    Ok(match exited {
                        Some(code) => Executed::Exited { code },
                        None => Executed::Plain,
                    })
                }
            }
        }
    }

    fn exited_or(exited: Option<u64>, on: PauseOn) -> Executed {
        match exited {
            Some(code) => Executed::Exited { code },
            None => Executed::Evented(on),
        }
    }

    fn exec_mov(&mut self, operands: &[Operand]) -> Result<Executed, ExecError> {
        let arch = self.arch();
        let width = arch.bits() as usize / 8;
        match (operands.first(), operands.get(1)) {
            (Some(Operand::Register(dst)), Some(Operand::Immediate(value))) => {
                self.write_reg(dst, *value)?;
                Ok(Executed::Plain)
            }
            (Some(Operand::Register(dst)), Some(Operand::Register(src))) => {
                let value = self.read_reg(src)?;
                self.write_reg(dst, value)?;
                Ok(Executed::Plain)
            }
            (Some(Operand::Register(dst)), Some(Operand::Memory { base, displacement })) => {
                let ea = self.effective_address(base, *displacement)?;
                let value = self
                    .state
                    .memory
                    .read_le(ea, width, arch)
                    .map_err(ExecError::MemoryFault)?;
                self.log_event(VmEventKind::Read, Some(ea.get()), Some(width as u64), None);
                self.write_reg(dst, value)?;
                Ok(Executed::Evented(PauseOn::Read))
            }
            (Some(Operand::Memory { base, displacement }), Some(Operand::Register(src))) => {
                let value = self.read_reg(src)?;
                let ea = self.effective_address(base, *displacement)?;
                self.state
                    .memory
                    .write_le(ea, value, width)
                    .map_err(ExecError::MemoryFault)?;
                self.log_event(VmEventKind::Write, Some(ea.get()), Some(width as u64), None);
                Ok(Executed::Evented(PauseOn::Write))
            }
            _ => Err(invariant()),
        }
    }

    fn exec_arith(&mut self, op: BaselineOp, operands: &[Operand]) -> Result<Executed, ExecError> {
        let arch = self.arch();
        let Operand::Register(dst) = operands.first().ok_or(invariant())? else {
            return Err(invariant());
        };
        let lhs = self.read_reg(dst)?;
        let (rhs, mem_event) = match operands.get(1) {
            Some(Operand::Register(src)) => (self.read_reg(src)?, None),
            Some(Operand::Immediate(value)) => (*value, None),
            Some(Operand::Memory { base, displacement }) => {
                let width = arch.bits() as usize / 8;
                let ea = self.effective_address(base, *displacement)?;
                let value = self
                    .state
                    .memory
                    .read_le(ea, width, arch)
                    .map_err(ExecError::MemoryFault)?;
                self.log_event(VmEventKind::Read, Some(ea.get()), Some(width as u64), None);
                (value, Some(PauseOn::Read))
            }
            _ => return Err(invariant()),
        };
        let bits = arch.bits();
        let sign_bit = 1u64 << (bits - 1);
        let result = match op {
            BaselineOp::Add => {
                let (sum, carry) = lhs.add_with_carry(rhs, arch);
                self.set_flags(Flags {
                    zf: sum == ArchValue::ZERO,
                    cf: carry,
                    sf: sum.get() & sign_bit != 0,
                });
                sum
            }
            BaselineOp::Sub | BaselineOp::Cmp => {
                let (diff, borrow) = lhs.sub_with_borrow(rhs, arch);
                self.set_flags(Flags {
                    zf: diff == ArchValue::ZERO,
                    cf: borrow,
                    sf: diff.get() & sign_bit != 0,
                });
                diff
            }
            BaselineOp::And => self.logic_flags(lhs.and(rhs, arch), sign_bit),
            BaselineOp::Or => self.logic_flags(lhs.or(rhs, arch), sign_bit),
            BaselineOp::Xor => self.logic_flags(lhs.xor(rhs, arch), sign_bit),
            BaselineOp::Shl => {
                // 移位量按 archBits 取模(§三.1)。
                let amount = rhs.get() % u64::from(bits);
                self.logic_flags(lhs.shl(amount, arch), sign_bit)
            }
            BaselineOp::Shr => {
                let amount = rhs.get() % u64::from(bits);
                self.logic_flags(lhs.shr(amount, arch), sign_bit)
            }
            _ => return Err(invariant()),
        };
        if op != BaselineOp::Cmp {
            self.write_reg(dst, result)?;
        }
        Ok(match mem_event {
            Some(on) => Executed::Evented(on),
            None => Executed::Plain,
        })
    }

    /// 逻辑 / 移位类只置 zf sf(cf 不动,冻结表标志列 "zf sf")。
    fn logic_flags(&mut self, result: ArchValue, sign_bit: u64) -> ArchValue {
        let cf = self.state.registers.flags.cf;
        self.state.registers.flags = Flags {
            zf: result == ArchValue::ZERO,
            cf,
            sf: result.get() & sign_bit != 0,
        };
        result
    }

    fn set_flags(&mut self, flags: Flags) {
        self.state.registers.flags = flags;
    }

    /// 读控制转移目标(I / R / M;M 形态的内存读发 Read 事件)。
    fn read_target(&mut self, operand: Option<&Operand>) -> Result<ArchValue, ExecError> {
        let arch = self.arch();
        match operand {
            Some(Operand::Immediate(value)) => Ok(*value),
            Some(Operand::Register(name)) => self.read_reg(name),
            Some(Operand::Memory { base, displacement }) => {
                let width = arch.bits() as usize / 8;
                let ea = self.effective_address(base, *displacement)?;
                let value = self
                    .state
                    .memory
                    .read_le(ea, width, arch)
                    .map_err(ExecError::MemoryFault)?;
                self.log_event(VmEventKind::Read, Some(ea.get()), Some(width as u64), None);
                Ok(value)
            }
            _ => Err(invariant()),
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 调用语义(栈帧创建 / 销毁 / Canary / 影子调用帧)
    // ─────────────────────────────────────────────────────────────────────

    fn do_call(&mut self, target: ArchValue, next_val: ArchValue) -> Result<(), ExecError> {
        // 调用深度受 CALL_STACK_MAX_DEPTH 约束(方向 resource_limit)。
        let depth = self.state.call_frames.len() as u64 + 1;
        let limit = u64::from(self.state.constraints.call_depth_limit);
        if depth > limit {
            return Err(ExecError::ResourceLimit(ResourceLimitError {
                requested: depth,
                available: limit.saturating_sub(self.state.call_frames.len() as u64),
            }));
        }
        // 压返回地址(栈写并入 Call 事件,不另发 Write)。
        self.stack_push(next_val)?;
        let saved_rbp = self.read_reg("RBP")?;
        self.state.call_frames.push(CallFrame {
            function_label: format!("{:#X}", target.get()),
            return_address: next_val,
            saved_rbp,
            args: Vec::new(),
        });
        self.set_ip(target.get())?;
        self.log_event(VmEventKind::Call, Some(target.get()), None, None);
        Ok(())
    }

    fn do_ret(&mut self) -> Result<(), ExecError> {
        // ① Canary 检查(先于栈语义)。
        self.check_canary()?;
        // ② 弹出返回地址(数据读;失败 → memory_fault)。
        let target = self.stack_pop()?;
        // ③ 影子调用帧:非空即弹(与玩家栈独立,被劫持不因空栈拒绝)。
        self.state.call_frames.pop();
        // ④ 弹出值不可作为执行位置 → invalid_rip(与 leave 槽位校验同规则)。
        if !self.is_valid_exec_position(target) {
            return Err(ExecError::InvalidRip {
                address: target.get(),
            });
        }
        self.set_ip(target.get())?;
        self.log_event(VmEventKind::Ret, Some(target.get()), None, None);
        Ok(())
    }

    fn check_canary(&mut self) -> Result<(), ExecError> {
        let Engine {
            canary_slots,
            state,
            ..
        } = self;
        for slot in canary_slots {
            let addr = ArchValue::new(slot.address, state.memory.arch());
            let current = state
                .memory
                .read(addr, slot.byte_length)
                .map_err(ExecError::MemoryFault)?;
            if current != slot.expected {
                return Err(ExecError::CanaryViolation {
                    address: slot.address,
                    byte_length: slot.byte_length as u64,
                });
            }
        }
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────────
    // 栈原语(定宽 8 字节槽;掩蔽域小端)
    // ─────────────────────────────────────────────────────────────────────

    fn stack_push(&mut self, value: ArchValue) -> Result<(), ExecError> {
        let arch = self.arch();
        let rsp = self.read_reg("RSP")?;
        let new_rsp = rsp.sub(ArchValue::new(8, arch), arch);
        self.state
            .memory
            .write_le(new_rsp, value, 8)
            .map_err(ExecError::MemoryFault)?;
        self.write_reg("RSP", new_rsp)?;
        Ok(())
    }

    fn stack_pop(&mut self) -> Result<ArchValue, ExecError> {
        let arch = self.arch();
        let rsp = self.read_reg("RSP")?;
        let value = self
            .state
            .memory
            .read_le(rsp, 8, arch)
            .map_err(ExecError::MemoryFault)?;
        self.write_reg("RSP", rsp.add(ArchValue::new(8, arch), arch))?;
        Ok(value)
    }

    /// 窥视栈顶 8 字节(不弹;`leave` 返回地址槽位校验用)。
    fn stack_peek(&self) -> Result<ArchValue, ExecError> {
        let arch = self.arch();
        let rsp = self.read_reg("RSP")?;
        self.state
            .memory
            .read_le(rsp, 8, arch)
            .map_err(ExecError::MemoryFault)
    }

    // ─────────────────────────────────────────────────────────────────────
    // 自定义指令解释器(微算子封闭集 v1,直线,恒定步数)
    // ─────────────────────────────────────────────────────────────────────

    fn exec_custom(&mut self, mnemonic: &str) -> Result<Executed, ExecError> {
        let Some(def) = self.custom_instructions.get(mnemonic) else {
            return Err(ExecError::InvariantBroken("自定义助记符已在装载校验封闭"));
        };
        let def = def.clone();
        let arch = self.arch();
        let width = arch.bits() as usize / 8;
        let mut first_event: Option<PauseOn> = None;
        for micro in &def.semantics {
            match micro {
                MicroOp::LoadImm { dst, value } => {
                    self.write_reg(dst, *value)?;
                }
                MicroOp::MovReg { dst, src } => {
                    let value = self.read_reg(src)?;
                    self.write_reg(dst, value)?;
                }
                MicroOp::LoadMem {
                    dst,
                    base,
                    displacement,
                } => {
                    let ea = self.effective_address(&Some(base.clone()), *displacement)?;
                    let value = self
                        .state
                        .memory
                        .read_le(ea, width, arch)
                        .map_err(ExecError::MemoryFault)?;
                    self.log_event(VmEventKind::Read, Some(ea.get()), Some(width as u64), None);
                    first_event.get_or_insert(PauseOn::Read);
                    self.write_reg(dst, value)?;
                }
                MicroOp::StoreMem {
                    base,
                    displacement,
                    src,
                } => {
                    let value = self.read_reg(src)?;
                    let ea = self.effective_address(&Some(base.clone()), *displacement)?;
                    self.state
                        .memory
                        .write_le(ea, value, width)
                        .map_err(ExecError::MemoryFault)?;
                    self.log_event(VmEventKind::Write, Some(ea.get()), Some(width as u64), None);
                    first_event.get_or_insert(PauseOn::Write);
                }
                MicroOp::SetFlag {
                    flag_register,
                    value,
                } => {
                    self.write_reg(flag_register, *value)?;
                }
                MicroOp::BitMask {
                    dst,
                    src,
                    mask,
                    logic,
                } => {
                    let value = self.read_reg(src)?;
                    let result = match logic {
                        BitLogic::And => value.and(*mask, arch),
                        BitLogic::Or => value.or(*mask, arch),
                        BitLogic::Xor => value.xor(*mask, arch),
                    };
                    self.write_reg(dst, result)?;
                }
            }
        }
        Ok(match first_event {
            Some(on) => Executed::Evented(on),
            None => Executed::Plain,
        })
    }

    // ─────────────────────────────────────────────────────────────────────
    // 接口派发(效果原语封闭集 v1;预算恒定,引擎管理调用 D4.2 ①)
    // ─────────────────────────────────────────────────────────────────────

    /// `call {interface}` 派发(装载校验保证已声明)。
    fn dispatch_interface(&mut self, interface_id: u32) -> Result<Option<u64>, ExecError> {
        let Some(def) = self.interfaces.get(&interface_id) else {
            return Err(ExecError::InvariantBroken(
                "interface 引用已在装载校验封闭(call 形态)",
            ));
        };
        let def = def.clone();
        self.run_effects(&def)
    }

    /// `syscall I ≥ 0x0100` 运行时派发(字节模式探测外 gadget 路径可未声明)。
    fn dispatch_syscall_id(&mut self, value: u64) -> Result<Option<u64>, ExecError> {
        let declared = u32::try_from(value)
            .ok()
            .filter(|id| (INTERFACE_ID_MIN..=INTERFACE_ID_MAX).contains(id))
            .and_then(|id| self.interfaces.get(&id).cloned());
        match declared {
            Some(def) => self.run_effects(&def),
            None => Err(ExecError::InvalidSyscallDispatch { value }),
        }
    }

    /// 执行效果序列;返回 `Some(exit 码)` = 程序终止。
    /// 步耗 = 声明条数(恒定,与是否提前 exit 无关);`exit` 后剩余效果跳过。
    fn run_effects(&mut self, def: &InterfaceDef) -> Result<Option<u64>, ExecError> {
        self.state
            .constraints
            .steps
            .charge(def.effects.len() as u64)
            .map_err(ExecError::ResourceLimit)?;
        for effect in &def.effects {
            match effect {
                EffectPrimitive::Exit => {
                    self.halted = true;
                    return Ok(Some(0));
                }
                EffectPrimitive::GrantVirtualFile { file_id } => {
                    self.log_event(
                        VmEventKind::FileGranted,
                        None,
                        Some(file_id.len() as u64),
                        Some(file_id.as_bytes().to_vec()),
                    );
                }
                EffectPrimitive::VirtualFileRead { file_id } => {
                    self.log_event(
                        VmEventKind::FileRead,
                        None,
                        Some(file_id.len() as u64),
                        Some(file_id.as_bytes().to_vec()),
                    );
                }
                EffectPrimitive::SetFlag {
                    flag_register,
                    value,
                } => {
                    self.write_reg(flag_register, *value)?;
                }
                EffectPrimitive::Noop => {}
            }
        }
        Ok(None)
    }

    // ─────────────────────────────────────────────────────────────────────
    // 基础原语
    // ─────────────────────────────────────────────────────────────────────

    fn read_reg(&self, name: &str) -> Result<ArchValue, ExecError> {
        self.state
            .registers
            .get(name)
            .ok_or(ExecError::InvariantBroken("寄存器引用已在装载校验封闭"))
    }

    fn write_reg(&mut self, name: &str, value: ArchValue) -> Result<(), ExecError> {
        self.state
            .registers
            .set(name, value)
            .map_err(|_| ExecError::InvariantBroken("寄存器引用已在装载校验封闭"))
    }

    /// 有效地址 = base(缺省 0)+ 有符号位移(补码形态),模 2^archBits。
    fn effective_address(
        &self,
        base: &Option<String>,
        displacement: ArchValue,
    ) -> Result<ArchValue, ExecError> {
        let base_val = match base {
            Some(name) => self.read_reg(name)?,
            None => ArchValue::ZERO,
        };
        Ok(base_val.add(displacement, self.arch()))
    }

    /// 写执行位置:instructionPointer 与 RIP 寄存器同一语义,统一同步。
    fn set_ip(&mut self, ip: u64) -> Result<(), ExecError> {
        let value = ArchValue::new(ip, self.arch());
        self.state.instruction_pointer = value;
        self.write_reg("RIP", value)
    }

    fn log_event(
        &mut self,
        kind: VmEventKind,
        address: Option<u64>,
        byte_length: Option<u64>,
        payload: Option<Vec<u8>>,
    ) {
        let arch = self.arch();
        let seq = self.state.private_event_log.len() as u64;
        self.state.private_event_log.push(VmEvent {
            seq,
            kind,
            address: address.map(|a| ArchValue::new(a, arch)),
            byte_length,
            payload,
        });
    }
}

/// 指令执行结局(引擎内部)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Executed {
    /// 无暂停类事件(算术 / 跳转 / 寄存器传送 / syscall 接口派发)。
    Plain,
    /// 产生了 read / write / call / ret 主事件(`pauseOn` 比对源)。
    Evented(PauseOn),
    /// 程序终止(内置 `exit(I)` 或接口 `exit` 效果)。
    Exited { code: u64 },
}

fn invariant() -> ExecError {
    ExecError::InvariantBroken("操作数形态已由冻结表在装载校验封闭")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instr::{BitLogic, EncodingOperandShape, EncodingTableEntry, MicroOp};
    use crate::memory::{ExecutionMode, Permissions, RegionContents, RegionKind, RegionSpec};
    use crate::state::{Budget, CumulativeBudget, RuntimeConstraints, SeedState, SeedStrategy};
    use alloc::vec;

    const A32: ArchBits = ArchBits::B32;
    const A64: ArchBits = ArchBits::B64;
    const CODE_BASE: u64 = 0x0040_0000;
    const STACK_LEN: u64 = 4096;
    const STACK_TOP32: u64 = 0x7FFF_FFF8;

    fn stack_base(arch: ArchBits) -> u64 {
        match arch {
            ArchBits::B32 => 0x7FFF_F000,
            ArchBits::B64 => 0x7FFF_FFFF_FFFF_F000,
        }
    }

    fn stack_top(arch: ArchBits) -> u64 {
        match arch {
            ArchBits::B32 => STACK_TOP32,
            ArchBits::B64 => 0x7FFF_FFFF_FFFF_FFF8,
        }
    }

    fn constraints(steps_limit: u64) -> RuntimeConstraints {
        RuntimeConstraints {
            steps: Budget::new(0, steps_limit),
            memory_bytes_limit: 64 * 1024 * 1024,
            wall_clock_ms_limit: 5_000,
            call_depth_limit: 64,
            action_log: Budget::new(0, 10_000),
            output_bytes: Budget::new(0, 4096),
            timeout_ms_limit: 1_000,
            predicate_evals: CumulativeBudget::new(0, 100),
            rollback_ops: Budget::new(0, 200),
        }
    }

    fn seed() -> SeedState {
        SeedState {
            strategy: SeedStrategy::Fixed,
            version: 1,
            state_bytes: vec![0xAA, 0xBB],
        }
    }

    fn state_config(
        arch: ArchBits,
        mode: ExecutionMode,
        code_bytes: &[u8],
        initial_ip: u64,
        steps_limit: u64,
    ) -> VmStateConfig {
        let regions = vec![
            RegionSpec::new(
                "code",
                RegionKind::Code,
                None,
                CODE_BASE,
                4096,
                Permissions::parse("rx").unwrap(),
                arch,
            )
            .unwrap(),
            RegionSpec::new(
                "stack",
                RegionKind::Stack,
                None,
                stack_base(arch),
                STACK_LEN,
                Permissions::parse("rw").unwrap(),
                arch,
            )
            .unwrap(),
        ];
        VmStateConfig {
            arch,
            execution_mode: mode,
            page_size: 4096,
            regions,
            region_contents: vec![
                RegionContents {
                    region_id: String::from("code"),
                    bytes: code_bytes.to_vec(),
                },
                RegionContents {
                    region_id: String::from("stack"),
                    bytes: vec![],
                },
            ],
            registers: vec![
                (String::from("RSP"), ArchValue::new(stack_top(arch), arch)),
                (String::from("RBP"), ArchValue::new(stack_top(arch), arch)),
                (String::from("RIP"), ArchValue::new(initial_ip, arch)),
                (String::from("RAX"), ArchValue::new(0, arch)),
                (String::from("RBX"), ArchValue::new(0, arch)),
                (String::from("FLAG_KEY"), ArchValue::new(0, arch)),
            ],
            flag_register_names: vec![String::from("FLAG_KEY")],
            initial_instruction_pointer: ArchValue::new(initial_ip, arch),
            constraints: constraints(steps_limit),
            seed_state: seed(),
        }
    }

    // 指令构造速记
    fn r(name: &str) -> Operand {
        Operand::Register(String::from(name))
    }
    fn i(raw: i64, arch: ArchBits) -> Operand {
        Operand::Immediate(ArchValue::from_signed(raw, arch))
    }
    fn m(base: Option<&str>, disp: i64, arch: ArchBits) -> Operand {
        Operand::Memory {
            base: base.map(String::from),
            displacement: ArchValue::from_signed(disp, arch),
        }
    }
    fn f(id: u32) -> Operand {
        Operand::Interface(id)
    }
    fn ins(op: BaselineOp, operands: Vec<Operand>) -> Instruction {
        Instruction {
            op: Op::Baseline(op),
            operands,
        }
    }
    fn custom_ins(mnemonic: &str) -> Instruction {
        Instruction {
            op: Op::Custom(String::from(mnemonic)),
            operands: vec![],
        }
    }

    fn ir_engine(arch: ArchBits, instructions: Vec<Instruction>) -> Engine {
        ir_engine_with(arch, instructions, 100_000, vec![], vec![], vec![])
    }

    fn ir_engine_with(
        arch: ArchBits,
        instructions: Vec<Instruction>,
        steps_limit: u64,
        custom: Vec<CustomInstructionDef>,
        ifaces: Vec<InterfaceDef>,
        canaries: Vec<CanarySlotSpec>,
    ) -> Engine {
        Engine::new(EngineConfig {
            state: state_config(arch, ExecutionMode::Ir, &[], 0, steps_limit),
            program: Program::Ir {
                instructions,
                entrypoint_index: 0,
            },
            custom_instructions: custom,
            interfaces: ifaces,
            canary_slots: canaries,
        })
        .unwrap()
    }

    fn event_kinds(engine: &Engine) -> Vec<VmEventKind> {
        engine
            .state
            .private_event_log
            .iter()
            .map(|e| e.kind)
            .collect()
    }

    fn reg(engine: &Engine, name: &str) -> u64 {
        engine.state.registers.get(name).unwrap().get()
    }

    // ─────────────────────────────────────────────────────────────────────
    // 完整调用闭环:call → 序言 → 局部内存 → leave → ret → exit(13.1 栈帧 / 调用)
    // ─────────────────────────────────────────────────────────────────────

    /// 跨模式一致性基准程序(见 cross_mode_execution_trace_consistency):
    /// mov RAX,0x1234; call func; syscall exit(0);
    /// func: push RBP; mov RBP,RSP; mov [RBP-8],RAX; leave; ret。
    fn canonical_ir_program(arch: ArchBits) -> Vec<Instruction> {
        vec![
            ins(BaselineOp::Mov, vec![r("RAX"), i(0x1234, arch)]),
            ins(BaselineOp::Call, vec![i(3, arch)]),
            ins(BaselineOp::Syscall, vec![i(0, arch)]),
            ins(BaselineOp::Push, vec![r("RBP")]),
            ins(BaselineOp::Mov, vec![r("RBP"), r("RSP")]),
            ins(BaselineOp::Mov, vec![m(Some("RBP"), -8, arch), r("RAX")]),
            ins(BaselineOp::Leave, vec![]),
            ins(BaselineOp::Ret, vec![]),
        ]
    }

    #[test]
    fn ir_canonical_call_epilogue_full_trace() {
        let mut e = ir_engine(A32, canonical_ir_program(A32));
        // 0: mov RAX,0x1234
        assert!(matches!(e.step(), RunOutcome::Stepped));
        assert_eq!(reg(&e, "RAX"), 0x1234);
        assert_eq!(reg(&e, "RIP"), 1, "RIP 寄存器与执行位置同步");
        assert_eq!(e.state.instruction_pointer.get(), 1);
        // 1: call 3 → 返回地址 2 入栈、调用帧创建
        assert!(matches!(e.step(), RunOutcome::Stepped));
        assert_eq!(reg(&e, "RSP"), STACK_TOP32 - 8);
        assert_eq!(reg(&e, "RIP"), 3);
        assert_eq!(e.state.call_frames.len(), 1);
        let frame = e.state.call_frames[0].clone();
        assert_eq!(frame.return_address.get(), 2);
        assert_eq!(frame.saved_rbp.get(), STACK_TOP32);
        assert_eq!(frame.function_label, "0x3");
        // 3: push RBP
        assert!(matches!(e.step(), RunOutcome::Stepped));
        assert_eq!(reg(&e, "RSP"), STACK_TOP32 - 16);
        // 4: mov RBP,RSP
        assert!(matches!(e.step(), RunOutcome::Stepped));
        assert_eq!(reg(&e, "RBP"), STACK_TOP32 - 16);
        // 5: mov [RBP-8],RAX(4 字节小端写入 + 32 位掩蔽)
        assert!(matches!(e.step(), RunOutcome::Stepped));
        let slot = ArchValue::new(STACK_TOP32 - 24, A32);
        assert_eq!(
            e.state.memory.read(slot, 8).unwrap(),
            vec![0x34, 0x12, 0, 0, 0, 0, 0, 0]
        );
        // 6: leave(RSP←RBP、pop RBP、返回地址槽校验通过)
        assert!(matches!(e.step(), RunOutcome::Stepped));
        assert_eq!(reg(&e, "RBP"), STACK_TOP32);
        assert_eq!(reg(&e, "RSP"), STACK_TOP32 - 8);
        // 7: ret → 返回 2
        assert!(matches!(e.step(), RunOutcome::Stepped));
        assert_eq!(reg(&e, "RIP"), 2);
        assert_eq!(reg(&e, "RSP"), STACK_TOP32);
        assert!(e.state.call_frames.is_empty(), "影子调用帧随 ret 弹出");
        // 2: syscall exit(0)
        assert_eq!(e.step(), RunOutcome::Exited { code: 0 });
        assert!(e.is_halted());
        assert_eq!(e.step(), RunOutcome::Halted, "exit 后不再执行");
        // 事件序:Call, Write(push rbp), Write(store), Read(leave), Ret, Syscall。
        assert_eq!(
            event_kinds(&e),
            vec![
                VmEventKind::Call,
                VmEventKind::Write,
                VmEventKind::Write,
                VmEventKind::Read,
                VmEventKind::Ret,
                VmEventKind::Syscall,
            ]
        );
        // 每条指令恰 1 步(共 8 条)。
        assert_eq!(e.state.constraints.steps.used, 8);
        // 状态保持 running(halted 标记停执行;won/failed 判定归 WP-5)。
        assert_eq!(e.state.status, VmStatus::Running);
    }

    #[test]
    fn engine_init_syncs_rip_register_and_rejects_bad_programs() {
        // 装载即同步 RIP 寄存器 = instructionPointer。
        let e = ir_engine(A32, vec![ins(BaselineOp::Ret, vec![])]);
        assert_eq!(reg(&e, "RIP"), 0);
        // 未声明 syscall 派发号:装载即拒(XS-SYSCALL-DECL 引擎镜像)。
        let err = Engine::new(EngineConfig {
            state: state_config(A32, ExecutionMode::Ir, &[], 0, 100),
            program: Program::Ir {
                instructions: vec![ins(BaselineOp::Syscall, vec![i(0x9999, A32)])],
                entrypoint_index: 0,
            },
            custom_instructions: vec![],
            interfaces: vec![],
            canary_slots: vec![],
        })
        .unwrap_err();
        assert!(matches!(
            err,
            EngineInitError::Program(ProgramError::UndeclaredSyscallNumber { value: 0x9999, .. })
        ));
        // 入口索引出界。
        let err = Engine::new(EngineConfig {
            state: state_config(A32, ExecutionMode::Ir, &[], 0, 100),
            program: Program::Ir {
                instructions: vec![ins(BaselineOp::Ret, vec![])],
                entrypoint_index: 1,
            },
            custom_instructions: vec![],
            interfaces: vec![],
            canary_slots: vec![],
        })
        .unwrap_err();
        assert!(matches!(
            err,
            EngineInitError::Program(ProgramError::EntrypointIndexOutOfRange { index: 1, .. })
        ));
        // Canary 槽位不可读(未映射地址)。
        let err = Engine::new(EngineConfig {
            state: state_config(A32, ExecutionMode::Ir, &[], 0, 100),
            program: Program::Ir {
                instructions: vec![ins(BaselineOp::Ret, vec![])],
                entrypoint_index: 0,
            },
            custom_instructions: vec![],
            interfaces: vec![],
            canary_slots: vec![CanarySlotSpec {
                address: 0x9000_0000,
                byte_length: 4,
            }],
        })
        .unwrap_err();
        assert!(matches!(
            err,
            EngineInitError::CanarySlotUnreadable {
                address: 0x9000_0000
            }
        ));
    }

    // ─────────────────────────────────────────────────────────────────────
    // 算术 / 位运算 / 标志(双位宽矩阵;cmp 不写回;逻辑类 cf 不动;移位取模)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn arithmetic_flags_matrix_both_widths() {
        for arch in [A32, A64] {
            let mask = arch.mask();
            // add 溢出:掩蔽域回绕 + cf 置位 + zf 置位。
            let mut e = ir_engine(
                arch,
                vec![
                    ins(BaselineOp::Mov, vec![r("RAX"), i(-1, arch)]), // 掩蔽 = 全 1
                    ins(BaselineOp::Add, vec![r("RAX"), i(1, arch)]),
                ],
            );
            e.step();
            e.step();
            assert_eq!(reg(&e, "RAX"), 0, "{arch:?} 模 2^n 回绕");
            assert!(e.state.registers.flags.zf);
            assert!(e.state.registers.flags.cf);
            assert!(!e.state.registers.flags.sf);
            // sub 借位:0 − 1 → 全 1,cf / sf 置位。
            let mut e = ir_engine(
                arch,
                vec![
                    ins(BaselineOp::Mov, vec![r("RAX"), i(0, arch)]),
                    ins(BaselineOp::Sub, vec![r("RAX"), i(1, arch)]),
                ],
            );
            e.step();
            e.step();
            assert_eq!(reg(&e, "RAX"), mask);
            let flags = e.state.registers.flags;
            assert!(!flags.zf && flags.cf && flags.sf, "{arch:?}");
            // shl 符号位:1 << (bits−1)。
            let sign_raw: u64 = if arch == A32 {
                0x8000_0000
            } else {
                0x8000_0000_0000_0000
            };
            let mut e = ir_engine(
                arch,
                vec![
                    ins(BaselineOp::Mov, vec![r("RAX"), i(1, arch)]),
                    ins(
                        BaselineOp::Shl,
                        vec![r("RAX"), i((arch.bits() - 1) as i64, arch)],
                    ),
                ],
            );
            e.step();
            e.step();
            assert_eq!(reg(&e, "RAX"), sign_raw);
            assert!(e.state.registers.flags.sf && !e.state.registers.flags.zf);
        }
    }

    #[test]
    fn cmp_sets_flags_without_writeback() {
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Mov, vec![r("RAX"), i(5, A32)]),
                ins(BaselineOp::Cmp, vec![r("RAX"), i(7, A32)]),
            ],
        );
        e.step();
        e.step();
        assert_eq!(reg(&e, "RAX"), 5, "cmp 不写回");
        let flags = e.state.registers.flags;
        assert!(
            !flags.zf && flags.cf && flags.sf,
            "5 − 7 = −2 补码符号位为 1"
        );
        // 相等 → zf、无借位、非负。
        let mut e = ir_engine(A32, vec![ins(BaselineOp::Cmp, vec![r("RAX"), i(0, A32)])]);
        e.step();
        let flags = e.state.registers.flags;
        assert!(flags.zf && !flags.cf && !flags.sf);
    }

    #[test]
    fn logic_ops_set_zf_sf_but_keep_cf() {
        // 先由 add 置 cf,再 and / xor——cf 必须保持(冻结表标志列 "zf sf")。
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Mov, vec![r("RAX"), i(-1, A32)]),
                ins(BaselineOp::Add, vec![r("RAX"), i(1, A32)]), // cf = 1
                ins(BaselineOp::Mov, vec![r("RBX"), i(0xF0F0, A32)]),
                ins(BaselineOp::And, vec![r("RBX"), i(0x0FF0, A32)]), // = 0x00F0
                ins(BaselineOp::Xor, vec![r("RBX"), i(0x00F0, A32)]), // = 0
            ],
        );
        for _ in 0..5 {
            e.step();
        }
        assert!(e.state.registers.flags.cf, "逻辑类不动 cf");
        assert!(e.state.registers.flags.zf, "xor 归零");
        assert_eq!(reg(&e, "RBX"), 0);
        // or 值行为。
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Mov, vec![r("RAX"), i(0xF0, A32)]),
                ins(BaselineOp::Or, vec![r("RAX"), i(0x0F, A32)]),
            ],
        );
        e.step();
        e.step();
        assert_eq!(reg(&e, "RAX"), 0xFF);
    }

    #[test]
    fn shift_amount_is_taken_modulo_archbits() {
        // 32 位:1 << 32 ≡ 1 << 0(移位量按 archBits 取模)。
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Mov, vec![r("RAX"), i(1, A32)]),
                ins(BaselineOp::Shl, vec![r("RAX"), i(32, A32)]),
            ],
        );
        e.step();
        e.step();
        assert_eq!(reg(&e, "RAX"), 1);
        // 1 << 31 = 符号位。
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Mov, vec![r("RAX"), i(1, A32)]),
                ins(BaselineOp::Shl, vec![r("RAX"), i(31, A32)]),
            ],
        );
        e.step();
        e.step();
        assert_eq!(reg(&e, "RAX"), 0x8000_0000);
        // shr:0x8000_0000 >> 31 = 1(逻辑右移高位补零)。
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Mov, vec![r("RAX"), i(0x8000_0000, A32)]),
                ins(BaselineOp::Shr, vec![r("RAX"), i(31, A32)]),
            ],
        );
        e.step();
        e.step();
        assert_eq!(reg(&e, "RAX"), 1);
        // 64 位:<< 64 取模为 0。
        let mut e = ir_engine(
            A64,
            vec![
                ins(BaselineOp::Mov, vec![r("RAX"), i(7, A64)]),
                ins(BaselineOp::Shl, vec![r("RAX"), i(64, A64)]),
            ],
        );
        e.step();
        e.step();
        assert_eq!(reg(&e, "RAX"), 7);
    }

    #[test]
    fn arithmetic_with_memory_operand_reads_arch_width() {
        // mov RAX,[RBX] 读取 → add RAX,[RBX](R,M 形态读 archBits/8 字节)。
        let mut e = ir_engine(
            A32,
            vec![
                ins(
                    BaselineOp::Mov,
                    vec![r("RBX"), i(STACK_TOP32 as i64 - 8, A32)],
                ),
                ins(BaselineOp::Mov, vec![r("RAX"), m(Some("RBX"), 0, A32)]),
                ins(BaselineOp::Add, vec![r("RAX"), m(Some("RBX"), 0, A32)]),
            ],
        );
        e.action_write_bytes(ArchValue::new(STACK_TOP32 - 8, A32), &0x10u32.to_le_bytes())
            .unwrap();
        e.step();
        e.step();
        assert_eq!(reg(&e, "RAX"), 0x10);
        e.step();
        assert_eq!(reg(&e, "RAX"), 0x20);
        let reads = e
            .state
            .private_event_log
            .iter()
            .filter(|ev| ev.kind == VmEventKind::Read)
            .count();
        assert_eq!(reads, 2);
    }

    // ─────────────────────────────────────────────────────────────────────
    // 控制流:jmp 三形态 / 条件跳转消费标志
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn conditional_jumps_consume_flags() {
        // cmp 0,0 → zf=1 → je 跳过 exit。
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Cmp, vec![r("RAX"), i(0, A32)]), // 0
                ins(BaselineOp::Je, vec![i(3, A32)]),            // 1
                ins(BaselineOp::Syscall, vec![i(1, A32)]),       // 2(不应到达)
                ins(BaselineOp::Ret, vec![]),                    // 3
            ],
        );
        e.step();
        e.step();
        assert_eq!(reg(&e, "RIP"), 3, "je zf=1 跳转");
        // jne 不跳(zf=1)。
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Cmp, vec![r("RAX"), i(0, A32)]),
                ins(BaselineOp::Jne, vec![i(3, A32)]),
                ins(BaselineOp::Ret, vec![]),
            ],
        );
        e.step();
        e.step();
        assert_eq!(reg(&e, "RIP"), 2);
        // jb / jae 消费 cf:0−1 借位。
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Mov, vec![r("RAX"), i(0, A32)]),
                ins(BaselineOp::Cmp, vec![r("RAX"), i(1, A32)]),
                ins(BaselineOp::Jb, vec![i(4, A32)]),
                ins(BaselineOp::Ret, vec![]),
                ins(BaselineOp::Ret, vec![]), // 4
            ],
        );
        e.step();
        e.step();
        e.step();
        assert_eq!(reg(&e, "RIP"), 4, "jb cf=1 跳转");
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Cmp, vec![r("RAX"), i(1, A32)]),
                ins(BaselineOp::Jae, vec![i(3, A32)]),
                ins(BaselineOp::Ret, vec![]),
            ],
        );
        e.step();
        e.step();
        assert_eq!(reg(&e, "RIP"), 2, "jae cf=1 不跳");
    }

    #[test]
    fn jmp_register_and_memory_forms() {
        // jmp R:寄存器承载目标。
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Mov, vec![r("RAX"), i(3, A32)]),
                ins(BaselineOp::Jmp, vec![r("RAX")]),
                ins(BaselineOp::Ret, vec![]),
                ins(BaselineOp::Ret, vec![]), // 3
            ],
        );
        e.step();
        e.step();
        assert_eq!(reg(&e, "RIP"), 3);
        // jmp M:从栈内存读目标(Read 事件)。
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Push, vec![i(4, A32)]),
                ins(BaselineOp::Mov, vec![r("RBX"), r("RSP")]),
                ins(BaselineOp::Jmp, vec![m(Some("RBX"), 0, A32)]),
                ins(BaselineOp::Ret, vec![]), // 3(跳过)
                ins(BaselineOp::Ret, vec![]), // 4
            ],
        );
        e.step();
        e.step();
        e.step();
        assert_eq!(reg(&e, "RIP"), 4);
        assert!(
            e.state
                .private_event_log
                .iter()
                .any(|ev| ev.kind == VmEventKind::Read),
            "jmp M 的内存读发 Read 事件"
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // 栈语义:定宽 8 字节槽 / push/pop / 越权 memory_fault / leave 红灯
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn push_pop_use_fixed_8_byte_slots_at_both_widths() {
        for arch in [A32, A64] {
            let top = stack_top(arch);
            let mut e = ir_engine(
                arch,
                vec![
                    ins(BaselineOp::Push, vec![i(0xDEAD_BEEF, arch)]),
                    ins(BaselineOp::Pop, vec![r("RBX")]),
                ],
            );
            e.step();
            assert_eq!(reg(&e, "RSP"), top - 8, "{arch:?} 栈槽定宽 8 字节");
            let raw = e
                .state
                .memory
                .read(ArchValue::new(top - 8, arch), 8)
                .unwrap();
            assert_eq!(raw, 0xDEAD_BEEFu64.to_le_bytes().to_vec());
            e.step();
            assert_eq!(reg(&e, "RBX"), 0xDEAD_BEEF & arch.mask());
            assert_eq!(reg(&e, "RSP"), top);
        }
    }

    #[test]
    fn push_into_unmapped_stack_fails_memory_fault() {
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Mov, vec![r("RSP"), i(0x6000_0000, A32)]),
                ins(BaselineOp::Push, vec![i(1, A32)]),
            ],
        );
        e.step();
        assert!(matches!(
            e.step(),
            RunOutcome::Failed {
                error: ExecError::MemoryFault(_),
            }
        ));
        assert_eq!(e.state.status, VmStatus::Failed);
        assert_eq!(
            e.state.private_event_log.last().map(|ev| ev.kind),
            Some(VmEventKind::Exception)
        );
    }

    #[test]
    fn ir_fall_off_end_is_invalid_rip() {
        let mut e = ir_engine(A32, vec![ins(BaselineOp::Push, vec![i(1, A32)])]);
        e.step();
        assert!(matches!(
            e.step(),
            RunOutcome::Failed {
                error: ExecError::InvalidRip { address: 1 },
            }
        ));
    }

    #[test]
    fn leave_with_corrupted_frame_reports_invalid_rip() {
        // 教学主场景:saved RBP 被覆写 → leave 后 RSP 被劫持 → 返回地址槽
        // 读出的值不可执行 → invalid_rip(leave 即报,G4 裁决原文)。
        let mut e = ir_engine(
            A32,
            vec![
                ins(
                    BaselineOp::Mov,
                    vec![r("RBX"), i((STACK_TOP32 - 64) as i64, A32)],
                ),
                ins(BaselineOp::Mov, vec![r("RBP"), r("RBX")]),
                ins(BaselineOp::Leave, vec![]),
                ins(BaselineOp::Ret, vec![]),
            ],
        );
        e.action_write_bytes(
            ArchValue::new(STACK_TOP32 - 64, A32),
            &(STACK_TOP32 as u32).to_le_bytes(),
        )
        .unwrap();
        e.action_write_bytes(
            ArchValue::new(STACK_TOP32 - 56, A32),
            &0x9999u32.to_le_bytes(),
        )
        .unwrap();
        e.step(); // mov RBX
        e.step(); // mov RBP,RBX
        // leave:RSP←RBP;pop RBP(读到栈顶值);[RSP] = 0x9999 索引域外 → invalid_rip。
        assert!(matches!(
            e.step(),
            RunOutcome::Failed {
                error: ExecError::InvalidRip { address: 0x9999 },
            }
        ));
    }

    #[test]
    fn ret_without_call_is_lenient_on_shadow_frame() {
        // 影子栈为空不阻拦 ret:弹出的返回地址合法即成功(pwn 教学核心路径)。
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Push, vec![i(3, A32)]),
                ins(BaselineOp::Ret, vec![]), // 1:弹 3
                ins(BaselineOp::Ret, vec![]),
                ins(BaselineOp::Ret, vec![]), // 3
            ],
        );
        e.step();
        assert!(matches!(e.step(), RunOutcome::Stepped));
        assert_eq!(reg(&e, "RIP"), 3);
        assert!(e.state.call_frames.is_empty());
        // 弹出值非执行位(索引域外)→ invalid_rip。
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Push, vec![i(0x99, A32)]),
                ins(BaselineOp::Ret, vec![]), // 1:弹 0x99 → 红灯
            ],
        );
        e.step();
        assert!(matches!(
            e.step(),
            RunOutcome::Failed {
                error: ExecError::InvalidRip { address: 0x99 },
            }
        ));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Canary(13.1:破坏检测 canary_violation,先于栈语义)
    // ─────────────────────────────────────────────────────────────────────

    fn canary_engine() -> Engine {
        let canary_addr = STACK_TOP32 - 0x20;
        let mut e = ir_engine_with(
            A32,
            vec![
                ins(
                    BaselineOp::Mov,
                    vec![r("RBP"), i((canary_addr + 4) as i64, A32)],
                ),
                ins(BaselineOp::Leave, vec![]),
            ],
            1000,
            vec![],
            vec![],
            vec![CanarySlotSpec {
                address: canary_addr,
                byte_length: 4,
            }],
        );
        // 预置 [RBP] = saved RBP(栈顶)、[RBP+8] = 返回地址 1(IR 索引,合法)。
        e.action_write_bytes(
            ArchValue::new(canary_addr + 4, A32),
            &(STACK_TOP32 as u32).to_le_bytes(),
        )
        .unwrap();
        e.action_write_bytes(ArchValue::new(canary_addr + 12, A32), &1u32.to_le_bytes())
            .unwrap();
        e
    }

    #[test]
    fn canary_intact_allows_epilogue() {
        let mut e = canary_engine();
        assert!(matches!(e.step(), RunOutcome::Stepped)); // mov RBP
        assert!(matches!(e.step(), RunOutcome::Stepped)); // leave 通过
        assert_eq!(reg(&e, "RBP"), STACK_TOP32);
    }

    #[test]
    fn canary_corruption_fails_leave_and_ret() {
        // leave 路径:破坏 canary → canary_violation(先于栈语义)。
        let mut e = canary_engine();
        e.action_write_bytes(
            ArchValue::new(STACK_TOP32 - 0x20, A32),
            &[0x41, 0x41, 0x41, 0x41],
        )
        .unwrap();
        e.step(); // mov RBP
        assert!(matches!(
            e.step(),
            RunOutcome::Failed {
                error: ExecError::CanaryViolation {
                    address,
                    byte_length: 4,
                },
            } if address == STACK_TOP32 - 0x20
        ));
        // ret 路径同样检测。
        let canary_addr = STACK_TOP32 - 0x20;
        let mut e = ir_engine_with(
            A32,
            vec![
                ins(BaselineOp::Push, vec![i(1, A32)]),
                ins(BaselineOp::Ret, vec![]),
            ],
            1000,
            vec![],
            vec![],
            vec![CanarySlotSpec {
                address: canary_addr,
                byte_length: 4,
            }],
        );
        e.action_write_bytes(ArchValue::new(canary_addr, A32), &[0x99, 0x99, 0x99, 0x99])
            .unwrap();
        e.step(); // push 返回地址 1
        assert!(matches!(
            e.step(),
            RunOutcome::Failed {
                error: ExecError::CanaryViolation { .. },
            }
        ));
    }

    // ─────────────────────────────────────────────────────────────────────
    // syscall / 接口派发(D4.2 ① 引擎管理调用;效果原语封闭集)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn syscall_builtin_exit_codes_and_halting() {
        for code in [0u64, 1, 0x7F, 0xFF] {
            let mut e = ir_engine(
                A32,
                vec![ins(BaselineOp::Syscall, vec![i(code as i64, A32)])],
            );
            assert_eq!(e.step(), RunOutcome::Exited { code }, "exit({code:#x})");
            assert!(e.is_halted());
            assert_eq!(e.step(), RunOutcome::Halted);
            assert_eq!(
                e.state.private_event_log.last().map(|ev| ev.kind),
                Some(VmEventKind::Syscall)
            );
        }
    }

    fn iface_defs() -> Vec<InterfaceDef> {
        vec![
            InterfaceDef {
                interface_id: 0x100,
                display_text: String::from("grant"),
                effects: vec![
                    EffectPrimitive::GrantVirtualFile {
                        file_id: String::from("notes.txt"),
                    },
                    EffectPrimitive::VirtualFileRead {
                        file_id: String::from("notes.txt"),
                    },
                    EffectPrimitive::SetFlag {
                        flag_register: String::from("FLAG_KEY"),
                        value: ArchValue::new(7, A32),
                    },
                    EffectPrimitive::Noop,
                ],
            },
            InterfaceDef {
                interface_id: 0x200,
                display_text: String::from("die"),
                effects: vec![EffectPrimitive::Exit],
            },
        ]
    }

    #[test]
    fn syscall_interface_dispatch_runs_effects() {
        let mut e = ir_engine_with(
            A32,
            vec![
                ins(BaselineOp::Syscall, vec![i(0x100, A32)]),
                ins(BaselineOp::Syscall, vec![i(0, A32)]),
            ],
            1000,
            vec![],
            iface_defs(),
            vec![],
        );
        assert!(matches!(e.step(), RunOutcome::Stepped), "派发后继续执行");
        assert!(!e.is_halted());
        assert_eq!(reg(&e, "FLAG_KEY"), 7, "set_flag 效果置 FLAG 汇");
        assert_eq!(reg(&e, "RIP"), 1);
        let kinds = event_kinds(&e);
        assert_eq!(kinds[0], VmEventKind::Syscall);
        assert_eq!(kinds[1], VmEventKind::FileGranted);
        assert_eq!(kinds[2], VmEventKind::FileRead);
        assert_eq!(
            e.state.private_event_log[1].payload.as_deref(),
            Some(b"notes.txt".as_slice())
        );
        // 步耗 = 指令 1 + 效果 4(恒定)。
        assert_eq!(e.state.constraints.steps.used, 5);
        assert_eq!(e.step(), RunOutcome::Exited { code: 0 });
    }

    #[test]
    fn interface_exit_effect_halts_with_code_zero() {
        let mut e = ir_engine_with(
            A32,
            vec![ins(BaselineOp::Syscall, vec![i(0x200, A32)])],
            1000,
            vec![],
            iface_defs(),
            vec![],
        );
        assert_eq!(e.step(), RunOutcome::Exited { code: 0 });
        assert!(e.is_halted());
    }

    #[test]
    fn call_interface_operand_is_engine_managed() {
        // D4.2 ①:不压玩家栈(RSP 不动)、不建调用帧、执行效果后返回下一条。
        let mut e = ir_engine_with(
            A32,
            vec![
                ins(BaselineOp::Call, vec![f(0x100)]),
                ins(BaselineOp::Ret, vec![]),
            ],
            1000,
            vec![],
            iface_defs(),
            vec![],
        );
        let rsp_before = reg(&e, "RSP");
        assert!(matches!(e.step(), RunOutcome::Stepped));
        assert_eq!(reg(&e, "RSP"), rsp_before, "接口调用不占玩家栈");
        assert!(e.state.call_frames.is_empty(), "不建调用帧");
        assert_eq!(reg(&e, "RIP"), 1, "返回下一条指令");
        assert_eq!(reg(&e, "FLAG_KEY"), 7);
        assert_eq!(event_kinds(&e)[0], VmEventKind::Call, "派发记 Call 事件");
    }

    #[test]
    fn call_depth_limit_is_resource_limit() {
        let mut config = state_config(A32, ExecutionMode::Ir, &[], 0, 1000);
        config.constraints.call_depth_limit = 3;
        let mut e = Engine::new(EngineConfig {
            state: config,
            program: Program::Ir {
                instructions: vec![
                    ins(BaselineOp::Call, vec![i(0, A32)]),
                    ins(BaselineOp::Ret, vec![]),
                ],
                entrypoint_index: 0,
            },
            custom_instructions: vec![],
            interfaces: vec![],
            canary_slots: vec![],
        })
        .unwrap();
        assert!(matches!(
            e.run_to_event(PauseOn::Ret),
            RunOutcome::Failed {
                error: ExecError::ResourceLimit(_),
            }
        ));
        assert_eq!(e.state.call_frames.len(), 3);
    }

    // ─────────────────────────────────────────────────────────────────────
    // 自定义指令解释器(直线 / 恒定步数 / 统一权限路径)
    // ─────────────────────────────────────────────────────────────────────

    fn custom_defs() -> Vec<CustomInstructionDef> {
        vec![CustomInstructionDef {
            mnemonic: String::from("SAVER"),
            display_text: String::from("saver"),
            semantics: vec![
                MicroOp::LoadImm {
                    dst: String::from("RBX"),
                    value: ArchValue::new(0x77, A32),
                },
                MicroOp::StoreMem {
                    base: String::from("RBP"),
                    displacement: ArchValue::from_signed(-0x40, A32),
                    src: String::from("RBX"),
                },
                MicroOp::SetFlag {
                    flag_register: String::from("FLAG_KEY"),
                    value: ArchValue::new(1, A32),
                },
            ],
        }]
    }

    #[test]
    fn custom_instruction_straight_line_constant_steps() {
        let mut e = ir_engine_with(
            A32,
            vec![
                custom_ins("SAVER"),
                ins(BaselineOp::Syscall, vec![i(0, A32)]),
            ],
            1000,
            custom_defs(),
            vec![],
            vec![],
        );
        assert!(matches!(e.step(), RunOutcome::Stepped));
        assert_eq!(reg(&e, "RBX"), 0x77);
        assert_eq!(reg(&e, "FLAG_KEY"), 1);
        assert_eq!(
            e.state
                .memory
                .read_le(ArchValue::new(STACK_TOP32 - 0x40, A32), 4, A32)
                .unwrap()
                .get(),
            0x77
        );
        // 恒定步数 = 微算子条数(T-SC2:与操作数值无关)。
        assert_eq!(e.state.constraints.steps.used, 3);
        assert_eq!(event_kinds(&e), vec![VmEventKind::Write]);
    }

    #[test]
    fn custom_instruction_memory_access_uses_unified_rejection() {
        // 基址 + 位移 → 未映射:load_mem 走统一拒绝路径(I-9)。
        let defs = vec![CustomInstructionDef {
            mnemonic: String::from("LOADR"),
            display_text: String::from("loadr"),
            semantics: vec![MicroOp::LoadMem {
                dst: String::from("RAX"),
                base: String::from("RBP"),
                displacement: ArchValue::new(0x1000, A32),
            }],
        }];
        let mut e = ir_engine_with(A32, vec![custom_ins("LOADR")], 1000, defs, vec![], vec![]);
        assert!(matches!(
            e.step(),
            RunOutcome::Failed {
                error: ExecError::MemoryFault(_),
            }
        ));
    }

    #[test]
    fn custom_instruction_bitmask_micro_op() {
        let defs = vec![CustomInstructionDef {
            mnemonic: String::from("MASKR"),
            display_text: String::from("maskr"),
            semantics: vec![
                MicroOp::LoadImm {
                    dst: String::from("RAX"),
                    value: ArchValue::new(0xFF00_FFFF, A32),
                },
                MicroOp::BitMask {
                    dst: String::from("RBX"),
                    src: String::from("RAX"),
                    mask: ArchValue::new(0x00FF_FF00, A32),
                    logic: BitLogic::And,
                },
            ],
        }];
        let mut e = ir_engine_with(A32, vec![custom_ins("MASKR")], 1000, defs, vec![], vec![]);
        e.step();
        assert_eq!(reg(&e, "RBX"), 0xFF00_FFFF & 0x00FF_FF00);
    }

    // ─────────────────────────────────────────────────────────────────────
    // 预算与暂停(run_to_event 语义 / resource_limit / pause 动作)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn run_to_event_pauses_on_requested_event_kind() {
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Mov, vec![r("RAX"), i(5, A32)]), // 0 无事件
                ins(BaselineOp::Push, vec![r("RAX")]),           // 1 Write
                ins(BaselineOp::Pop, vec![r("RBX")]),            // 2 Read
                ins(BaselineOp::Cmp, vec![r("RAX"), i(0, A32)]), // 3 无事件
                ins(BaselineOp::Syscall, vec![i(0, A32)]),       // 4 exit
            ],
        );
        assert_eq!(
            e.run_to_event(PauseOn::Write),
            RunOutcome::Paused { on: PauseOn::Write }
        );
        assert_eq!(reg(&e, "RIP"), 2, "暂停在事件后边界");
        assert_eq!(e.state.status, VmStatus::Paused);
        assert_eq!(
            e.run_to_event(PauseOn::Read),
            RunOutcome::Paused { on: PauseOn::Read }
        );
        assert_eq!(reg(&e, "RIP"), 3);
        // 无匹配事件:跑到 exit。
        assert_eq!(
            e.run_to_event(PauseOn::Call),
            RunOutcome::Exited { code: 0 }
        );
    }

    #[test]
    fn run_to_event_call_and_ret_pause() {
        let mut e = ir_engine(
            A32,
            vec![
                ins(BaselineOp::Call, vec![i(2, A32)]), // 0
                ins(BaselineOp::Syscall, vec![i(0, A32)]),
                ins(BaselineOp::Ret, vec![]), // 2
            ],
        );
        assert_eq!(
            e.run_to_event(PauseOn::Call),
            RunOutcome::Paused { on: PauseOn::Call }
        );
        assert_eq!(reg(&e, "RIP"), 2);
        assert_eq!(
            e.run_to_event(PauseOn::Ret),
            RunOutcome::Paused { on: PauseOn::Ret }
        );
        assert_eq!(reg(&e, "RIP"), 1);
    }

    #[test]
    fn steps_budget_exhaustion_is_resource_limit() {
        let mut e = ir_engine_with(
            A32,
            vec![
                ins(BaselineOp::Mov, vec![r("RAX"), i(1, A32)]),
                ins(BaselineOp::Mov, vec![r("RAX"), i(2, A32)]),
                ins(BaselineOp::Mov, vec![r("RAX"), i(3, A32)]),
                ins(BaselineOp::Mov, vec![r("RAX"), i(4, A32)]),
            ],
            3,
            vec![],
            vec![],
            vec![],
        );
        // run_to_event 循环执行:前三条恰耗尽预算,第四条记账失败 → resource_limit。
        assert!(matches!(
            e.run_to_event(PauseOn::Call),
            RunOutcome::Failed {
                error: ExecError::ResourceLimit(_),
            }
        ));
        assert_eq!(e.state.constraints.steps.used, 3);
        assert_eq!(e.state.status, VmStatus::Failed);
        assert_eq!(e.step(), RunOutcome::Halted, "终态后不再执行");
    }

    #[test]
    fn pause_action_pauses_running_vm() {
        let mut e = ir_engine(A32, vec![ins(BaselineOp::Ret, vec![])]);
        e.pause();
        assert_eq!(e.state.status, VmStatus::Paused);
        assert!(matches!(e.step(), RunOutcome::Stepped));
        assert_eq!(e.state.status, VmStatus::Running);
        for (text, expected) in [
            ("read", PauseOn::Read),
            ("write", PauseOn::Write),
            ("call", PauseOn::Call),
            ("ret", PauseOn::Ret),
            ("exception", PauseOn::Exception),
        ] {
            assert_eq!(PauseOn::parse(text), Some(expected));
            assert_eq!(expected.as_str(), text);
        }
        assert_eq!(PauseOn::parse("syscall"), None, "伪 syscall 不是暂停事件");
    }

    // ─────────────────────────────────────────────────────────────────────
    // reset(13.1:reset 后同一轨迹确定性复现)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn reset_restores_initial_state_and_replays_identically() {
        let mut e = ir_engine(A32, canonical_ir_program(A32));
        let mut first = vec![];
        loop {
            let out = e.step();
            first.push(format!("{out:?}"));
            if !matches!(out, RunOutcome::Stepped) {
                break;
            }
        }
        let events_first = event_kinds(&e);
        let rax_first = reg(&e, "RAX");
        assert!(e.is_halted());
        e.reset();
        assert!(!e.is_halted());
        assert!(e.state.private_event_log.is_empty());
        assert_eq!(e.state.constraints.steps.used, 0);
        assert_eq!(reg(&e, "RAX"), 0);
        assert_eq!(reg(&e, "RIP"), 0);
        let mut second = vec![];
        loop {
            let out = e.step();
            second.push(format!("{out:?}"));
            if !matches!(out, RunOutcome::Stepped) {
                break;
            }
        }
        assert_eq!(first, second);
        assert_eq!(event_kinds(&e), events_first);
        assert_eq!(reg(&e, "RAX"), rax_first);
    }

    // ─────────────────────────────────────────────────────────────────────
    // 会话动作原语(WP-8 接线面)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn action_primitives_roundtrip_and_faults() {
        let mut e = ir_engine(A32, vec![ins(BaselineOp::Ret, vec![])]);
        e.action_write_bytes(ArchValue::new(STACK_TOP32 - 16, A32), &[1, 2, 3, 4])
            .unwrap();
        assert!(matches!(
            e.action_write_bytes(ArchValue::new(CODE_BASE, A32), &[0]),
            Err(ExecError::MemoryFault(_))
        ));
        e.action_push(ArchValue::new(0x42, A32)).unwrap();
        assert_eq!(reg(&e, "RSP"), STACK_TOP32 - 8);
        assert_eq!(e.action_pop().unwrap().get(), 0x42);
        assert_eq!(reg(&e, "RSP"), STACK_TOP32);
        e.action_call(ArchValue::new(0, A32)).unwrap();
        assert_eq!(e.state.call_frames.len(), 1);
        assert_eq!(reg(&e, "RIP"), 0);
        e.action_ret().unwrap();
        assert!(e.state.call_frames.is_empty());
        assert_eq!(reg(&e, "RIP"), 0, "返回到调用时的执行位置(ip=0)");
        for kind in [
            VmEventKind::Write,
            VmEventKind::Read,
            VmEventKind::Call,
            VmEventKind::Ret,
        ] {
            assert!(event_kinds(&e).contains(&kind));
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // 字节模式端到端 + 红灯(未知 token / 截断 / 不可执行 / gadget / 缓存透明)
    // ─────────────────────────────────────────────────────────────────────

    fn encoding_table() -> Vec<EncodingTableEntry> {
        vec![
            EncodingTableEntry {
                token: 0x50,
                op: Op::Baseline(BaselineOp::Push),
                operand_shapes: vec![EncodingOperandShape::Register(String::from("RBP"))],
            },
            EncodingTableEntry {
                token: 0x51,
                op: Op::Baseline(BaselineOp::Push),
                operand_shapes: vec![EncodingOperandShape::Register(String::from("RAX"))],
            },
            EncodingTableEntry {
                token: 0x5B,
                op: Op::Baseline(BaselineOp::Pop),
                operand_shapes: vec![EncodingOperandShape::Register(String::from("RBX"))],
            },
            EncodingTableEntry {
                token: 0x89,
                op: Op::Baseline(BaselineOp::Mov),
                operand_shapes: vec![
                    EncodingOperandShape::Register(String::from("RBP")),
                    EncodingOperandShape::Register(String::from("RSP")),
                ],
            },
            EncodingTableEntry {
                token: 0xA3,
                op: Op::Baseline(BaselineOp::Mov),
                operand_shapes: vec![
                    EncodingOperandShape::Memory {
                        base: String::from("RBP"),
                    },
                    EncodingOperandShape::Register(String::from("RAX")),
                ],
            },
            EncodingTableEntry {
                token: 0xB8,
                op: Op::Baseline(BaselineOp::Mov),
                operand_shapes: vec![
                    EncodingOperandShape::Register(String::from("RAX")),
                    EncodingOperandShape::ImmediateArch,
                ],
            },
            EncodingTableEntry {
                token: 0xC3,
                op: Op::Baseline(BaselineOp::Ret),
                operand_shapes: vec![],
            },
            EncodingTableEntry {
                token: 0xC9,
                op: Op::Baseline(BaselineOp::Leave),
                operand_shapes: vec![],
            },
            EncodingTableEntry {
                token: 0xE8,
                op: Op::Baseline(BaselineOp::Call),
                operand_shapes: vec![EncodingOperandShape::ImmediateArch],
            },
            EncodingTableEntry {
                token: 0x80,
                op: Op::Baseline(BaselineOp::Syscall),
                operand_shapes: vec![EncodingOperandShape::ImmediateArch],
            },
        ]
    }

    /// 与 canonical_ir_program 同逻辑的字节形态(跨模式一致性对偶)。
    /// 布局(32 位,code @ 0x400000):
    ///   0x400000: B8 imm32(0x1234)     mov RAX,0x1234
    ///   0x400005: E8 imm32(0x400010)   call func
    ///   0x40000A: 80 imm32(0)          syscall exit(0)
    ///   0x40000F: 50(pad,不可达)
    /// func:
    ///   0x400010: 50                   push RBP
    ///   0x400011: 89                   mov RBP,RSP
    ///   0x400012: A3 disp32(−8)        mov [RBP−8],RAX
    ///   0x400017: C9                   leave
    ///   0x400018: C3                   ret
    fn canonical_byte_code() -> Vec<u8> {
        let mut code = Vec::new();
        code.push(0xB8);
        code.extend_from_slice(&0x1234u32.to_le_bytes());
        code.push(0xE8);
        code.extend_from_slice(&0x0040_0010u32.to_le_bytes());
        code.push(0x80);
        code.extend_from_slice(&0u32.to_le_bytes());
        code.push(0x50); // pad(不可达)
        assert_eq!(code.len(), 16);
        code.push(0x50); // 0x400010 func:
        code.push(0x89);
        code.push(0xA3);
        code.extend_from_slice(&0xFFFF_FFF8u32.to_le_bytes());
        code.push(0xC9);
        code.push(0xC3);
        code
    }

    fn byte_engine(code: Vec<u8>) -> Engine {
        byte_engine_with(code, vec![], vec![], vec![])
    }

    fn byte_engine_with(
        code: Vec<u8>,
        custom: Vec<CustomInstructionDef>,
        ifaces: Vec<InterfaceDef>,
        canaries: Vec<CanarySlotSpec>,
    ) -> Engine {
        Engine::new(EngineConfig {
            state: state_config(A32, ExecutionMode::ByteCode, &code, CODE_BASE, 100_000),
            program: Program::Byte {
                table: encoding_table(),
                entrypoint_address: ArchValue::new(CODE_BASE, A32),
            },
            custom_instructions: custom,
            interfaces: ifaces,
            canary_slots: canaries,
        })
        .unwrap()
    }

    fn byte_engine_at(code: Vec<u8>, entry: u64, steps: u64) -> Engine {
        Engine::new(EngineConfig {
            state: state_config(A32, ExecutionMode::ByteCode, &code, entry, steps),
            program: Program::Byte {
                table: encoding_table(),
                entrypoint_address: ArchValue::new(entry, A32),
            },
            custom_instructions: vec![],
            interfaces: vec![],
            canary_slots: vec![],
        })
        .unwrap()
    }

    #[test]
    fn byte_mode_executes_canonical_program() {
        let mut e = byte_engine(canonical_byte_code());
        assert_eq!(
            e.run_to_event(PauseOn::Exception),
            RunOutcome::Exited { code: 0 }
        );
        assert_eq!(reg(&e, "RAX"), 0x1234);
        assert_eq!(reg(&e, "RSP"), STACK_TOP32);
        assert!(e.state.call_frames.is_empty());
        assert_eq!(
            reg(&e, "RIP"),
            0x40000F,
            "RIP 为字节地址(exit 后停在下一位置)"
        );
        assert_eq!(e.state.constraints.steps.used, 8);
    }

    /// 完成标准:IR 与字节模式对同一逻辑程序的执行轨迹一致
    /// (事件类别序列、Read/Write 事件地址、通用寄存器终值、栈区字节、
    /// 步耗逐项相等;RIP 与调用帧标签因两形态地址域不同——索引 vs 字节
    /// 地址——不参与比较)。
    #[test]
    fn cross_mode_execution_trace_consistency() {
        let mut ir = ir_engine(A32, canonical_ir_program(A32));
        let mut byte = byte_engine(canonical_byte_code());
        assert_eq!(
            ir.run_to_event(PauseOn::Exception),
            RunOutcome::Exited { code: 0 }
        );
        assert_eq!(
            byte.run_to_event(PauseOn::Exception),
            RunOutcome::Exited { code: 0 }
        );
        assert_eq!(event_kinds(&ir), event_kinds(&byte));
        assert_eq!(
            ir.state.constraints.steps.used,
            byte.state.constraints.steps.used
        );
        for name in ["RSP", "RBP", "RAX", "RBX", "FLAG_KEY"] {
            assert_eq!(
                reg(&ir, name),
                reg(&byte, name),
                "寄存器 {name} 跨模式不一致"
            );
        }
        // 栈区字节一致,唯一排除返回地址槽(RSP 初始值 top − 8 处的 8 字节):
        // IR 为指令索引、字节模式为绝对地址,两形态地址域不同属构造性差异(规约 §二)。
        let stack_below_ret_slot = |e: &Engine| -> Vec<u8> {
            e.state
                .memory
                .read(ArchValue::new(0x7FFF_F000, A32), (STACK_LEN - 16) as usize)
                .unwrap()
        };
        assert_eq!(stack_below_ret_slot(&ir), stack_below_ret_slot(&byte));
        // Read / Write 事件地址同为栈地址,逐项一致。
        let data_addrs = |e: &Engine| -> Vec<u64> {
            e.state
                .private_event_log
                .iter()
                .filter(|ev| matches!(ev.kind, VmEventKind::Read | VmEventKind::Write))
                .filter_map(|ev| ev.address.map(|a| a.get()))
                .collect()
        };
        assert_eq!(data_addrs(&ir), data_addrs(&byte));
    }

    #[test]
    fn byte_mode_unknown_token_is_invalid_rip() {
        let mut e = byte_engine(vec![0x00]);
        assert!(matches!(
            e.step(),
            RunOutcome::Failed {
                error: ExecError::InvalidRip { address: 0x400000 },
            }
        ));
    }

    #[test]
    fn byte_mode_truncated_instruction_is_invalid_rip() {
        // 代码区内容短于区域时零填充(区域是存储粒度):call 仍可译码并跳向
        // 未映射内联值 → 下一次取指失败(取指位置不可执行)。
        let mut e = byte_engine(vec![0xE8, 0x01, 0x02]);
        assert!(matches!(e.step(), RunOutcome::Stepped), "零填充使译码完整");
        assert!(matches!(
            e.step(),
            RunOutcome::Failed {
                error: ExecError::InvalidRip { .. },
            }
        ));
        // 指令贴区域末端:取指越界即整体失败。
        let mut code = vec![0x50; 4096];
        let last = 4096 - 3;
        code[last] = 0xE8;
        code[last + 1] = 0;
        code[last + 2] = 0;
        let mut e = byte_engine_at(code, CODE_BASE + last as u64, 100);
        assert!(matches!(
            e.step(),
            RunOutcome::Failed {
                error: ExecError::InvalidRip { .. },
            }
        ));
    }

    #[test]
    fn byte_mode_call_to_data_region_is_invalid_rip() {
        // 动作 call 指向栈(不可执行)→ 下一次取指失败。
        let mut e = byte_engine(vec![0xC3]);
        e.action_call(ArchValue::new(STACK_TOP32 - 16, A32))
            .unwrap();
        assert!(matches!(
            e.step(),
            RunOutcome::Failed {
                error: ExecError::InvalidRip {
                    address: 0x7FFF_FFE8
                },
            }
        ));
    }

    #[test]
    fn byte_mode_runtime_undeclared_syscall_is_invalid_action() {
        // gadget 路径:syscall 内联立即数引用未声明接口(探测译码外)。
        let mut code = vec![0x80];
        code.extend_from_slice(&0x9999u32.to_le_bytes());
        let mut e = byte_engine(code);
        assert!(matches!(
            e.step(),
            RunOutcome::Failed {
                error: ExecError::InvalidSyscallDispatch { value: 0x9999 },
            }
        ));
    }

    #[test]
    fn byte_mode_mid_instruction_gadget_execution() {
        // ROP 教学:自内联立即数字节中段起取指(0x50 = push RBP gadget)。
        let mut code = vec![0xB8];
        code.extend_from_slice(&0x0040_0050u32.to_le_bytes()); // 内联字节 [50 00 40 00]
        code.push(0x50);
        let entry = CODE_BASE + 1; // 指向内联中的 0x50 字节(gadget 起点)
        let mut e = byte_engine_at(code, entry, 100);
        assert!(matches!(e.step(), RunOutcome::Stepped), "gadget:push RBP");
        assert_eq!(reg(&e, "RSP"), STACK_TOP32 - 8);
        assert_eq!(reg(&e, "RIP"), entry + 1, "gadget 长度 1 字节");
    }

    #[test]
    fn byte_mode_engine_init_red_lights() {
        let build = |table: Vec<EncodingTableEntry>, entry: u64| {
            Engine::new(EngineConfig {
                state: state_config(A32, ExecutionMode::ByteCode, &[0x50], entry, 100),
                program: Program::Byte {
                    table,
                    entrypoint_address: ArchValue::new(entry, A32),
                },
                custom_instructions: vec![],
                interfaces: vec![],
                canary_slots: vec![],
            })
        };
        assert!(matches!(
            build(vec![], CODE_BASE),
            Err(EngineInitError::Program(ProgramError::EmptyEncodingTable))
        ));
        assert!(matches!(
            build(encoding_table(), STACK_TOP32),
            Err(EngineInitError::Program(
                ProgramError::EntrypointNotExecutable {
                    address: STACK_TOP32
                }
            ))
        ));
        let mut dup = encoding_table();
        dup.push(EncodingTableEntry {
            token: 0xC3,
            op: Op::Baseline(BaselineOp::Leave),
            operand_shapes: vec![],
        });
        assert!(matches!(
            build(dup, CODE_BASE),
            Err(EngineInitError::Program(ProgramError::DuplicateToken(0xC3)))
        ));
        let mut many = encoding_table();
        for i in 0..60u16 {
            many.push(EncodingTableEntry {
                token: u8::try_from(i).unwrap(),
                op: Op::Baseline(BaselineOp::Ret),
                operand_shapes: vec![],
            });
        }
        assert!(matches!(
            build(many, CODE_BASE),
            Err(EngineInitError::Program(
                ProgramError::TooManyEncodingEntries { count: 70 }
            ))
        ));
    }

    #[test]
    fn byte_mode_decode_cache_is_transparent_optimization() {
        // D4.4:缓存是性能优化非状态——reset 保留缓存重放,事件与终态逐项一致。
        let mut e = byte_engine(canonical_byte_code());
        assert_eq!(
            e.run_to_event(PauseOn::Exception),
            RunOutcome::Exited { code: 0 }
        );
        let first_events = event_kinds(&e);
        let first_rax = reg(&e, "RAX");
        let first_steps = e.state.constraints.steps.used;
        e.reset();
        assert_eq!(
            e.run_to_event(PauseOn::Exception),
            RunOutcome::Exited { code: 0 }
        );
        assert_eq!(event_kinds(&e), first_events);
        assert_eq!(reg(&e, "RAX"), first_rax);
        assert_eq!(e.state.constraints.steps.used, first_steps);
    }

    #[test]
    fn byte_mode_custom_instruction_and_interface() {
        // token 0x9C → 自定义 SAVER;token 0x9D → call 接口 0x100 烘焙。
        let mut table = encoding_table();
        table.push(EncodingTableEntry {
            token: 0x9C,
            op: Op::Custom(String::from("SAVER")),
            operand_shapes: vec![],
        });
        table.push(EncodingTableEntry {
            token: 0x9D,
            op: Op::Baseline(BaselineOp::Call),
            operand_shapes: vec![EncodingOperandShape::Interface(0x100)],
        });
        let mut code = vec![0x9C, 0x9D, 0x80];
        code.extend_from_slice(&0u32.to_le_bytes());
        let mut e = Engine::new(EngineConfig {
            state: state_config(A32, ExecutionMode::ByteCode, &code, CODE_BASE, 1000),
            program: Program::Byte {
                table,
                entrypoint_address: ArchValue::new(CODE_BASE, A32),
            },
            custom_instructions: custom_defs(),
            interfaces: iface_defs(),
            canary_slots: vec![],
        })
        .unwrap();
        assert!(matches!(e.step(), RunOutcome::Stepped)); // SAVER
        assert_eq!(reg(&e, "RBX"), 0x77);
        let rsp = reg(&e, "RSP");
        assert!(matches!(e.step(), RunOutcome::Stepped)); // call 接口
        assert_eq!(reg(&e, "RSP"), rsp);
        assert_eq!(reg(&e, "FLAG_KEY"), 7);
        assert_eq!(e.step(), RunOutcome::Exited { code: 0 });
        // 步耗:SAVER 3 + call 1 + 效果 4 + syscall 1。
        assert_eq!(e.state.constraints.steps.used, 9);
    }

    // ─────────────────────────────────────────────────────────────────────
    // 确定性:同输入同轨迹(回放底座)
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn same_config_yields_identical_trajectory() {
        for _ in 0..8 {
            let mut a = ir_engine(A32, canonical_ir_program(A32));
            let mut b = ir_engine(A32, canonical_ir_program(A32));
            loop {
                let oa = a.step();
                let ob = b.step();
                assert_eq!(format!("{oa:?}"), format!("{ob:?}"));
                if !matches!(oa, RunOutcome::Stepped) {
                    break;
                }
            }
            assert_eq!(a.state.instruction_pointer, b.state.instruction_pointer);
            assert_eq!(
                a.state.private_event_log.len(),
                b.state.private_event_log.len()
            );
        }
    }
}

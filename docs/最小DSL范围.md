# 最小 DSL 范围(WP-4 · 已冻结)

| 项 | 值 |
|---|---|
| 版本 | v1.2 |
| 日期 | 2026-09-04 |
| 状态 | 阶段一 WP-4 交付物,指令面 / 谓词面 / 编排面词汇冻结;v1.2 按《Vm 模块设计冲突与整改方案》完成 G4 重定基 |
| 修订 | v1.2(2026-09-04):G4——基线指令面 21 → 20 opcode(移除教学 IO `read`/`write`,新增栈帧指令 `leave`),`syscall` / `call` 开放作者接口派发,新增作者自定义指令声明面 `customInstructions[]` 与作者接口声明面 `interfaces[]`(声明式映射表,微算子 / 效果原语封闭集,直线语义,恒定步数);`dslSchemaVersion` 1 → 2、`irFormatVersion` 1 → 2;§二寄存器表述同步 G2 双命名空间保留模型;v1.1(2026-09-04):G1——字长改为题目 `vmProfile.archBits` 位宽声明(32/64),新增操作数宽度域(立即数无符号、位移有符号,按 archBits 掩蔽,6.2);G3——内存区域增补作者自定义 `custom` 类(五类扩为六类),区域大小与页大小收紧为 4KB 的倍数(VMA 页对齐,D2);v1(2026-09-03):冻结初版 |
| 契约载体 | `@stackmaster/challenge-schema`:`schema/private-bundle.schema.json` 的 `compiledIr` / `customInstructions` / `interfaces` / `judging` / `stages` / `allowedActions`;分类检查器规则见 WP-1 清单第十二章 §12.6 |
| 上游依据 | 计划书 6.1(MVP 虚拟硬件)、6.2(archBits 位宽掩蔽域)、7.2(可扩展内容与扩展语义)、7.3(DSL 安全边界)、7.4(版本管理);`docs/develop/Vm 模块设计.md`(D4:指令集自由映射)+ `docs/develop/Vm 模块设计冲突与整改方案.md`(G1–G4 裁决与实现立场) |
| 效力范围 | 阶段二 `challenge-compiler` 与 vm-engine 的指令实现、题目包校验与判题条件求值;与计划书冲突时以计划书为准 |

**冻结声明**:本文冻结的是 DSL 的**词汇上限**——指令面封闭 20 基线 opcode + 微算子封闭集 v1 + 效果原语封闭集 v1、谓词面封闭 7 内置谓词 + 九项表达式白名单、编排面封闭状态机六要素。任何扩展(新增 opcode、微算子、效果原语、谓词、副作用类型)必须先走 WP-1 §1.3 契约变更流程并递增对应版本字段,再落 Schema 与 fixture。

---

## 一、范围与设计立场

题目 DSL **不是脚本语言**:它是"结构化题目描述格式 + 封闭指令集白名单"。出题人的全部表达能力被拆到三个封闭面上:

| 面 | 冻结内容 | 载体 |
|---|---|---|
| 指令面 | 20 基线 opcode + 微算子封闭集 v1(§三) | 私有包 `compiledIr.instructions[].op` + `customInstructions[]` |
| 谓词面 | 九项表达式白名单(§四)+ 7 内置谓词 | 私有包 `judging` / `stages[].preconditions` 等的条件结构 |
| 编排面 | 状态机六要素 + 循环预算(§七) | 私有包 `stages[]` |

扩展语义采用计划书 7.2 原文口径:**"扩展"仅指选择固定 Runtime 中经过审计的内置 opcode、predicate 和操作 ID,并配置其受 Schema 约束的参数**;题目包不得动态注册处理函数、加载模块或注入新的执行代码。

**作者自定义的实现立场**(G4/D4,《Vm 模块设计冲突与整改方案》§3.4):"指令作用与机器码表现的映射可由出题人定义"落地为——

> **作者自定义 = 私有包内的声明式映射表(数据),由引擎按封闭原语集解释执行;不存在宿主侧处理函数注册,不存在脚本形态。**

被扩展的是"作者可声明的语义面",不是"作者可注入的代码面";红线"题目 DSL 不执行任意宿主代码"(计划书四底线 4 / 7.3)保持不变。确定性(6.3)成立:映射表是题目包数据,回放按 `vmEngineVersion` 锁定的解释器执行;审计(13.2)成立:发布管线对每条表项跑 T-SC1 / T-SC2 / 差分与静态检查(§三.2 / §三.3)。

## 二、虚拟硬件边界(6.1 实例化)

- **内存区域六类**:`code`(代码区)、`global`(全局区)、`stack`(栈区)、`heap`(堆区)、`key`(题目定义的关键区)、`custom`(作者自定义类型,`publicLabel` 必填承载类型名;G3 整改)——即公开包 `memoryLayout.regions[].kind` 与私有包 `initialState.memoryRegions[].kind` 的冻结枚举;区域大小与页大小均为 4KB 的倍数(VMA 页对齐,D2;区域内对象不受约束);
- **寄存器**(G2/D3 双命名空间保留模型):出题人在两个命名空间内**自由命名、自由计数**——一般命名空间 `^(?!FLAG)[A-Z][A-Z0-9_]{0,15}$` 与 FLAG 保留区 `^FLAG[A-Z0-9_]*$`(两空间结构性不相交,秘密汇可静态枚举,WP-1 §12.5 v1.5)。`RSP` / `RBP` / `RIP` 为必选核心寄存器(公开包 `vmProfile.registers` 声明集必须包含,XS-REG-CORE);题目 FLAG 子集命名必须落在 FLAG 保留区,且不得进入公开寄存器白名单(名称公开、值秘密,WP-1 §12.5 / XS-REG-FLAG);
- **字长与端序**:位宽由出题人指定,`archBits ∈ {32, 64}`(公开包 `vmProfile.archBits` 必填;G1/D1);端序固定小端(公开包 `vmProfile.endianness` const `little`)。架构值语义 = **archBits 位宽的值,以 64 位容器承载,高位按位宽掩蔽**(计划书 6.2);地址与架构值在 VM Core 内是一等公民,DSL 与公开 API 用明确十六进制字符串;
- **操作数宽度域**(G1):指令立即数为**无符号**架构值,取值 `[0, 2^archBits − 1]`;内存位移为**有符号**架构值,取值 `[−2^(archBits−1), 2^(archBits−1) − 1]`;越界由检查器规则 `XS-ARCH-WIDTH` 拒绝(WP-1 §12.6)。§三各语义摘要中"按 archBits 掩蔽"即指此域;
- **语义立场**(6.1 原文):MVP 的操作不要求等同于完整机器指令,应优先服务于概念解释;`syscall` 只是固定、有限、无宿主副作用的教学伪操作。

## 三、指令集白名单(冻结,G4 v2)

### 三.1 基线指令集(20 opcode,封闭枚举)

20 个基线 opcode 是计划书 6.1 列举能力("push、pop、mov、基本算术与位运算、有限跳转、call、syscall、ret")的封闭实例化;教学 IO `read` / `write` 移除(G4:内存读写由 `mov R,M` / `M,R` 与会话动作 `write_bytes` 承担,虚拟文件读取改经作者接口面 §三.3),新增栈帧指令 `leave`:

| opcode | 类别 | 操作数(≤ 4) | 语义摘要 | 标志 |
|---|---|---|---|---|
| `mov` | 数据传送 | R,I / R,R / R,M / M,R | 架构值传送(按 archBits 掩蔽) | — |
| `push` | 数据传送 | R / I | 压栈(`RSP -= 8` 后写栈) | — |
| `pop` | 数据传送 | R | 出栈(`RSP += 8`) | — |
| `leave` | 栈帧 | — | `RSP ← RBP` 后 `pop RBP`(等价 `mov rsp,rbp; pop rbp`);要求 `RBP` ∈ 私有初始寄存器集(XS-IR-LEAVE);弹出值不可执行时报 `invalid_rip`(与 `ret` 同规则,G4 裁决原文) | — |
| `add` | 算术 | R,R / R,I / R,M | 架构值加法,溢出按引擎错误安全终止(不静默回绕) | zf cf sf |
| `sub` | 算术 | R,R / R,I / R,M | 架构值减法 | zf cf sf |
| `cmp` | 算术 | R,R / R,I / R,M | 减法比较,不写回 | zf cf sf |
| `and` | 位运算 | R,R / R,I | 按位与 | zf sf |
| `or` | 位运算 | R,R / R,I | 按位或 | zf sf |
| `xor` | 位运算 | R,R / R,I | 按位异或 | zf sf |
| `shl` | 位运算 | R,R / R,I | 左移(移位量按 archBits 取模) | zf sf |
| `shr` | 位运算 | R,R / R,I | 逻辑右移 | zf sf |
| `jmp` | 控制流 | I / R / M | 无条件跳转 | — |
| `je` | 控制流 | I | zf = 1 跳转 | — |
| `jne` | 控制流 | I | zf = 0 跳转 | — |
| `jb` | 控制流 | I | cf = 1 跳转(无符号低于) | — |
| `jae` | 控制流 | I | cf = 0 跳转(无符号不低于) | — |
| `call` | 控制流 | I / R / interface | 压返回地址后跳转;第四种操作数形态 `{kind:"interface", interfaceId}` 走作者接口派发(§三.3,微决策 D4.2);调用深度受协议 `CALL_STACK_MAX_DEPTH` 约束 | — |
| `ret` | 控制流 | — | 弹出返回地址;弹出值不可作为执行位置时报 `invalid_rip` | — |
| `syscall` | 教学 IO | I | **派发伪操作**:I ∈ 保留系统号带 `[0x0000, 0x00FF]` 时执行内置语义(当前仅 `exit(I)`,语义不变);I ≥ `0x0100` 时按作者接口派发(§三.3),未声明即 `invalid_action`(XS-SYSCALL-DECL);无宿主副作用 | — |

操作数类别:`R` = 寄存器(一般命名空间 ∪ FLAG 保留区);`I` = 立即数(十六进制,无符号,archBits 位宽域,§二);`M` = 内存操作数(base 寄存器 + 有符号位移,archBits 位宽域,§二);`interface` = 作者接口结构化引用 `{kind:"interface", interfaceId}`。每指令操作数 ≤ 4。

**IR 助记符双形态**(G4):`op` 字段接受**基线小写 opcode 枚举**或**大写自定义助记符**(模式 `^[A-Z][A-Z0-9_]{0,15}$`)。两者按大小写结构性不相交:自定义助记符必须在 `customInstructions[]` 声明(XS-CUSTOM-REF),基线枚举防绕过编译器的手写包。

**标志模型**:三标志 `zf`(结果为零)、`cf`(无符号进位/借位)、`sf`(符号位)。`cmp` 只置标志不写回;条件跳转只消费标志;`add`/`sub` 按无语义回绕的引擎策略置 cf。标志集是 v1 词汇,扩展走版本演进。

**教学价值注记**(`leave`):saved `RBP` 被攻击者数据覆写后,`leave` 使 `RSP` 被劫持,随后的 `ret` 弹出攻击者控制的返回地址——这是 MVP 教学目标(栈帧 / buffer / 返回地址)的直接教具,与 `call`/`ret`/`push`/`pop` 构成完整栈帧闭环。

### 三.2 作者自定义指令面(`customInstructions[]`,v1)

私有包声明面 `customInstructions[]` ≤ 16 条,每条 = `{mnemonic, displayText, semantics}`:

- `mnemonic`:大写助记符 `^[A-Z][A-Z0-9_]{0,15}$`(与基线小写 opcode 结构性不相交;条目间唯一,且不得与基线 opcode 冲突,XS-CUSTOM-DEF);
- `displayText`:该指令在 `controlFlow.currentInstruction` 的展示文本(I-10 静态模板类;"表现机器码"的自由度即此面 + 助记符);经 E-4 / E-6 扫描(XS-CUSTOM-DISPLAY:不含谓词标识、隐藏区域名、fileId 等私有标识);
- `semantics`:**微算子有序组合**(1–16 步),封闭集 v1:

| 微算子 | 字段 | 语义 |
|---|---|---|
| `load_imm` | `dst`(一般寄存器)、`valueHex` | 立即数装载 |
| `mov_reg` | `dst`、`src`(均为一般寄存器) | 寄存器间传送 |
| `load_mem` | `dst`(一般寄存器)、`baseRegister`、`displacementHex` | 基址 + 位移内存读(统一权限检查与 I-9 统一拒绝路径) |
| `store_mem` | `baseRegister`、`displacementHex`、`src` | 基址 + 位移内存写(同上) |
| `set_flag` | `flagRegister`(FLAG 保留区模式)、`valueHex` | 标志置位(FLAG 写入的**唯一**微算子,I-3 污点检查落点) |
| `bit_mask` | `dst`、`src`、`maskHex`、`logic ∈ {and, or, xor}` | 位掩蔽运算 |

- **v1 约束:直线语义**——封闭集内不存在控制转移微算子,自定义指令不含跳转/调用(仍属基线 opcode 面),CFG 静态分析(XS-STAGE-*、回边预算)完全保持;"语义含控制转移微算子被拒"由微算子封闭枚举结构性保证(Schema 拒绝未知 `op`);
- **恒定步数**:单条自定义指令的求值步数 = 微算子定步数之和,与操作数值无关——T-SC2(单字节突变步数恒定)对每条自定义指令逐条可断言;"步数随操作数值变化"的形态在封闭集内结构性不可表达;
- 审计:发布管线对每条自定义指令跑 T-SC1 / T-SC2 / 差分 + `XS-ARCH-WIDTH` + 微算子白名单校验(Schema 封闭枚举 + 检查器纵深)。

### 三.3 作者接口面(`interfaces[]`,v1)

私有包声明面 `interfaces[]` ≤ 16 条,每条 = `{interfaceId, displayText, effects}`:

- `interfaceId`:**整数接口号**,取值 `[0x0100, 0xFFFF]`——与保留系统号带 `[0x0000, 0x00FF]`(内置 `exit`)结构性不相交;条目间唯一;
- `displayText`:接口调用的展示文本(I-10 静态模板类;XS-CUSTOM-DISPLAY 同扫描);
- `effects`:**效果原语有序列表**(1–16 步),封闭集 v1:

| 效果原语 | 字段 | 语义 |
|---|---|---|
| `exit` | — | 程序终止(等效内置 `exit(0)`;保留内置语义) |
| `grant_virtual_file` | `fileId` | 授予虚拟文件 capability(沿 stage 副作用先例,结构化引用) |
| `virtual_file_read` | `fileId` | 标记虚拟文件已读(衔接谓词 `virtual_file_read`) |
| `set_flag` | `flagRegister`、`valueHex` | 置 FLAG 汇寄存器(经 I-3 污点检查) |
| `noop` | — | 无操作(占位 / 组合填充) |

- **`syscall` 派发**:操作数 I(立即数)∈ 保留带 → 内置语义(`exit(I)`,不变);I ≥ `0x0100` → 必须精确匹配某 `interfaces[].interfaceId`,未声明即 `invalid_action`(检查器 XS-SYSCALL-DECL);
- **`call` 派发**:操作数联合新增第四种类型化形态 `{kind:"interface", interfaceId}`(结构化引用,沿 `fileId` 先例,**不存在动态拼接 capability 的语法位置**,F-4 保持);引用必须落在 `interfaces[]`(XS-IFACE-REF);派发语义列微决策 **D4.2**:
  - ①(建议,阶段二实现取此)引擎管理调用:记录返回地址 → 执行效果 → 返回下一条指令,不占玩家栈——教学上清晰区分"真实 `call`(栈帧)"与"接口 `call`(教学接口)";
  - ② 完整栈语义:压返回地址、`ret` 返回(更贴近真实机器,但效果面与栈面耦合);
- **预算**:接口效果求值计入动作 / 谓词预算;每接口步数 = 效果原语定步数之和,恒定(T-SC2 同断言);
- **侧信道**:效果是否可见遵守 I-2 / I-3 / I-9;`displayText` 属 I-10 静态模板;接口的存在性对玩家可见面 = 公开包显式声明(作者选择公开或隐藏接口清单——v1 Schema 不设公开声明位,阶段二按教学需要增补;隐藏接口的存在性本身不得从任何公开通道推断,由 T-SC1 探针变体覆盖)。

## 四、表达式与谓词词汇上限(7.3 九项白名单)

计划书 7.3:"表达式只支持常量、只读寄存器引用、命名内存区域查询、有界整数和位运算、比较、布尔组合、固定长度切片、有界字节匹配及枚举值比较。" 九项逐一落位:

| # | 白名单项 | 落位 |
|---|---|---|
| 1 | 常量 | 指令立即数操作数;微算子 / 效果原语常量字段(`valueHex` / `maskHex`);谓词 `valueHex` / `maskHex` / `addressHex` 参数 |
| 2 | 只读寄存器引用 | 判题谓词 `register_equals` / `register_bits_set`(判题视角寄存器只读) |
| 3 | 命名内存区域查询 | `memory_equals` / `memory_contains`(结构化 `regionId` 引用,非裸地址表达式) |
| 4 | 有界整数和位运算 | §三算术/位运算子集与 `bit_mask` 微算子(指令面);谓词 `maskHex` 位掩码 |
| 5 | 比较 | `cmp` + `je`/`jne`/`jb`/`jae`(指令面);谓词等值比较 |
| 6 | 布尔组合 | 判题条件三级结构 `L1{all?≤4, any?≤4, not?} → L2 → L3=谓词`(深度静态封顶,每层分支 ≤ 4) |
| 7 | 固定长度切片 | `memory_equals` 的 `offsetBytes` + 定长 `bytesHex` 匹配 |
| 8 | 有界字节匹配 | `memory_contains` 的 `bytesHex`(≤ 64 字节,有界) |
| 9 | 枚举值比较 | `expectedResult` / `kind` / `visibility` / 微算子 `op` / 效果原语 `effect` 等全部冻结枚举 |

**内置谓词封闭集(7 个,v1)**:`register_equals`、`register_bits_set`、`memory_equals`、`memory_contains`、`ret_target_equals`、`stack_canary_intact`、`virtual_file_read`(结构化 `fileId` 引用;与接口效果原语 `virtual_file_read` 的衔接在效果面重建——G4 移除 `read` 指令后,玩家程序读虚拟文件走 §三.3 接口)。新增谓词 = 审计 + 谓词枚举版本演进(§六)。

**拒绝表达式 AST 的理由**:7.3"复杂逻辑优先沉淀为经过审计的内置谓词"。三级布尔结构把嵌套深度变成静态 Schema 属性(`$defs` 静态展开,Ajv 直接拒绝深层恶意嵌套,XS-NESTING),不需要递归 `$ref` 也不需要检查器动态测深;超出三级布尔 + 七谓词的判题逻辑应沉淀为新内置谓词走审计,而不是放宽表达式。

## 五、禁止清单(7.3,F-1–F-5)

计划书 7.3 五项禁止逐条落位,每条附机检落点:

| ID | 禁止项(7.3 原文) | 机检落点 |
|---|---|---|
| F-1 | JavaScript、Python、Lua 等任意回调 | 结构性不可表达:双包 Schema 无任何函数/代码字符串形态;公开包实例全字符串深扫描(ZR-B8-CAP-SCAN);作者自定义 = 声明式映射表(数据),微算子 / 效果原语封闭枚举,无代码形态 |
| F-2 | `eval`、`Function` 或动态导入 | 同上;公开包 Schema 元检查(XS-1)禁 `default`/`examples` 等可夹带文本的 Schema 元数据 |
| F-3 | 用户自定义函数和任意 WebAssembly | 基线指令面封闭 20 opcode;自定义指令 = 微算子封闭集的**数据**组合,不是函数定义(无参数绑定、无闭包、无控制转移);`call` 目标只能是立即数地址、寄存器或结构化 interface 引用;IR 自定义助记符引用必须落在 `customInstructions[]`(XS-CUSTOM-REF),未声明即拒 |
| F-4 | 文件系统、网络、进程和宿主对象访问 | `syscall` 派发封闭:保留带 `exit` 语义不变 + `interfaces[]` 声明面(效果原语封闭集,无宿主 IO 原语);capability 引用只能走结构化 `fileId` / `interfaceId` 字段(`virtual_file_read` / `grant_virtual_file` / `{kind:"interface"}`),不存在字符串拼接 capability 的语法位置 |
| F-5 | 无限循环、无限递归和动态拼接 capability 名称 | 状态机 `resourceBudget.maxInstructionSteps` **必填**(XS-STAGE-BUDGET);阶段图可达性 XS-STAGE-REACH;IR 指令数 ≤ 4096;自定义指令 / 接口效果恒定步数(§三.2 / §三.3,T-SC2 可断言);capability 名称禁入公开包(ZR-B8)+ 动态拼接无语法位置(F-4) |

## 六、扩展纪律(7.2)

- **允许**:选择受审计的内置 opcode / predicate / 操作 ID,配置受 Schema 约束的参数;
- **禁止**:动态注册处理函数、加载模块、注入新的执行代码(7.2 原文);
- **新增指令语义** = 经过审核、测试和版本化的 Runtime 发布:基线 opcode / 微算子 / 效果原语枚举扩展须递增 `dslSchemaVersion` 与 IR 格式版本并同步 golden fixture(v2 即 G4 重定基的落位:21 → 20 opcode + 两个声明面);新增谓词须扩展谓词封闭枚举并递增 `judgingConfig.verdictRuleVersion`;寄存器扩展走 VM Profile Version(WP-1 §3.2:不靠基集预留);
- 四个封闭词汇组(20 opcode + 微算子 / 效果原语、7 谓词、12 会话动作)都是版本化契约:变更先改 `challenge-schema` Schema + 正反 fixture,评审通过,再改实现(CLAUDE.md 契约纪律)。

## 七、多阶段状态机形态(7.2 落位)

7.2:"多阶段题目中的每个状态应包含允许操作、前置条件、迁移条件、有限副作用、失败条件和资源预算。" 私有包 `stages[]` 逐要素落位:

| 要素 | 形态 | 约束 |
|---|---|---|
| `allowedActions` | 12 动作枚举子集(`uniqueItems`) | 与公开包 `allowedActions` 的交集语义由实现层细化(阶段动作不得超出题目允许面) |
| `preconditions` | L1 条件(必填;恒真写作 `{all: []}`) | 谓词面封闭(§四) |
| `transitions[]` ≤ 8 | `{toStageId, onCondition}` | 目标必须存在且自首阶段全部可达(XS-STAGE-REACH) |
| `sideEffects[]` ≤ 8 | v1 封闭仅 `{type: "grant_virtual_file", fileId}` | 有限副作用;结构化引用,拒绝动态拼接(7.3) |
| `failureConditions[]` ≤ 8 | L1 条件 | 触发即 `failed`(终态,D1 约束 5) |
| `resourceBudget` | `maxInstructionSteps` **必填** > 0;`maxActions?` | **循环上限**:7.2"循环必须有静态上限或动态指令预算"以每状态指令预算落位——无预算的状态在 Schema 层即拒绝(XS-STAGE-BUDGET) |

阶段数 ≤ 8(v1);阶段自身不可声明子状态机(无递归表达位)。自定义指令与接口效果不引入新的编排要素:它们在指令预算内求值(恒定步数),不构成新的状态迁移面。

## 八、IR 信封与编译边界

- `compiledIr`(私有包必填字段):`{irFormatVersion: const 2, entrypointIndex?, instructions: 1..4096, labels: 0..512 × {labelId, instructionIndex}}`;指令 = **基线 20 opcode 枚举 ∪ 大写自定义助记符**(双形态,结构性不相交)+ 类型化操作数槽(四种 kind:`register` / `immediate` / `memory` / `interface`,结构安全);
- **WP-4 检查器只做结构性校验**:op ∈ 基线枚举或已声明助记符(XS-CUSTOM-REF)、syscall 派发号落在保留带或已声明接口(XS-SYSCALL-DECL)、interface 操作数与效果引用可解析(XS-IFACE-REF)、`leave` 要求 `RBP` 在初始寄存器集(XS-IR-LEAVE)、标签引用可解析且索引界内(XS-IR-LABEL)、谓词引用可解析(XS-PRED-REFS)、声明面文本 E-4/E-6 扫描(XS-CUSTOM-DISPLAY);
- **归 `challenge-compiler`(阶段二)**:逐 opcode 操作数合法性与数量、CFG 可达性与终止性、循环回边与预算的一致性——编译器产出的 IR 才进入私有包,Schema 封闭枚举防的是绕过编译器的手写包;
- IR 是版本化**序列化格式**,不是共享代码(CLAUDE.md 跨语言规则):JSON Schema 是 TS 与 Rust 的共同权威,Rust 侧以 serde + schemars 消费;
- 完整 IR 与自定义指令 / 接口映射表只存在于私有判题包(7.3 / ZR-B3);浏览器展示的伪指令文本由服务端从展示数据单独生成(D5,`displayText` 即其权威模板),IR 永不下发。

## 九、机检与测试锚点

| 文面 | 机检 |
|---|---|
| 20 基线 opcode 白名单(§三.1) | `compiledIr.instructions[].op` 基线枚举(∪ 助记符模式);跨包一致性测试断言枚举面与本文一致 |
| 微算子 / 效果原语封闭集(§三.2 / §三.3) | `customInstructions[].semantics[].op` / `interfaces[].effects[].effect` 封闭枚举;表容量 ≤ 16;直线语义结构性成立 |
| 自定义助记符与接口引用(§三) | XS-CUSTOM-DEF / XS-CUSTOM-REF / XS-SYSCALL-DECL / XS-IFACE-REF / XS-IR-LEAVE;displayText E-4/E-6 扫描(XS-CUSTOM-DISPLAY) |
| 九项表达式白名单 + 7 谓词(§四) | `judging` 条件结构仅含封闭谓词枚举;三级深度为静态 Schema 属性(XS-NESTING) |
| F-1–F-5(§五) | Schema 结构性不可表达 + ZR-B8-CAP-SCAN 实例深扫描 + XS-1 Schema 元检查 |
| 状态机六要素 + 循环预算(§七) | XS-STAGE-REACH / XS-STAGE-BUDGET |
| 四类版本(7.4) | 公开包 3 版本字段 + 私有包 `dslSchemaVersion`(v2)/ `vmEngineVersion` / `verdictRuleVersion`(WP-1 §12.3) |

**完成标准对照**(阶段一任务分解 WP-4):"DSL 白名单成文且无任何脚本语言能力"由本文 §三(指令封闭 + 声明式自定义面)、§四(谓词封闭)、§五(五项禁止带机检落点)共同满足;不存在任何可执行任意逻辑的语法位置。

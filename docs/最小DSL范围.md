# 最小 DSL 范围(WP-4 · 已冻结)

| 项 | 值 |
|---|---|
| 版本 | v1(冻结) |
| 日期 | 2026-09-03 |
| 状态 | 阶段一 WP-4 交付物,指令面 / 谓词面 / 编排面词汇冻结 |
| 契约载体 | `@stackmaster/challenge-schema`:`schema/private-bundle.schema.json` 的 `compiledIr` / `judging` / `stages` / `allowedActions`;分类检查器规则见 WP-1 清单第十二章 §12.6 |
| 上游依据 | 计划书 6.1(MVP 虚拟硬件)、7.2(可扩展内容与扩展语义)、7.3(DSL 安全边界)、7.4(版本管理);WP-1 清单 v1.3 §3.2(寄存器冻结基集)、§12(双包字段级分类) |
| 效力范围 | 阶段二 `challenge-compiler` 与 vm-engine 的指令实现、题目包校验与判题条件求值;与计划书冲突时以计划书为准 |

**冻结声明**:本文冻结的是 DSL 的**词汇上限**——指令面封闭 21 opcode、谓词面封闭 7 内置谓词 + 九项表达式白名单、编排面封闭状态机六要素。任何扩展(新增 opcode、谓词、副作用类型)必须先走 WP-1 §1.3 契约变更流程并递增对应版本字段,再落 Schema 与 fixture。

---

## 一、范围与设计立场

题目 DSL **不是脚本语言**:它是"结构化题目描述格式 + 封闭指令集白名单"。出题人的全部表达能力被拆到三个封闭面上:

| 面 | 冻结内容 | 载体 |
|---|---|---|
| 指令面 | 21 opcode(§三) | 私有包 `compiledIr.instructions[].op` 封闭枚举 |
| 谓词面 | 九项表达式白名单(§四)+ 7 内置谓词 | 私有包 `judging` / `stages[].preconditions` 等的条件结构 |
| 编排面 | 状态机六要素 + 循环预算(§七) | 私有包 `stages[]` |

扩展语义采用计划书 7.2 原文口径:**"扩展"仅指选择固定 Runtime 中经过审计的内置 opcode、predicate 和操作 ID,并配置其受 Schema 约束的参数**;题目包不得动态注册处理函数、加载模块或注入新的执行代码。

## 二、虚拟硬件边界(6.1 实例化)

- **内存区域五类**:`code`(代码区)、`global`(全局区)、`stack`(栈区)、`heap`(堆区)、`key`(题目定义的关键区)——即公开包 `memoryLayout.regions[].kind` 与私有包 `initialState.memoryRegions[].kind` 的冻结枚举;
- **寄存器**:冻结基集 14 个(`RSP`、`RBP`、`RIP`、`RAX`、`RBX`、`RCX`、`RDI`、`RSI`、`RDX`、`R8`–`R12`)+ 题目 FLAG 子集。FLAG 子集命名必须匹配 `^FLAG[A-Z0-9_]*$`,且不得进入公开寄存器白名单(名称公开、值秘密,WP-1 §12.5 / XS-REG-FLAG);
- **字长与端序**:64 位、小端(公开包 `vmProfile.endianness` const `little`;地址与 64 位值在 VM Core 内是一等公民,DSL 与公开 API 用明确十六进制字符串,6.2);
- **语义立场**(6.1 原文):MVP 的操作不要求等同于完整机器指令,应优先服务于概念解释;`syscall` 只是固定、有限、无宿主副作用的教学伪操作。

## 三、指令集白名单(冻结,21 opcode)

21 个 opcode 是计划书 6.1 列举能力("push、pop、mov、基本算术与位运算、有限跳转、call、syscall、ret、教学化的 read、write")的封闭实例化:

| opcode | 类别 | 操作数(≤ 4) | 语义摘要 | 标志 |
|---|---|---|---|---|
| `mov` | 数据传送 | R,I / R,R / R,M / M,R | 64 位传送 | — |
| `push` | 数据传送 | R / I | 压栈(`RSP -= 8` 后写栈) | — |
| `pop` | 数据传送 | R | 出栈(`RSP += 8`) | — |
| `add` | 算术 | R,R / R,I / R,M | 64 位加法,溢出按引擎错误安全终止(不静默回绕) | zf cf sf |
| `sub` | 算术 | R,R / R,I / R,M | 64 位减法 | zf cf sf |
| `cmp` | 算术 | R,R / R,I / R,M | 减法比较,不写回 | zf cf sf |
| `and` | 位运算 | R,R / R,I | 按位与 | zf sf |
| `or` | 位运算 | R,R / R,I | 按位或 | zf sf |
| `xor` | 位运算 | R,R / R,I | 按位异或 | zf sf |
| `shl` | 位运算 | R,R / R,I | 左移(移位量取模 64) | zf sf |
| `shr` | 位运算 | R,R / R,I | 逻辑右移 | zf sf |
| `jmp` | 控制流 | I / R / M | 无条件跳转 | — |
| `je` | 控制流 | I | zf = 1 跳转 | — |
| `jne` | 控制流 | I | zf = 0 跳转 | — |
| `jb` | 控制流 | I | cf = 1 跳转(无符号低于) | — |
| `jae` | 控制流 | I | cf = 0 跳转(无符号不低于) | — |
| `call` | 控制流 | I / R | 压返回地址后跳转;调用深度受协议 `CALL_STACK_MAX_DEPTH` 约束 | — |
| `ret` | 控制流 | — | 弹出返回地址;弹出值不可作为执行位置时报 `invalid_rip` | — |
| `read` | 教学 IO | R,M | 从内存读入寄存器(教学化自定义接口,非系统调用) | — |
| `write` | 教学 IO | M,R | 寄存器写入内存(同上) | — |
| `syscall` | 教学 IO | I(`exit` + 0..255 退出码) | **封闭单值伪操作**:仅 `exit`;无宿主副作用 | — |

操作数类别:`R` = 寄存器(基集 ∪ FLAG 子集);`I` = 立即数(十六进制,≤ 64 位);`M` = 内存操作数(base 寄存器 + 位移,≤ 64 位)。每指令操作数 ≤ 4。

**标志模型**:三标志 `zf`(结果为零)、`cf`(无符号进位/借位)、`sf`(符号位)。`cmp` 只置标志不写回;条件跳转只消费标志;`add`/`sub` 按无语义回绕的引擎策略置 cf。标志集是 v1 词汇,扩展走版本演进。

**Schema 与语义的分工**:WP-4 的 Schema 只约束 `op` ∈ 21 枚举 + 类型化操作数槽(每操作数带 `kind`:register / immediate / memory,结构安全);**逐 opcode 的操作数合法性与数量校验、CFG 可达性与终止性归 `challenge-compiler`(阶段二)**——编译器产出的 IR 已通过校验,Schema 的封闭枚举防的是绕过编译器的手写包。

## 四、表达式与谓词词汇上限(7.3 九项白名单)

计划书 7.3:"表达式只支持常量、只读寄存器引用、命名内存区域查询、有界整数和位运算、比较、布尔组合、固定长度切片、有界字节匹配及枚举值比较。" 九项逐一落位:

| # | 白名单项 | 落位 |
|---|---|---|
| 1 | 常量 | 指令立即数操作数;谓词 `valueHex` / `maskHex` / `addressHex` 参数 |
| 2 | 只读寄存器引用 | 判题谓词 `register_equals` / `register_bits_set`(判题视角寄存器只读) |
| 3 | 命名内存区域查询 | `memory_equals` / `memory_contains`(结构化 `regionId` 引用,非裸地址表达式) |
| 4 | 有界整数和位运算 | §三算术/位运算子集(指令面);谓词 `maskHex` 位掩码 |
| 5 | 比较 | `cmp` + `je`/`jne`/`jb`/`jae`(指令面);谓词等值比较 |
| 6 | 布尔组合 | 判题条件三级结构 `L1{all?≤4, any?≤4, not?} → L2 → L3=谓词`(深度静态封顶,每层分支 ≤ 4) |
| 7 | 固定长度切片 | `memory_equals` 的 `offsetBytes` + 定长 `bytesHex` 匹配 |
| 8 | 有界字节匹配 | `memory_contains` 的 `bytesHex`(≤ 64 字节,有界) |
| 9 | 枚举值比较 | `expectedResult` / `kind` / `visibility` 等全部冻结枚举 |

**内置谓词封闭集(7 个,v1)**:`register_equals`、`register_bits_set`、`memory_equals`、`memory_contains`、`ret_target_equals`、`stack_canary_intact`、`virtual_file_read`(结构化 `fileId` 引用)。新增谓词 = 审计 + 谓词枚举版本演进(§六)。

**拒绝表达式 AST 的理由**:7.3"复杂逻辑优先沉淀为经过审计的内置谓词"。三级布尔结构把嵌套深度变成静态 Schema 属性(`$defs` 静态展开,Ajv 直接拒绝深层恶意嵌套,XS-NESTING),不需要递归 `$ref` 也不需要检查器动态测深;超出三级布尔 + 七谓词的判题逻辑应沉淀为新内置谓词走审计,而不是放宽表达式。

## 五、禁止清单(7.3,F-1–F-5)

计划书 7.3 五项禁止逐条落位,每条附机检落点:

| ID | 禁止项(7.3 原文) | 机检落点 |
|---|---|---|
| F-1 | JavaScript、Python、Lua 等任意回调 | 结构性不可表达:双包 Schema 无任何函数/代码字符串形态;公开包实例全字符串深扫描(ZR-B8-CAP-SCAN) |
| F-2 | `eval`、`Function` 或动态导入 | 同上;公开包 Schema 元检查(XS-1)禁 `default`/`examples` 等可夹带文本的 Schema 元数据 |
| F-3 | 用户自定义函数和任意 WebAssembly | 指令面封闭 21 opcode;`call` 目标只能是立即数地址或寄存器,无函数定义形态;IR 逐 opcode 合法性归 challenge-compiler |
| F-4 | 文件系统、网络、进程和宿主对象访问 | `syscall` 封闭单值 `exit`;`read`/`write` 作用域限于虚拟内存;capability 引用只能走结构化 `fileId` 字段(`virtual_file_read` / `grant_virtual_file`),不存在字符串拼接 capability 的语法位置 |
| F-5 | 无限循环、无限递归和动态拼接 capability 名称 | 状态机 `resourceBudget.maxInstructionSteps` **必填**(XS-STAGE-BUDGET);阶段图可达性 XS-STAGE-REACH;IR 指令数 ≤ 4096;capability 名称禁入公开包(ZR-B8)+ 动态拼接无语法位置(F-4) |

## 六、扩展纪律(7.2)

- **允许**:选择受审计的内置 opcode / predicate / 操作 ID,配置受 Schema 约束的参数;
- **禁止**:动态注册处理函数、加载模块、注入新的执行代码(7.2 原文);
- **新增指令语义** = 经过审核、测试和版本化的 Runtime 发布:21 opcode 枚举扩展须递增 `dslSchemaVersion` 与 IR 格式版本并同步 golden fixture;新增谓词须扩展谓词封闭枚举并递增 `judgingConfig.verdictRuleVersion`;寄存器扩展走 VM Profile Version(WP-1 §3.2:不靠基集预留);
- 三个封闭枚举(21 opcode / 7 谓词 / 12 会话动作)都是版本化契约:变更先改 `challenge-schema` Schema + 正反 fixture,评审通过,再改实现(CLAUDE.md 契约纪律)。

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

阶段数 ≤ 8(v1);阶段自身不可声明子状态机(无递归表达位)。

## 八、IR 信封与编译边界

- `compiledIr`(私有包必填字段):`{irFormatVersion: const 1, entrypointIndex?, instructions: 1..4096, labels: 0..512 × {labelId, instructionIndex}}`;指令 = 21 opcode 封闭枚举 + 类型化操作数槽;
- **WP-4 检查器只做结构性校验**:op ∈ 枚举、标签引用可解析且索引界内(XS-IR-LABEL)、谓词引用可解析(XS-PRED-REFS);
- **归 `challenge-compiler`(阶段二)**:逐 opcode 操作数合法性与数量、CFG 可达性与终止性、循环回边与预算的一致性——编译器产出的 IR 才进入私有包,Schema 封闭枚举防的是绕过编译器的手写包;
- IR 是版本化**序列化格式**,不是共享代码(CLAUDE.md 跨语言规则):JSON Schema 是 TS 与 Rust 的共同权威,Rust 侧以 serde + schemars 消费;
- 完整 IR 只存在于私有判题包(7.3 / ZR-B3);浏览器展示的伪指令文本由服务端从展示数据单独生成(D5),IR 永不下发。

## 九、机检与测试锚点

| 文面 | 机检 |
|---|---|
| 21 opcode 白名单(§三) | `compiledIr.instructions[].op` 封闭枚举;跨包一致性测试断言枚举面与本文一致 |
| 九项表达式白名单 + 7 谓词(§四) | `judging` 条件结构仅含封闭谓词枚举;三级深度为静态 Schema 属性(XS-NESTING) |
| F-1–F-5(§五) | Schema 结构性不可表达 + ZR-B8-CAP-SCAN 实例深扫描 + XS-1 Schema 元检查 |
| 状态机六要素 + 循环预算(§七) | XS-STAGE-REACH / XS-STAGE-BUDGET |
| 四类版本(7.4) | 公开包 3 版本字段 + 私有包 `dslSchemaVersion` / `vmEngineVersion` / `verdictRuleVersion`(WP-1 §12.3) |

**完成标准对照**(阶段一任务分解 WP-4):"DSL 白名单成文且无任何脚本语言能力"由本文 §三(指令封闭)、§四(谓词封闭)、§五(五项禁止带机检落点)共同满足;不存在任何可执行任意逻辑的语法位置。

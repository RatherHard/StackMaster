# VM 模块后续审查事项与整改清单

| 项 | 值 |
|---|---|
| 版本 | v1.0 |
| 日期 | 2026-09-04 |
| 适用范围 | VM 模块设计、双包 Schema、检查器、公开构建隔离及阶段一收尾评审 |
| 上游依据 | `docs/develop/Vm 模块设计冲突与整改方案.md`、`docs/项目计划书.md`、`docs/contracts/数据分类与秘密零驻留清单.md`、`docs/contracts/最小DSL范围.md` |
| 文档性质 | 遗留审查事项与关闭条件清单，不替代计划书，不直接修改 Schema 规范 |
| 当前结论 | D1–D6 已裁决；契约层与 P5 字节权威执行模式已有实现和测试基础，但下列事项仍需完成或形成关闭证据 |

---

## 一、文档目的与使用方式

本文用于记录 VM 模块在已完成设计裁决和 P5 字节权威执行模式批次之后，仍需完成的审查、补测、文档同步和阶段移交工作。

本文重点区分以下状态，避免把“设计已决定”误写成“实现已验证”：

- **已裁决**：设计方向已经确定，但实现或验收证据可能尚未完整。
- **已实现**：代码或 Schema 中已经存在对应变更。
- **已验证**：有针对性的正反测试、构建检查或跨边界检查证明行为符合预期。
- **待关闭**：仍缺少实现、测试、独立审查或文档证据。

关闭某一事项时，应同时补齐：实现位置、正反测试、必要的安全说明，以及对应文档或 fixture 的引用。不得仅通过修改状态文字关闭事项。

---

## 二、当前批次基线

### 2.1 已完成或已有证据的内容

以下内容不在本清单中重复实现，仅作为后续审查基线：

1. D1–D6 设计决策已记录。
2. `archBits: 32 | 64`、区域 `custom`、4KB 对齐、寄存器双命名空间及核心寄存器要求已经纳入当前整改范围。
3. 基线 opcode 已移除 `read` / `write`，新增 `leave`；`syscall` 和 `call` 的接口声明面已纳入设计。
4. P5 字节模式已经采用表层机器码代码空间作为执行基准：RIP 按字节地址定位，取 token 后译码为固定 opcode 和操作数。
5. 字节模式与 IR 模式采用互斥程序形态：字节模式使用 `encodingTable` 与 `entrypointAddressHex`，IR 模式使用 `compiledIr`。
6. 字节模式代码区采用 W^X 约束；运行时译码缓存不是权威状态，不进入快照、动作日志或回放。
7. 已增加或接入 `XS-ARCH-WIDTH`、`XS-MEM-PAGE-ALIGN`、`XS-REG-CORE`、`XS-REG-NAMESPACE`、`XS-CUSTOM-DEF`、`XS-CUSTOM-REF`、`XS-CUSTOM-DISPLAY`、`XS-SYSCALL-DECL`、`XS-IFACE-REF`、`XS-IR-LEAVE`、`XS-PROG-MODE`、`XS-CODE-WRX`、`XS-ENC-TOKEN`、`XS-ENC-PROBE` 等规则或对应设计项。
8. 当前已完成的验证命令均通过：
   - `pnpm test`
   - `pnpm build`
   - `pnpm typecheck`
   - `pnpm lint`
   - `git diff --check`

上述通过结果只证明当前工作树中的测试、构建和格式检查通过，不替代下文所需的专项安全、跨语言和阶段退出审查。

### 2.2 明确排除项

- 不重复处理已经完成的 `XS-REG-CORE`，除非后续代码变更导致其行为回归。
- 不在本清单中实现 P4 Rust VM 引擎；P4 进入阶段二，但必须按本文的移交条件执行。
- 不提交私有题目包、真实隐藏 flag、seed、凭证或任何 secret。
- 不将前端混淆、禁用右键、DevTools 检测当作安全控制。
- 未经明确授权，不执行 commit、push 或其他对外发布操作。

---

## 三、优先级定义

| 优先级 | 含义 | 关闭要求 |
|---|---|---|
| P0 | 可能造成秘密泄露、契约越权或权威执行歧义 | 必须在进入下一阶段或合并前关闭 |
| P1 | 影响跨架构正确性、确定性或边界安全 | 应在阶段一退出前关闭，或取得明确豁免 |
| P2 | 契约、文档或测试覆盖不足 | 应在对应批次验收前关闭 |
| P3 | 可独立排期的工程整理项 | 记录负责人、目标批次和临时防护措施 |

---

## 四、待整改事项总表

> 2026-09-04 整改批次关闭后的状态;逐项关闭证据见第十六章关闭记录。

| 编号 | 类别 | 事项 | 优先级 | 当前状态 |
|---|---|---|---|---|
| R1 | 安全边界 | 公开自定义助记符与私有 `customInstructions` 的泄露边界 | P0 | 已关闭(公开 ISA 引用面裁决) |
| R2 | 安全边界 | 公开 `interfaceId` 与私有 `interfaces` 的泄露边界 | P0 | 已关闭(同 R1 裁决) |
| R3 | 架构宽度 | `customInstructions` / `interfaces` 中的架构值检查 | P1 | 已关闭(XS-ARCH-WIDTH 递归覆盖) |
| R4 | 地址边界 | 全部地址区间检查统一覆盖 64 位上溢 | P1 | 已关闭(XS-ADDR-SPACE) |
| R5 | 随机化 | `server_random_per_session` 与固定 `seedHex` 互斥 | P0 | 已关闭(Schema else + XS-SEED-POLICY) |
| R6 | 输入校验 | Ajv `ownProperties: true` 与原型污染防御 | P0 | 已关闭 |
| R7 | 信息泄露 | 检查器错误消息粗化及内部诊断分层 | P0 | 已关闭(服务层接线挂阶段二) |
| R8 | 构建隔离 | 公开入口依赖图与产物扫描 | P0 | 已关闭(`pnpm scan:public`;CI 接线挂 CI workflow 落地) |
| R9 | 契约同步 | `PRIVATE_BUNDLE_FIELDS` 字段数量注释 | P2 | 已关闭(20 字段,数量锁定) |
| R10 | 契约语义 | byte-mode 是否只允许一个 code region | P1 | 已关闭(单代码区冻结) |
| R11 | 契约语义 | FLAG 寄存器是否允许出现在 encoding operand | P1 | 已关闭(不可编码) |
| R12 | 契约语义 | `width` / `displacementWidth` 是否必填 | P1 | 已关闭(必填且恒为 arch) |
| R13 | 契约语义 | 空 `encodingTable` 的纵深防御语义 | P2 | 已关闭(失败关闭) |
| R14 | 测试覆盖 | P5 专项边界、正反和回归测试 | P1 | 已关闭(运行时 `invalid_rip` 挂 P4) |
| R15 | 测试覆盖 | 双包 Schema 严格性测试 | P1 | 已关闭 |
| R16 | 交付审查 | 最终代码审查与安全审查 | P0 | 已关闭(见第十六章) |

---

## 五、公开编码表与私有声明面边界

### R1. 自定义助记符的公开性与泄露风险

**风险**

公开包的 `vmProfile.encodingTable[].op` 当前允许大写自定义助记符；检查器又要求该助记符存在于私有包 `customInstructions[].mnemonic`。这会使公开包直接暴露私有指令名称及其存在性，可能违反“公开描述包与私有判题包严格分离”以及侧信道约束。

**现状**

当前设计同时存在两种语义：编码表承担公开布局/ISA 信息，自定义指令声明承担私有语义映射。两者通过助记符相互关联，公开字段因而可能成为私有声明面的索引。

**整改建议**

在契约评审中二选一并形成记录：

1. 公开编码表只使用无语义的公开 opcode/token 标识；自定义指令名称仅存在于服务端声明面，由服务端完成映射；或
2. 明确将自定义助记符定义为公开 ISA 声明，重新调整字段分类、文档、侧信道分析及玩家可见性说明。

无论采用哪种方案，都不得把自定义指令的微算子、隐藏目标或私有能力返回值发送到浏览器。

**验收标准**

- 字段分类清单、公开/私有 Schema、检查器和文档对自定义助记符的可见性结论一致。
- 公开包无法推导私有微算子语义、私有实现参数或隐藏判题条件。
- 至少有一个公开包扫描测试，证明不存在通过名称或引用 ID 反推出私有定义的路径。

### R2. `interfaceId` 的公开性与泄露风险

**风险**

公开 `encodingTable[].operands[]` 当前允许携带 `interfaceId`，检查器要求该 ID 存在于私有 `interfaces[]`。这会公开接口编号及接口存在性，并可能帮助选手推断 capability 或效果入口。

**现状**

`interfaceId` 既被编码表用作操作数，又被私有接口声明面用作关联键，公开面和私有面之间存在可观察的存在性关联。

**整改建议**

明确接口引用的公开模型：

- 优先改为公开 token 或公开的无语义引用，服务端再将其解析到私有接口；或
- 若接口 ID 本身确实属于公开 ISA，应将其从 server-only 分类中移出，并补充允许玩家推断的边界、能力矩阵和信息泄露论证。

**验收标准**

- 未声明接口、隐藏接口和私有效果原语不会因公开编码表差异产生可利用的存在性信号。
- 公共投影、错误、回放和日志中不出现私有接口定义及其效果细节。
- `XS-IFACE-REF` 的检查路径和错误输出不会把私有对象详情泄露到浏览器。

---

## 六、架构宽度与地址边界

### R3. 自定义声明中的架构宽度检查

**风险**

`XS-ARCH-WIDTH` 已覆盖部分初始寄存器、IR 立即数/位移和公开投影值，但 `customInstructions[].semantics`、`interfaces[].effects` 中的常量可能仍未按 `archBits` 校验。32 位题目若接受超过 32 位的值，会造成 TS Schema、Rust 引擎和回放语义不一致。

**整改建议**

扩展架构宽度检查器，递归覆盖所有声明式微算子和效果原语中的数值、地址、立即数及位移字段。检查必须区分无符号架构值、有符号位移和地址值，并使用统一的错误规则与 JSON Pointer 路径。

**验收标准**

- 32 位模式下超过 `2^32 - 1` 的无符号值和超出有符号范围的位移被拒绝。
- 64 位模式下超过 `2^64 - 1` 的值被拒绝。
- 32 位、64 位各有正例和越界反例。
- 检查器不因私有声明缺失或程序模式不同而静默跳过应检查的字段。

### R4. 地址范围检查统一化

**风险**

`checkEncodingProbe` 已有代码区结束地址上溢检查，但公共和私有地址检查若未统一覆盖 `2^64` 边界，可能出现某一校验路径接受而另一条路径拒绝的差异，影响确定性和安全终止。

**整改建议**

抽取或统一地址区间计算规则：明确起始地址、区域大小、结束地址的半开区间语义，统一检查 `end <= 2^64`，禁止无符号加法静默回绕。统一规则 ID、错误路径和边界值表达。

**验收标准**

- 所有涉及地址与长度的公共、私有、入口和代码探测检查均覆盖 0、最大合法结束地址和上溢三类边界。
- `2^64 - 1` 末字节可合法表示，越过 `2^64` 必须失败关闭。
- TS 检查器与后续 Rust 引擎使用同一半开区间约定。

---

## 七、seed 与随机化约束

### R5. 会话随机策略与固定 seed 互斥

**风险**

当随机策略为 `server_random_per_session` 时，题目包若同时携带固定 `seedHex`，会产生策略歧义，并可能使回放、重放或题目实例化结果与作者预期不一致。

**整改建议**

在 Schema 能表达的范围内增加条件约束；其余约束由 server-only 检查器实现：

- `server_random_per_session` 时禁止 `seedHex`；
- 使用固定 seed 的策略必须显式声明可回放所需的 seed 来源和环境版本；
- seed 只在服务端执行域和必要的回放元数据中驻留，不进入浏览器公开投影。

**验收标准**

- 固定 seed 与会话随机策略同时出现时有稳定、可解释的拒绝结果。
- 正确策略组合均有绿灯测试。
- 回放信息不会将隐藏 seed 暴露给浏览器或公开日志。

---

## 八、Ajv 与输入校验

### R6. 自有属性校验与原型污染防御

**风险**

若 Ajv 未启用 `ownProperties: true`，对象校验可能受继承属性影响；结合外部 JSON、对象合并或服务端边界处理，可能扩大原型污染和契约绕过风险。

**整改建议**

确认所有 Schema 校验入口使用统一 Ajv 实例和明确的 `ownProperties: true` 配置；检查 `$data`、自定义关键字、对象合并和错误转换路径，确保不会把继承属性当作题目包字段。对带原型属性、非自有属性和 `__proto__` / `constructor` / `prototype` 形态的输入补充拒绝测试。

**验收标准**

- 所有公开包、私有包和跨包检查入口使用同一安全配置或有等价证明。
- 非自有属性不会改变校验结果。
- 原型污染形态被拒绝且不会改变进程内其他对象。
- 错误处理不回显完整恶意输入。

---

## 九、错误消息与信息泄露

### R7. 检查器错误消息分层

**风险**

当前部分检查器错误消息可能包含私有值、私有对象 ID、虚拟文件 ID、隐藏区域 ID 或其他判题细节。若这些消息沿错误契约进入浏览器、公开日志或回放，会违反浏览器不可信与秘密零驻留约束。

**整改建议**

将错误分为两层：

- **内部诊断**：仅供服务端审查、结构化日志和开发测试使用，允许保留必要上下文，但不得直接下发。
- **公开错误**：只使用稳定的 `PublicError` code、粗化后的解释和公共路径；不得包含私有值、私有 ID、隐藏区域信息、完整 IR、文件路径或精确判题差异。

同时复核错误的长度、分类、返回时序和 HTTP/WSS 状态差异，避免通过侧信道恢复私有信息。

**验收标准**

- 浏览器可达的错误均符合 `PublicError` 契约及对应能力矩阵。
- 服务端错误日志与公开错误使用不同序列化边界。
- 对错误内容做快照/扫描测试，确认不包含隐藏 flag、seed、私有包字段、完整 IR 或内部路径。
- 错误粗化不会妨碍合法用户理解可修复的输入问题。

---

## 十、公开构建图与产物隔离

### R8. 公开入口依赖与产物扫描

**风险**

公开入口若静态依赖 `node:fs`、私有 Schema 文件名、私有 Schema 加载器、server-only 子路径或 VM 引擎产物，可能导致私有契约进入浏览器 bundle，破坏信任域隔离。

**整改建议**

执行并固化以下门禁：

1. 对 `protocol`、`vm-ui`、`web-component`、`embed-runtime`、`react-wrapper` 的公开入口进行依赖图扫描。
2. 禁止公开构建图引用 `vm-engine`、`challenge-schema/server-only`、私有题目包加载器、`node:fs` 等服务端专用模块。
3. 对构建产物执行字符串、路径和包名扫描，检查私有 Schema 文件名、完整 IR、隐藏测试、seed、flag 和 worker 二进制。
4. 将扫描纳入 CI，并提供误报豁免的最小说明和过期机制。

**验收标准**

- 公开入口的静态依赖图不包含 server-only 和 VM Core 产物。
- 浏览器产物扫描无私有 Schema、题目包、完整 IR、隐藏测试、seed、flag 或二进制残留。
- CI 在新增越权依赖时失败，而不是只产生提示。

---

## 十一、契约、语义与文档一致性

### R9. 同步 `PRIVATE_BUNDLE_FIELDS` 字段数量注释

**现状**

`PRIVATE_BUNDLE_FIELDS` 当前数组实际包含 21 个字段，但相关注释仍写“19 个顶层字段”。

**整改建议**

同步注释、字段分类清单、Schema 语义文档和防漂移测试，避免后续维护者依据过时数量遗漏字段。

**验收标准**

- 注释中的数量与数组实际长度一致。
- 字段分类测试能在新增或删除字段时失败。
- 文档明确“字段数量变化需要同步分类清单和 Schema”。

### R10. byte-mode 的 code region 数量语义

**风险**

当前 `checkEncodingProbe` 要求恰有一个公开 code region 和一个私有 code region，但其他文档若允许多个代码区，会产生 Schema、检查器和引擎语义冲突。

**整改建议**

冻结 byte-mode 的代码区模型：

- 若 MVP 只允许一个代码区，应在 Schema 语义、检查器错误、测试和引擎移交文档中明确；
- 若未来允许多个代码区，应定义 `entrypointAddressHex` 所属区域、跨区域取指、区域优先级和静态探测边界，并将多区域支持列为后续版本，不以隐式行为兼容。

**验收标准**

- 文档、Schema、检查器和 fixture 对单区域/多区域结论一致。
- 多代码区反例具有明确拒绝规则，或有完整的多区域正例与地址解析测试。

### R11. FLAG 寄存器与 encoding operand

**风险**

寄存器命名空间允许 `FLAG...` 保留区，但 encoding operand 是否允许引用 FLAG 寄存器尚未冻结。若表层编码把 FLAG 寄存器烘焙进 token，可能绕过普通寄存器引用规则或改变条件码教学语义。

**整改建议**

明确 FLAG 是否为可编码操作数：

- 若不允许，在 Schema 与检查器中拒绝 encoding operand 对 FLAG 的引用；
- 若允许，定义读写权限、宽度、条件分支关系、公开显示语义及 Rust 引擎规约。

**验收标准**

- 普通寄存器、FLAG 寄存器、未知寄存器各有明确正反测试。
- `mov`、算术、比较和条件跳转对 FLAG 的行为不会依赖未声明的隐式规则。

### R12. 操数宽度字段是否必填

**风险**

当前 TypeScript 类型和 Schema 允许省略 `width` / `displacementWidth`，而设计方向倾向显式声明 `arch`。省略时若由不同执行层推断，可能造成编码长度和地址偏移不一致。

**整改建议**

冻结为“必填”或“可选但有唯一默认值”之一。优先考虑要求显式 `arch`，使表层机器码长度、译码、静态探测和回放都不依赖隐式推断。

**验收标准**

- 同一表项在 TS 校验器、Rust 译码器和文档中的编码长度一致。
- 省略字段的行为若仍合法，默认值必须写入规范并有测试；若不合法，Schema 直接拒绝。

### R13. 空 `encodingTable` 的纵深防御语义

**风险**

Schema 要求 `encodingTable.minItems = 1`，但检查器的模式判断使用“字段是否存在”。空数组可能在 Schema 绕过、直接调用检查器或未来 Schema 放宽时形成不明确状态。

**整改建议**

保持失败关闭：只要 `encodingTable` 存在，就必须是非空有效表；直接调用检查器时也应产生明确的 `XS-ENC-TOKEN` 或等价规则错误，而不是静默退回 IR 模式。

**验收标准**

- 空表通过 Schema 校验入口时被拒。
- 直接调用跨包检查器时空表也被拒。
- `undefined`、空数组和有效数组三种状态的程序模式判定均有测试。

---

## 十二、P5 与 Schema 测试补充

### R14. P5 专项测试矩阵

应补齐以下行为测试，并保证每条关键规则至少有一个真正触发检查器的红灯样例，而不是在 Schema 预校验阶段提前失败：

- 32 位 immediate；
- 64 位 immediate；
- memory displacement；
- `syscall` 保留号；
- `syscall` 已声明接口号；
- `syscall` 未声明接口号；
- `call` 的 immediate、register、interface 三种绿灯路径；
- `ret` / `leave` 携带非零操作数；
- 自定义助记符及其操作数；
- token 大小写重复；
- 代码区缺失；
- 代码区尾地址边界与上溢；
- 达到和超过 `MAX_IR_INSTRUCTIONS` 的探测；
- `leave` 有 RBP 的绿灯路径；
- 非零入口偏移；
- 未知 token、截断 immediate、截断 displacement；
- 入口位于代码区非首字节的 gadget；
- 运行时未知 token / 截断统一落到 `invalid_rip` 的引擎测试（进入 P4 后执行）。

**关闭标准**

测试命名采用行为描述；断言同时覆盖规则 ID、路径和可解释错误；正例确认不会被无关规则污染；关键边界至少覆盖 32 位和 64 位。

### R15. 双包 Schema 严格性测试

补齐并回归以下 Schema 场景：

- byte-mode 可省略 `compiledIr`，但必须有 `entrypointAddressHex`；
- IR-mode 可省略入口地址，但必须有 `compiledIr`；
- 两种程序字段双给和双缺；
- 非法入口地址；
- 非法 `tokenHex`；
- operand 的 `additionalProperties`；
- 私有包拒绝公开字段；
- `encodingTable` 最大数量及超过上限；
- `interfaceId` 范围；
- `width` / `displacementWidth` 只接受约定值；
- `archBits` 缺失、非法值及跨包位宽不一致；
- `custom` 区域与 4KB 对齐；
- 私有声明字段的严格对象边界。

**关闭标准**

正反 fixture 均被记录；Schema 版本、golden fixture 和跨包检查器使用同一套样例；新增字段必须同步防漂移测试。

---

## 十三、最终代码审查、安全审查与阶段移交

### R16. 最终审查门禁

在把本批次标记为关闭前，必须完成：

1. 通读所有已修改 TypeScript、Schema、fixture 和文档，确认规则 ID、路径、错误码和版本号一致。
2. 执行 TypeScript 代码审查，重点检查不可达分支、可选字段解引用、数组索引对应的 JSON Pointer、数值溢出和错误处理。
3. 执行安全审查，重点检查公开/私有边界、原型污染、错误信息、构建产物、seed、隐藏题目数据和 server-only 依赖。
4. 执行依赖边界和公开产物扫描。
5. 执行完整测试、构建、lint、typecheck 和格式检查，并记录真实执行结果，避免只引用缓存日志。
6. 明确当前工作树未提交、未 push 的状态；如需提交，另行取得授权。

### 阶段二 P4 移交条件

P4 引擎实现进入阶段二时，至少应携带以下契约验收清单：

- `archBits` 掩蔽以及算术、移位、比较语义；
- 自由寄存器集与 FLAG 保留命名空间；
- 4KB 分页与 VMA 区间；
- `leave` 栈帧语义；
- 自定义指令封闭微算子解释器；
- `syscall` / `call` 接口派发；
- 字节取指与译码；
- 译码缓存不进入状态哈希、COW 快照、动作日志和回放；
- 静态探测未覆盖部分的运行时 `invalid_rip` 兜底；
- W^X 代码区写入统一产生 `memory_fault`；
- 交互执行与 verifier 回放复用同一份引擎代码。

---

## 十四、建议执行顺序

1. **先关闭 P0 安全边界项**：R1、R2、R5、R6、R7、R8。
2. **冻结契约歧义**：R10、R11、R12、R13，并同步 Schema、检查器、fixture 和语义文档。
3. **补齐架构与地址边界**：R3、R4。
4. **补齐专项测试**：R14、R15；随后重新执行全量回归。
5. **完成文档整理**：R9 及相关版本、字段数量、规则清单和验证结果回填。
6. **执行最终代码审查与安全审查**：R16。
7. **满足移交条件后进入 P4**，不得以“文档已写明”替代引擎行为验证。

---

## 十五、关闭记录模板

每一项关闭时，按以下格式补充记录：

| 字段 | 内容 |
|---|---|
| 编号 | 例如 `R3` |
| 关闭日期 | `YYYY-MM-DD` |
| 实现位置 | 文件路径与行号/导出符号 |
| 测试证据 | 测试文件、用例名、执行命令 |
| 安全审查 | 是否涉及公开/私有边界；审查结论 |
| 文档同步 | 已同步的 Schema、语义文档、计划书或 CLAUDE.md |
| 遗留风险 | 若未完全关闭，记录临时约束、负责人和目标批次 |

在所有 P0 和 P1 项关闭、专项测试通过、公开构建隔离通过、最终代码审查与安全审查完成前，不得将 VM 契约整改标记为“全部完成”。

---

## 十六、关闭记录(2026-09-04 整改批次)

> 本批次按第十四章顺序执行:R1/R2/R5/R6/R7/R8(P0)→ R10–R13(契约冻结)→ R3/R4(边界)→ R14/R15(测试)→ R9(文档)→ R16(审查)。
> 除本章记录外,`PRIVATE_BUNDLE_FIELDS` 实际长度为 **20**(本章记录之前,清单原文 v1.0 所记"21"与代码注释"19"均为漂移值,以当前数组为准)。

### R1 / R2 — 公开 ISA 引用面裁决(P0)

| 字段 | 内容 |
|---|---|
| 编号 | R1、R2(合并裁决) |
| 关闭日期 | 2026-09-04 |
| 裁决 | 二选一中采纳**方案 2 变体(公开 ISA 引用面)**:公开 `encodingTable[].op` 的自定义助记符与 `operands[].interfaceId` 是经裁决的公开 ISA 引用——仅揭示"存在哪些指令 / 接口及其公开标识"(字节模式 ISA 公开立场的必然推论:代码区恒公开、谜题在 gadget 构造不在解码);`customInstructions` 微算子语义 / `displayText`、`interfaces` 效果序列整体 SERVER_ONLY 不变。未采纳方案 1(公开无语义 token):其仍泄露"非基线 token = 自定义指令"的存在性信号,却要引入 publicRef 双键映射的契约改动,收益不成比例 |
| 实现位置 | `packages/challenge-schema/src/server-only/checker/index.ts`(裁决记录与 `PUBLIC_FACING_ERROR_CODE_FOR_VIOLATIONS` 相邻);`src/common/classification.ts` 与 `schema/classification.json` 的 note 补充裁决;检查器行为不变(未声明引用由 `XS-ENC-TOKEN` 拒绝,原有规则即裁决的机制面) |
| 测试证据 | `test/isa-reference-face.test.ts`:全链路绿灯、公开包深扫描断言不含微算子词汇 / 效果原语 / displayText / fileId / FLAG 名 / 秘密值、未声明助记符与接口号红灯、公开面携带裁决标识的正面断言 |
| 安全审查 | 公开引用的存在性信号只在作者选择暴露时产生(未声明引用即拒),与 objectId / fileId 的值级引用不同——助记符与接口号是 ISA 标识而非私有对象指针;公共投影 / 错误 / 回放不出现私有接口定义(私有声明面整体 server-only,机制原样) |
| 文档同步 | `双包Schema语义.md` v1.5(§2.2 encodingTable 行 + §五裁决段)、WP-1 清单 v1.8(§12.2 语义补全 + 变更记录)、CLAUDE.md |

### R3 — 架构宽度递归覆盖(P1)

| 字段 | 内容 |
|---|---|
| 编号 | R3 |
| 关闭日期 | 2026-09-04 |
| 实现位置 | `src/server-only/checker/arch-rules.ts` `checkArchWidth`:递归覆盖 `customInstructions[].semantics`(load_imm / set_flag `valueHex`、bit_mask `maskHex` 无符号;load_mem / store_mem `displacementHex` 有符号位移)与 `interfaces[].effects` set_flag `valueHex`;声明面存在即检查,与程序模式 / `compiledIr` 存在与否无关 |
| 测试证据 | `test/checker.test.ts` R3 describe:32 位四类微算子越界(路径逐项断言)、32 位接口 set_flag 越界、64 位域上界之外绕过 Schema 直测、32 位边界值 0xFFFFFFFF / −0x80000000 绿灯 |
| 安全审查 | 不涉及公开/私有边界变化;统一区分无符号架构值与有符号位移,TS 与后续 Rust 引擎同一语义(计划书 6.2) |
| 文档同步 | `双包Schema语义.md` §5 XS-ARCH-WIDTH 行、WP-1 清单 v1.8 |

### R4 — 地址区间 64 位上界统一(P1)

| 字段 | 内容 |
|---|---|
| 编号 | R4 |
| 关闭日期 | 2026-09-04 |
| 实现位置 | `src/server-only/checker/address-ranges.ts`:`ADDRESS_SPACE_END_EXCLUSIVE`(2^64)与 `rangeExceedsAddressSpace`(半开区间,末字节 0xFFFFFFFFFFFFFFFF 合法);`public-rules.ts` `checkPublicAddressSpaceBounds`(公开区域)、`private-rules.ts` `checkPrivateAddressSpaceBounds`(私有区域 + 私有对象)、`encoding-rules.ts` 探测复用同一常量(不再内联 `1n << 64n`) |
| 测试证据 | `test/checker.test.ts` R4 describe:结束地址恰 2^64 绿灯、公开 / 私有隐藏区域 / 私有对象 / 双侧越界红灯(路径逐项)、字节模式代码区越界探测红灯;0 起点 / 最大合法末字节 / 上溢三类边界覆盖 |
| 安全审查 | BigInt 不回绕,上溢失败关闭;TS 与 Rust 引擎(阶段二)共用半开区间约定,写入 P4 移交契约 |
| 文档同步 | `双包Schema语义.md` §5 XS-ADDR-SPACE 行 |

### R5 — seed 策略互斥(P0)

| 字段 | 内容 |
|---|---|
| 编号 | R5 |
| 关闭日期 | 2026-09-04 |
| 实现位置 | `schema/private-bundle.schema.json` seedPolicy:`then`(fixed ⇒ seedHex 必填)+ 新增 `else`(server_random_per_session ⇒ `seedHex: false` 禁止);`src/server-only/checker/private-rules.ts` `checkSeedPolicy`(XS-SEED-POLICY 两向检查,Schema 之外第二道防线) |
| 测试证据 | `test/hardening.test.ts`:Schema 层四组合(2 绿 2 红)+ 检查器层红灯双向与正确组合绿灯 |
| 安全审查 | seed 仍整体秘密:互斥只消除实例化 / 回放策略歧义;回放元数据承载 seed 策略与派生路径声明,不承载 seed 值;`declaredSeedPublicPaths` 与 T-SC4 机制原样 |
| 文档同步 | `双包Schema语义.md` §3.1 seedPolicy 行、WP-1 清单 v1.8、CLAUDE.md |

### R6 — Ajv ownProperties 与原型污染防御(P0)

| 字段 | 内容 |
|---|---|
| 编号 | R6 |
| 关闭日期 | 2026-09-04 |
| 实现位置 | `src/internal/schema-loader.ts`:`compileSchema` 统一启用 `ownProperties: true`(公开 / 私有面同一实例配置);`toSchemaViolations` 回显属性名截断至 80 字符 |
| 测试证据 | `test/hardening.test.ts`:原型继承属性不满足 required、`__proto__` / `constructor` / `prototype` 键形态拒绝且无原型污染、寄存器映射 `__proto__` 键拒绝、超长恶意属性名不回显 |
| 安全审查 | 继承属性不再满足 required / 不被视为包字段;JSON.parse 产物本无原型链,防线覆盖手写对象与服务端合并路径;检查器输入以 Object.entries(自有键)遍历,生产输入经 Schema 校验前置 |
| 文档同步 | `双包Schema语义.md` §5.1 |

### R7 — 错误两层模型(P0)

| 字段 | 内容 |
|---|---|
| 编号 | R7 |
| 关闭日期 | 2026-09-04 |
| 实现位置 | `src/server-only/checker/index.ts`:头部两层模型说明 + `PUBLIC_FACING_ERROR_CODE_FOR_VIOLATIONS = "internal_error"` 导出常量(server-only 面);`schema-loader.ts` 回显截断 |
| 测试证据 | `test/hardening.test.ts`:多场景违规消息 / 路径对 flag / seedHex / 虚拟文件内容哨兵零携带;映射目标在协议 `public-error.schema.json` 16 码词汇内(跨包防漂移) |
| 安全审查 | 违规题目包在装载期被拒,不存在带病服务会话;玩家侧统一 internal_error,逐规则细分仅存于内部诊断与管理后台(信任域 4) |
| 文档同步 | `双包Schema语义.md` §5 前置说明、WP-1 清单 v1.8 |
| 遗留风险 | 错误长度 / 分类 / 返回时序的运行时侧信道复核在 session-api(阶段二)落地时按 WP-1 §10.1 执行;负责人:阶段二 session-api 实现者 |

### R8 — 公开构建图与产物隔离(P0)

| 字段 | 内容 |
|---|---|
| 编号 | R8 |
| 关闭日期 | 2026-09-04 |
| 实现位置 | `tooling/scan-public-artifacts.mjs`(新):公开包(protocol / vm-ui / web-component / embed-runtime / react-wrapper,未落地自动跳过)从 exports 公开入口(排除 server-only 子路径)做 dist 静态依赖图 BFS;可达文件禁止 server-only 子树、node 内建、challenge-schema / vm-engine 引用;剥离注释后扫描私有面标记(私有 Schema 名、私有顶层字段、capability 前缀、require);豁免表 `ALLOWLIST` 带原因与到期机制;根 `package.json` 固化 `pnpm scan:public` |
| 测试证据 | 本批次真实执行:`pnpm scan:public` 通过(protocol 25 个可达文件,0 违规;其余包 dist 未落地自动跳过并显式报告);自检确认 BFS 覆盖正确(server-only / generate 不可达) |
| 安全审查 | 门禁以退出码 1 失败(非提示);私有 Schema 文件名与字段名不在可达产物 |
| 文档同步 | 根 package.json scripts;CI workflow 建立时纳入(见遗留风险) |
| 遗留风险 | 仓库尚无 CI workflow,`pnpm scan:public` 在 CI 建立时作为必过步骤接入;负责人:CI 落地批次;浏览器侧包(vm-ui 等)落地后扫描自动纳入 |

### R9 — 字段数量同步(P2)

| 字段 | 内容 |
|---|---|
| 编号 | R9 |
| 关闭日期 | 2026-09-04 |
| 实现位置 | `src/common/classification.ts`:注释 19 → **20**(实数核对:数组 20 项),注释明确"字段数量变化必须同步数组、classification.json、两份 Schema、语义文档" |
| 测试证据 | `test/strictness.test.ts`:分类清单 ≡ 常量(含 note 深比较)、顶层 properties ≡ 数组、`PRIVATE_BUNDLE_FIELDS` 数量锁定 20(字段增删时先红) |
| 安全审查 | 不涉及 |
| 文档同步 | CLAUDE.md(19 → 20)、本清单 v1.0 总表"21"更正说明、`双包Schema语义.md` §3.1 字段行核对 |

### R10–R13 — 契约语义冻结(P1/P2)

| 字段 | 内容 |
|---|---|
| 编号 | R10、R11、R12、R13 |
| 关闭日期 | 2026-09-04 |
| 裁决 | R10:字节模式代码区冻结为**恰一个公开 + 恰一个非隐藏私有代码区**(公开侧 ≤ 1 原有 D2 承接;新增私有面"代码区不得隐藏",封住 IR 模式下隐藏代码区表达位);R11:**FLAG 寄存器不可编码**(寄存器 / 基址限一般命名空间,Schema 负向前瞻结构性排除 + 检查器复核;IR 内 FLAG 可读性归引擎语义,微算子封闭集唯一 FLAG 写入是 set_flag,原状);R12:`immediate.width` / `memory.displacementWidth` **必填**且恒为 `"arch"`(机器码长度、译码、探测、回放不依赖隐式推断;编码长度 = 表条目纯函数);R13:`encodingTable` **存在即字节模式**,空数组失败关闭报 XS-ENC-TOKEN,不回退 IR 模式 |
| 实现位置 | `schema/public-descriptor.schema.json`(required 迁移 + 描述)、`src/common/public-types.ts`(镜像类型同步)、`src/server-only/checker/encoding-rules.ts`(checkShapeReferences 无条件宽度检查、checkEncodingTable 空表防线、checkProgramMode 语义注释)、`src/server-only/checker/private-rules.ts`(checkPrivateCodeRegionVisibility,记 D2-CODE-PUBLIC) |
| 测试证据 | `test/checker.test.ts` R10–R13 describe(私有双代码区 / 隐藏代码区 / FLAG operand 绕过 / 双宽度绕过 / 三态判定)与 `test/public-descriptor.test.ts`(Schema 层 width / displacementWidth 缺失与非法值、FLAG operand、空表 minItems) |
| 安全审查 | 全部为失败关闭方向的收紧;信封版本不递增(仓库尚无发布题目,整改清单裁决整体重定基,与 v1.1–v1.4 先例一致) |
| 文档同步 | `双包Schema语义.md` v1.5(§2.2、§5 XS-ENC-TOKEN / D2-CODE-PUBLIC 行)、`docs/contracts/最小DSL范围.md` §三.4.1(内联操作数必填 / FLAG 不可编码 / 单代码区 / 空表)、WP-1 清单 v1.8、CLAUDE.md |

### R14 — P5 专项测试矩阵(P1)

| 字段 | 内容 |
|---|---|
| 编号 | R14 |
| 关闭日期 | 2026-09-04 |
| 实现位置 | `test/checker.test.ts` 新增 R14 describe(12 项)+ 既有 P5 describe(原有 13 项) |
| 测试证据 | 矩阵逐项:32 位 immediate(4 字节派发号探测)、64 位 immediate(既有)、memory displacement(截断位移红灯)、syscall 保留号绿灯 / 已声明接口绿灯 / 未声明接口红灯、call 三形态绿灯、ret / leave 非零操作数红灯、自定义助记符及其操作数红灯、token 大小写重复红灯、代码区缺失红灯、尾地址边界与上溢(R4 块)、达到(字节绿灯基线恰 4096 条)与超过(8192 字节区域)MAX_IR_INSTRUCTIONS、leave 带 RBP 绿灯、非零入口偏移(gadget 绿灯)、未知 token / 截断 immediate / 截断 displacement 红灯;断言覆盖规则 ID + 路径 + 可解释消息,红灯样例真实触发检查器(Schema 放行的绕过形态以类型断言直测并注明) |
| 安全审查 | 不涉及 |
| 文档同步 | — |
| 遗留风险 | 「运行时未知 token / 截断统一落 `invalid_rip`」为引擎行为测试,随 P4 进入阶段二执行(P4 移交条件已含) |

### R15 — 双包 Schema 严格性测试(P1)

| 字段 | 内容 |
|---|---|
| 编号 | R15 |
| 关闭日期 | 2026-09-04 |
| 实现位置 | `test/public-descriptor.test.ts`(编码表严格性 + R15 补充 describe,12 项)、`test/private-bundle.test.ts`(程序形态与公开面隔离 describe,6 项 + 声明面边界 2 项) |
| 测试证据 | 矩阵逐项:字节模式省略 `compiledIr` 且有入口绿灯、IR 模式有 `compiledIr`(基线)、双给 / 双缺 Schema 放行 + 检查器拒绝的分层事实固化、非法入口地址、非法 tokenHex、operand additionalProperties、私有包拒绝公开字段(memoryLayout / archBits)、编码表上限、interfaceId 255 / 65536、width / displacementWidth 仅接受约定值、archBits 缺失 / 非法 / 私有复制拒绝、custom 区域 4KB 对齐、声明面严格对象边界(hostHandler / handlerPointer 形态) |
| 安全审查 | 正反 fixture 全部在测试内构造,无私有样例入 git(红线保持) |
| 文档同步 | — |

### R16 — 最终审查门禁(P0)

| 字段 | 内容 |
|---|---|
| 编号 | R16 |
| 关闭日期 | 2026-09-04 |
| 执行内容 | 1) 通读全部改动(规则 ID / 路径 / 错误码 / 版本一致性核对:新增规则 XS-SEED-POLICY、XS-ADDR-SPACE 均已同步 §12.6 对照与语义文档;D2-CODE-PUBLIC 私有面沿用既有规则 ID);2) TS 代码审查 + 安全审查由独立审查代理执行(重点:不可达分支、可选字段解引用、JSON Pointer 对位、BigInt 边界、公开/私有边界、原型污染、错误信息、构建产物、seed、server-only 依赖);3) 依赖边界 `pnpm lint:deps` 通过(187 模块 549 依赖 0 违规);4) 公开产物扫描 `pnpm scan:public` 通过;5) 全量回归真实执行(非缓存引用):`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm test`(challenge-schema 7 文件 221 用例全绿,较整改前 154 例新增 67 例)、`git diff --check` 干净 |
| 审查发现与处理 | 审查结论:无 CRITICAL / HIGH,APPROVE。发现 2 MEDIUM + 3 LOW,全部当场修复并回归:MEDIUM-1 扫描器注释剥离不识别正则字面量(可致私有面标记漏报)→ 剥离器增正则字面量感知 + 启动自检(`selfTest`,失败即拒扫);MEDIUM-2 exports 条件缺 default 时静默漏扫 → default/import 回退解析,均缺失即显式报错,specifier 解析扩展 .mjs/.cjs;LOW-1 错误回显截断未覆盖 instancePath → 路径同截断(200 字符);LOW-2 探测违规路径取过滤数组下标(代码区非首位时指错区域)→ 改锚 initialState.memoryRegions 全数组真实下标;LOW-3 两处测试注释指令数算术错误 → 更正(断言本就正确) |
| 审查结论 | P0/P1 项全部关闭;R7 运行时侧信道复核与 R8 CI 接线为已登记的阶段二遗留义务(见各自关闭记录) |
| 状态 | 工作树保持未提交、未 push(清单 §2.2 排除项:对外发布操作需另行授权) |

### 阶段二 P4 移交补充

第十三章移交条件清单维持原文,本批次新增两条随移交执行的契约验收项:

- 地址区间半开区间语义与 `2^64` 上界(R4:TS 侧 `ADDRESS_SPACE_END_EXCLUSIVE` 同公式,Rust 侧不得引入第二条上界规则);
- 编码操作数宽度必填(R12:译码器不得对缺失宽度做任何隐式推断——Schema 已拒绝,引擎按前置条件信任表条目)。

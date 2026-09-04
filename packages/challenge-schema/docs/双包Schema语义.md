# 双包 Schema 语义(WP-4 · v1.3)

| 项 | 值 |
|---|---|
| 题目包 Schema 版本 | `1`(`CHALLENGE_PACKAGE_SCHEMA_VERSION`,破坏性变更递增,见 §7) |
| 状态 | 阶段一 WP-4 交付物,双包 Schema 与分类检查器冻结;v1.3 按《Vm 模块设计冲突与整改方案》完成 G4/D4 重定基(v1.2 已完成 G2,v1.1 已完成 G1/G3) |
| 修订 | v1.3(2026-09-04):G4/D4——基线 opcode 21→20(`read`/`write` 废止,教学 IO 收敛;新增 `leave` 栈帧伪指令);IR `op` 双形态 anyOf(基线小写枚举 ∪ 大写自定义助记符 `^[A-Z][A-Z0-9_]{0,15}$`,大小写结构性不相交);新增顶层声明面 `customInstructions`(≤ 16 条,`semantics` = 微算子封闭集 v1 直线序列 ≤ 16)与 `interfaces`(≤ 16 条,`interfaceId` ∈ [0x100, 0xFFFF],`effects` = 效果原语封闭集 v1 直线序列 ≤ 16);操作数槽新增 `interface` 形态(`call` 的结构化接口引用);`dslSchemaVersion` / `irFormatVersion` 冻结常量 1→2;syscall 定基为封闭单值伪操作(保留系统号带 [0x0, 0xFF] 内置 exit 不变);检查器新增 `XS-CUSTOM-DEF` / `XS-CUSTOM-REF` / `XS-SYSCALL-DECL` / `XS-IFACE-REF` / `XS-IR-LEAVE` / `XS-CUSTOM-DISPLAY`,`XS-ID-UNIQUE` 承接助记符与接口号唯一性;v1.2(2026-09-04):G2——寄存器命名放开为双命名空间保留模型:一般寄存器自由命名 `^[A-Z][A-Z0-9_]{0,15}$`(负向前瞻排除 FLAG 保留区),冻结 14 基集废止,新增必选核心寄存器 `RSP`/`RBP`/`RIP`;`vmProfile.registers` 语义改为"本题目寄存器集的定义性声明";数量护栏放宽(`registers` 1–64、私有初始寄存器 ≤ 256);检查器规则 `XS-REG-FROZEN` 废止,新增 `XS-REG-CORE` / `XS-REG-NAMESPACE`,`XS-REG-SUBSET` 重锚为声明集子集;v1.1(2026-09-04):G1——`vmProfile.archBits`(32/64)位宽声明入公开包,架构值 = archBits 位宽、64 位容器承载、高位掩蔽,新增检查器规则 XS-ARCH-WIDTH;G3——区域类型增补作者自定义 `custom` 类,区域大小与 `pageSizeBytes` 收紧为 4KB 的倍数,新增检查器规则 XS-MEM-PAGE-ALIGN。信封版本 `CHALLENGE_PACKAGE_SCHEMA_VERSION` 不递增:仓库尚无发布题目,变更经整改方案裁决整体重定基(`dslSchemaVersion` 的递增随 G4/P3 批次落地);v1(2026-09-03):阶段一 WP-4 冻结初版 |
| 日期 | 2026-09-04 |
| 契约单一来源 | 本包 `schema/*.schema.json`(手写 JSON Schema 2020-12 + Ajv;计划书 5.4 技术选型原文);TS 类型为手工镜像,完整正反样例测试防漂移(§6) |
| 上游依据 | 计划书 7.1–7.4(双包模型 / 扩展语义 / DSL 边界 / 版本管理)、6.1(MVP 虚拟硬件)、6.2(archBits 位宽掩蔽域)、13.2(题目包测试);WP-1 清单 **v1.6** 第十二章(双包字段级分类)、§3.2(寄存器命名与双命名空间保留模型)、§12.5(FLAG 保留区)、I-1–I-10、ZR-B8、10.5(T-SC4);`docs/最小DSL范围.md` v1.2(指令面 / 谓词面 / 编排面词汇,G4/D4 重定基);`docs/develop/Vm 模块设计冲突与整改方案.md`(G1/G3/G2/G4 裁决) |
| 效力范围 | 公开描述包与私有判题包的 JSON Schema、字段分类清单(`schema/classification.json`)、字段分类检查器(`./server-only` 子路径);阶段二 `challenge-compiler` / session-api / verifier 消费;与计划书、WP-1 清单冲突时依次以计划书、WP-1 清单为准 |

**变更纪律**:与 protocol 语义文档相同——任何字段、枚举值或语义变更须先走 WP-1 §1.3 契约变更流程(先改 WP-1 第十二章分类论证 → 改本包 Schema 与正反 fixture → 评审 → 再改实现);破坏性变更递增 `CHALLENGE_PACKAGE_SCHEMA_VERSION` 并保留 N-1 兼容窗口(§7)。

---

## 一、范围与冻结清单

本 WP 冻结:

1. **公开描述包 Schema**(`schema/public-descriptor.schema.json`,`x-sm-class: public`):计划书 7.1 公开七项清单的逐项落位(WP-1 §12.2 逐字段硬门槛论证);
2. **私有判题包 Schema**(`schema/private-bundle.schema.json`,`x-sm-class: server-only`):7.1 私有七项清单落位(WP-1 §12.3);**Schema 存在不等于可下发**——仅经 `@stackmaster/challenge-schema/server-only` 子路径供后端包(challenge-compiler、session-api、verifier)消费,镜像 protocol `ProjectionPolicy` 先例;
3. **字段分类清单**(`schema/classification.json`):与 `src/common/classification.ts` 常量严格一致(测试强制),供 CI 的 ZR-P1 / I-1 类机检直接引用;
4. **字段分类检查器**(`src/server-only/checker/`):规则 ID 与依据对照见 WP-1 §12.6,逐规则语义见 §5;
5. `docs/最小DSL范围.md`(仓库级文档):指令面 20 基线 opcode + 微算子封闭集 v1 + 效果原语封闭集 v1 / 谓词面封闭集 / 编排面状态机的词汇冻结(G4/D4 v1.2)。

**不归本 WP 冻结**(边界声明):

- **DSL → IR 编译器**与逐 opcode 操作数合法性、CFG 可达性校验归阶段二 `challenge-compiler`(§5.9 分工表);本 WP 的 Schema 对 IR 只做结构性约束;
- 私有包的**运行时消费**(装载、seed 派生、谓词求值、投影策略组装)归阶段二/三;本 WP 冻结数据形态与静态不变量;
- 公开包的 CDN 分发、签名与哈希(7.1 发布流程后半段)归阶段六;
- 版本迁移工具与 fixture 跨语言往返(WP-6)。

## 二、公开描述包(Public Challenge Descriptor)

根约束:每层 `additionalProperties: false`(I-1);全文件无 `$ref` / `$defs`;`$schema` = `https://json-schema.org/draft/2020-12/schema`;`$id` = `https://stackmaster.dev/schemas/challenge/v1/public-descriptor.schema.json`;`x-sm-class: public`。

### 2.1 顶层字段(14 个,冻结)

| 字段 | 类型(冻结) | 语义与规则 |
|---|---|---|
| `schemaVersion` | const `1` | 格式信封版本 |
| `challengeId` | `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$` | 题目公开标识符 |
| `challengeContentVersion` | `^\d+\.\d+\.\d+$` | 7.4 第 4 类版本 |
| `vmProfileVersion` | `^\d+\.\d+\.\d+$` | 7.4 第 3 类版本;与私有包同值(XS-ID-CORR) |
| `locale` | enum `["zh-CN"]` | 语言标签(v1 单值;扩展走枚举演进) |
| `briefing` | 对象(必填) | `title`(1–128,对齐协议 `PUBLIC_TEXT_MAX_LENGTH`)、`summary`(1–2048)、`learningObjectives[]`(1–8 条,各 ≤ 256)、`teachingNotes?[]`(≤ 8 条,各 ≤ 512) |
| `vmProfile` | 对象(必填) | 见 2.2 |
| `memoryLayout` | 对象(必填) | `regions[]`(1–64),见 2.3 |
| `allowedActions` | 字符串数组(必填,≤ 12,uniqueItems) | 12 会话动作枚举的**子集选择**;参数 Schema 单一来源是 protocol 会话动作契约(不复述) |
| `resourceLimits` | 对象(必填,可为空对象) | `predicateEvalBudgetPerSession?`(1–1 000 000)、`rollbackBudgetPerSession?`(1–10 000)、`maxWriteBytesPerAction?`(1–4096,上限 = 协议 `MAX_WRITE_BYTES`);**不重新声明**协议冻结常量(WP-1 §12.2) |
| `hintLadder[]` | 数组(0–8) | `{order(1–8), revealPolicy: on_request\|after_n_failures, failureThreshold?, hintText(1–512)}`;`revealPolicy = after_n_failures` ⇒ `failureThreshold` 必填(if/then) |
| `publicErrorMapping[]` | 数组(0–16) | `{errorCode: 16 值冻结枚举, teachingNote(1–512)}` |
| `randomizationNotice?` | 字符串(1–200) | 纯文案:仅声明"存在随机化",禁策略 / 候选空间 / 熵上界(WP-1 §3.2、§12.2) |
| `initialProjection` | 对象(必填) | **部分镜像**,见 2.4 |

**公开文本面加固**:全部自由文本字段(`briefing.title` / `summary` / `learningObjectives[]` / `teachingNotes[]`、`registers[].displayLabel`、`regions[].publicLabel`、`hintLadder[].hintText`、`publicErrorMapping[].teachingNote`、`randomizationNotice`、投影标签)拒绝 C0/C1 控制字符(pattern `^[^\u0000-\u001F\u007F-\u009F]*$`)——`JSON.parse` 会把 `\u0007` 类转义解码成原始控制字符,输出面与协议公开文本同纪律,在 Schema 层拒绝。

### 2.2 `vmProfile`(VM Profile 公开元数据)

| 字段 | 类型(冻结) | 语义与规则 |
|---|---|---|
| `registers[]` | 数组(1–64)× `{name, displayLabel?}`(v1.2 上限放宽,D3.1) | **本题目寄存器集的定义性声明**(v1.2,G2/D3;ProjectionPolicy.visibleRegisters 的组装来源);一般命名模式 `^[A-Z][A-Z0-9_]{0,15}$` 且不得落入 FLAG 保留区 `^FLAG[A-Z0-9_]*$`(Schema 负向前瞻 + XS-REG-NAMESPACE / XS-REG-FLAG);必含核心寄存器 `RSP`/`RBP`/`RIP`(XS-REG-CORE);名称唯一(XS-ID-UNIQUE) |
| `flagRegisterNames?[]` | FLAG 模式字符串数组 | 只承载**名称**;**不要求**是 `registers` 子集(通常恰相反,WP-1 §12.5 v1.5);须存在于私有包初始寄存器集(XS-REG-FLAG) |
| `archBits` | enum `32` / `64`(v1.1 必填) | **架构位宽声明**(G1/D1:出题人指定 32 或 64 位);双包全部架构值(初始寄存器值、IR 立即数与位移、公开镜像值)按此位宽校验域(XS-ARCH-WIDTH);值以 64 位容器承载、高位按位宽掩蔽(计划书 6.2)。私有包不复制本字段——位宽是公开常量,从公开包单点读取,防双真相源 |
| `endianness` | const `"little"` | 架构公开常量 |
| `pageSizeBytes` | 整数,4096 的倍数,4096–65536(v1.1) | VMA 页大小(4KB 的倍数,G3/D2);权威分页语义归引擎,对齐由 XS-MEM-PAGE-ALIGN 复核 |
| `canary` | `{enabled: boolean, sizeBytes?}`(必填) | `enabled = true` ⇒ `sizeBytes`(1–8)必填(if/then);canary **值**在私有包(XS-CANARY-CORR 互证) |

### 2.3 `memoryLayout.regions[]`(可见区域布局)

字段命名与 protocol `VisibleMemoryRegion` 对齐(`startAddressHex` / `permissions`),使初始投影与布局的比较是同形比较:

| 字段 | 类型(冻结) |
|---|---|
| `regionId` | `^[a-z][a-z0-9-]{0,62}$` |
| `kind` | enum `code` / `global` / `stack` / `heap` / `key` / `custom`(v1.1:`custom` = 作者自定义类型,`publicLabel` 必填承载类型名,同 `SemanticHighlight.custom` 先例;G3) |
| `startAddressHex` | `^0x[0-9a-fA-F]{1,16}$`(入站面大小写均可) |
| `byteLength` | 整数 1 – 16 MiB 且为 4096 的倍数(v1.1 G3/D2:VMA 基本单元按页对齐;**区域内对象**——canary 1–8 字节、buffer 切片等——不受此约束,对齐只约束 VMA 边界) |
| `permissions` | `^r?w?x?$`(规范序子集,同协议) |
| `publicLabel` | 字符串 1–128(全部 kind 必填;`custom` 类型的名称载体) |

**结构性无隐藏表达位**:本 Schema 不存在 `isHidden` / `visibility` / `containsSecret` 类字段——隐藏区域只能声明在私有包(D2-NO-HIDDEN-IN-PUBLIC 元检查)。

### 2.4 `initialProjection`(部分镜像,冻结)

只含三个作者可声明子形状;`revision` / `callStackSummary` / `controlFlow` / `status` 结构性排除(理由与排除集一致性测试见 WP-1 §12.2.1):

| 子形状 | 形态(冻结) | 规则 |
|---|---|---|
| `visibleRegions[]` | 1–64 × 完整区域实例 `{regionId, label, startAddressHex, byteLength, permissions, bytesHex, truncated}` | 与 `memoryLayout.regions[]` 按 regionId **双射**,且几何 + 标签逐项相等(XS-PROJ-GEOM);`bytesHex` ≤ 512 hex 字符(= 协议默认 `maxBytesPerRange` 256 字节)、非空,必须等于私有区域 `contentHex` 的同长前缀切片,`truncated === (byteLength × 2 > bytesHex 长度)`(XS-PROJ-VALUES) |
| `visibleRegisters[]` | 1–64 × `{name, valueHex}`(v1.2 上限放宽,D3.1) | `valueHex` 大写 `^0x[0-9A-F]{1,16}$`(输出面对齐,§2.5;v1.1:值须落在 `archBits` 位宽域内,XS-ARCH-WIDTH);`name` 匹配一般命名模式(FLAG 保留区由 Schema 排除)且 ⊆ `vmProfile.registers`(XS-PROJ-REG)且 ∉ 秘密汇(I3-VISIBLE-REG);值必须等于私有初始寄存器值(XS-PROJ-VALUES) |
| `semanticHighlights?[]` | 0–32 × `{kind(5 值枚举), targetRegionId, startAddressHex, byteLength, label(1–128)}` | `targetRegionId` ∈ 初始投影可见区域且高亮跨度在区域内(I2-HIGHLIGHT) |

## 三、私有判题包(Private Challenge Bundle,整体 SERVER_ONLY)

根约束同 §二,但**私有包条件结构允许非递归 `$defs` 分解**(公开包零 `$ref`/`$defs`):`$defs` 引用图必须无环(严格性测试构建引用图断言),深度仍为静态 Schema 属性——判题条件展开成 45 份内联谓词副本不可维护,非递归 `$ref` 与"免递归 `$ref`"的防深度炸弹目标(L3 之后结构上不可表达)等价。`$id` = `.../private-bundle.schema.json`;`x-sm-class: server-only`。整体 `SERVER_ONLY` 论证见 WP-1 §12.3(与 `VmState` 无契约只有禁令同构)。

### 3.1 顶层字段(冻结)

| 字段 | 类型(冻结) | 语义与规则 |
|---|---|---|
| `schemaVersion` / `challengeId` / `challengeContentVersion` / `vmProfileVersion` | 同公开包 | 与公开包一致性由 XS-ID-CORR 强制 |
| `dslSchemaVersion` | const `2` | 7.4 第 1 类版本(v1.3 G4/D4 定基:20 基线 opcode + 微算子 / 效果封闭集) |
| `vmEngineVersion` | `^\d+\.\d+\.\d+$`(**必填**) | 7.4 第 2 类;锁定执行环境 |
| `engineBuildId?` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` | 引擎构建 ID(7.4 正式判题记录项) |
| `declaredSeedPublicPaths` | 字符串数组(**必填**,可空) | 路径语法见 §4;T-SC4 / ZR-P2 判定基准 |
| `seedPolicy` | `{strategy: fixed\|server_random_per_session, seedHex?}` | `fixed` ⇒ `seedHex`(16–64 hex 字符)必填(if/then);无 `algorithmId`(确定性由 `vmEngineVersion` 锁定) |
| `initialState` | 对象(必填) | 见 3.2 |
| `secretSinkRegisters?` | 寄存器名数组(uniqueItems) | I-3 作者显式声明补充面,"仅收紧不得放宽" |
| `secrets` | 对象(必填) | `flag`(8–128 字符)、`virtualFiles[]`(0–8 × `{fileId, content(0–4096 字符)}`) |
| `privateObjects[]` | 数组(0–64) | `{objectId, kind: buffer\|canary\|saved_rbp\|return_address\|file\|other, addressHex, byteLength, visibility: public\|hidden, containsSecret}`;I-2 / I-3 检查器输入 |
| `judging` | 对象(必填) | 见 §4.2 |
| `stages?[]` | 数组(0–8) | 状态机六要素(`docs/最小DSL范围.md` §七) |
| `compiledIr` | 对象(必填) | 见 §4.4 |
| `customInstructions?[]`(v1.3) | 数组(0–16) | `{mnemonic, displayText(1–120), semantics[](1–16)}`;`mnemonic` = `^[A-Z][A-Z0-9_]{0,15}$`(大写形态与基线小写枚举结构性不相交,与基线冲突由 XS-CUSTOM-DEF 纵深防御、条目唯一性归 XS-ID-UNIQUE);`semantics` = **微算子封闭集 v1** 直线序列(`oneOf` 以 `op` 判别:`load_imm` / `mov_reg` / `load_mem` / `store_mem` / `set_flag` / `bit_mask`)——集合内无控制转移(CFG 静态分析保持),执行步数恒定 = 序列长度(T-SC2 结构前提);数据算子 `dst` 用一般命名模式(FLAG 结构性排除,`set_flag` 是唯一 FLAG 写入微算子,I-3),`src` 用 `vmRegisterName`(flags 可读);语义见 `docs/最小DSL范围.md` §三.2 |
| `interfaces?[]`(v1.3) | 数组(0–16) | `{interfaceId, displayText(1–120), effects[](1–16)}`;`interfaceId` = 整数 0x100–0xFFFF(保留系统号带 [0x0, 0xFF] 内置 exit 不开放声明,XS-SYSCALL-DECL);`effects` = **效果原语封闭集 v1** 直线序列(`oneOf` 以 `effect` 判别:`exit` / `grant_virtual_file` / `virtual_file_read` / `set_flag` / `noop`)——无宿主 IO 原语(F-4 保持),执行步数恒定 = 序列长度;引用可解析由 XS-IFACE-REF 强制(fileId ∈ `secrets.virtualFiles`,FLAG 寄存器 ∈ 私有初始寄存器集);v1 Schema 不设接口存在性的公开声明位(阶段二按教学需要增补);语义见 `docs/最小DSL范围.md` §三.3 |
| `judgingConfig` | 对象(必填) | `verdictRuleVersion`(必填,semver)、`maxPredicateEvalSteps`(必填,1–10 000 000;D1 约束 2 / I-6 / T-SC2 配置前提)、`timeoutMsPerAction?`(1–60 000)、`maxTotalActionBytes?`(1–1 048 576) |

### 3.2 `initialState`(VmState 初始形态)

- `registers`:对象(≤ 256 键,v1.2 D3.1),`propertyNames` = 双命名空间之一(v1.2,G2/D3:一般名 `^(?!FLAG)[A-Z][A-Z0-9_]{0,15}$`——负向前瞻排除 FLAG 保留区——或 FLAG 模式 `^FLAG[A-Z0-9_]*$`),值 = 架构值十六进制(≤ 16 位,入站面大小写均可;v1.1:值须落在题目 `archBits` 位宽域内,XS-ARCH-WIDTH);键归属检查由 XS-REG-NAMESPACE 纵深防御复核;含 FLAG 值——FLAG 值永不进入公开面;
- `memoryRegions[]`(1–64):`{regionId, kind(6 值,含 `custom`), startAddressHex, byteLength(1–16 MiB 且 4096 的倍数,v1.1 G3), permissions, contentHex, isHidden}`;`contentHex` 长度必须等于 `2 × byteLength`(XS-MEM-CONTENT);非隐藏区域与公开布局**双射**(I2-PUB-MIRROR)。

## 四、判题条件、seed 声明与 IR 信封

### 4.1 条件结构(三级,静态深度)

```text
L1: { all?: L2[] (0–4), any?: L2[] (0–4), not?: L2 }   // 至少一键;all/any 允许空数组(恒真/恒假)
L2: { all?: L3[] (0–4), any?: L3[] (0–4), not?: L3 }
L3: { predicate: <内置谓词> }
```

嵌套深度是**静态 Schema 属性**(三级结构在 Schema 中静态展开——`$defs: conditionL1 → conditionL2 → conditionL3 → predicate`,引用无环,Ajv 直接拒绝第四层,免**递归** `$ref`,XS-NESTING;检查器对实例深扫描复核深度 ≤ 3 作纵深防御);七项内置谓词(封闭枚举,`oneOf` 类型判别 + 各自 `additionalProperties: false`):`register_equals` / `register_bits_set` / `memory_equals` / `memory_contains` / `ret_target_equals` / `stack_canary_intact` / `virtual_file_read`(词汇依据:`docs/最小DSL范围.md` §四)。

### 4.2 `judging`

- `successCondition`: L1(必填);`failureConditions?`: L1 数组(0–8);
- `hiddenTests?[]`(0–16):`{testId, kind: reference_payload|predicate_probe, payloadHex?, expectedResult}`——隐藏测试是(输入, 预期判定)对;`expectedResult` ∈ 7 值可达判定枚举 `success / wrong_answer / invalid_action / program_crash / memory_fault / resource_limit / timeout`(`challenge_invalid` / `replay_mismatch` / `cancelled` / `engine_error` 非可授权期望,D6)。

### 4.3 `declaredSeedPublicPaths` 路径语法

点分标识符序列(≤ 8 段,每段 `^[A-Za-z][A-Za-z0-9_]{0,31}$`);根 ∈ 投影七顶层字段;完整路径必须可解析到公开包 `initialProjection` 的具体叶子(XS-SEED-DECL;空数组 = 显式"无公开随机化面")。

### 4.4 `compiledIr`(IR 信封)

`{irFormatVersion: const 2(v1.3 G4/D4), entrypointIndex?, instructions[](1–4096), labels[](0–512 × {labelId, instructionIndex})}`;指令 = `{op, operands[] (≤ 4)}`;`op` 为**双形态 anyOf**:20 基线 opcode 小写枚举 ∪ 大写自定义助记符 `^[A-Z][A-Z0-9_]{0,15}$`(两形态按大小写结构性不相交;助记符必须已声明,XS-CUSTOM-REF);操作数槽 `oneOf`:`{kind: register, name}` / `{kind: immediate, valueHex}` / `{kind: memory, baseRegister?, displacementHex?}` / `{kind: interface, interfaceId(整数 0x100–0xFFFF)}`(结构安全;逐 opcode 合法性归 challenge-compiler)。WP-4 检查器只做:labelId 唯一且引用可解析、索引 < 数组长度(XS-IR-LABEL);助记符 / syscall 派发号 / `interface` 操作数引用可解析(XS-CUSTOM-REF / XS-SYSCALL-DECL / XS-IFACE-REF);`leave` ⇒ 私有初始寄存器集含 `RBP`(XS-IR-LEAVE)。

## 五、字段分类检查器(`./server-only/checker/`)

入口 `checkChallengePair(public, private): { ok, violations: Violation[] }`;`Violation = { ruleId, message, path? }`。每条规则带必触发红灯样例(扫描器自检纪律);规则 ID 与 WP-1 条目对照见 WP-1 §12.6。地址区间运算一律 BigInt(`address-ranges.ts`)。

| 规则 ID | 语义 |
|---|---|
| I2-PUB-PAIRWISE / I2-PRIV-PAIRWISE | 公开 / 私有内存区域各自两两不重叠(BigInt 区间相交判定) |
| I2-PUB-MIRROR | 公开布局 ↔ 私有非隐藏区域按 `regionId` 双射,几何(`startAddressHex`/`byteLength`)与权限、标签逐项相等 |
| I2-HIDDEN-NOT-PUBLIC / I2-OBJ-NOT-PUBLIC | 隐藏私有区域 / `hidden` 私有对象地址区间与公开区域交集为空 |
| I2-HIGHLIGHT | 语义高亮目标 ∈ 初始投影可见区域且跨度在区域内 |
| I3-SINK-HIDDEN | `containsSecret = true` ⇒ `visibility = hidden` |
| I3-VISIBLE-REG | 初始投影寄存器 ∩ (`secretSinkRegisters` ∪ FLAG 模式寄存器) = ∅ |
| D2-CODE-PUBLIC | `kind = code` 区域 ≤ 1,必须非隐藏且出现在初始投影;可见区域 ≥ 1 |
| D2-NO-HIDDEN-IN-PUBLIC | 公开 Schema 结构上无隐藏表达位(元检查,§6) |
| ZR-B8-CAP-SCAN | 公开包实例全部字符串值深扫描 capability 前缀(`virtual_file:` 等),命中即拒 |
| XS-ID-CORR | 双包 `challengeId` / `challengeContentVersion` / `vmProfileVersion` 相等 |
| XS-ID-NO-PRIVATE | 公开包全部字符串值 ∩ {`objectId`, `fileId` 集合} = ∅(7.1 禁止经引用 ID 推导私有字段;`regionId` 是共享公开镜像,豁免) |
| XS-ID-UNIQUE | 公开/私有 regionId、公开寄存器名、`flagRegisterNames`、hint `order`、`errorCode`、`objectId`、`testId`、`stageId`、`fileId` 各自唯一(v1.3 起含自定义指令助记符与作者接口 `interfaceId`) |
| XS-REG-SUBSET(v1.2 重锚) | 初始面:私有初始寄存器 ⊆ `vmProfile.registers` 声明集 ∪ `flagRegisterNames`(FLAG 名经后者豁免);投影面:初始投影寄存器 ⊆ 声明集(G2:`registers` 是定义性声明,不再是冻结基集的可见子集) |
| XS-REG-NAMESPACE(v1.2) | 双命名空间保留模型(G2/D3):私有初始寄存器键须归属两个命名空间之一——一般名 `^[A-Z][A-Z0-9_]{0,15}$`(Schema 负向前瞻已排除 FLAG 保留区)或 FLAG 模式 `^FLAG[A-Z0-9_]*$`;不属任何命名空间的键拒绝(Schema 之外纵深防御;`XS-REG-FROZEN` 随冻结基集废止) |
| XS-REG-CORE(v1.2) | 必选核心寄存器(G2/D3):`RSP` / `RBP` / `RIP` 必须存在于 `vmProfile.registers` 声明集——会话动作(push/pop/call/ret)、栈语义 opcode 与 MVP 栈帧闭环的公共底座 |
| XS-REG-FLAG | FLAG 模式命名约定:一般命名不匹配 FLAG 模式;`vmProfile.registers` 不含 FLAG 名;FLAG 名存在于私有初始寄存器集(WP-1 §12.5 v1.5) |
| XS-PROJ-GEOM | 初始投影区域与公开布局双射且几何 + 标签相等 |
| XS-PROJ-VALUES | 初始投影公开值镜像私有初始态:`bytesHex` = 私有区域前缀切片且 `truncated` 语义一致;`valueHex` = 私有初始寄存器值 |
| XS-PROJ-REG | 初始投影寄存器 ⊆ `vmProfile.registers` 声明集;私有初始寄存器 ⊆ 声明集 ∪ `flagRegisterNames`(与 XS-REG-SUBSET 同规则双锚点:投影面与初始面,违规统一记投影面规则 ID) |
| XS-CANARY-CORR | `canary.enabled = true` ⇒ 私有包 ≥ 1 个 `kind = canary`、`hidden`、`containsSecret` 的私有对象,区间不与公开区域相交 |
| XS-MEM-TOTAL | Σ`byteLength` ≤ 64 MiB;Σ`contentHex` 字节 ≤ 2 MiB |
| XS-MEM-CONTENT | 私有区域 `contentHex` 长度 = 2 × `byteLength` |
| XS-ARCH-WIDTH(v1.1) | 架构值位宽域(跨包规则):私有初始寄存器值、IR 立即数(无符号 ≤ 2^archBits−1)与内存位移(有符号 −2^(archBits−1)…2^(archBits−1)−1)、公开镜像寄存器值均须落在公开包 `vmProfile.archBits` 声明的位宽域内(64 位容器承载,高位掩蔽;G1/D1) |
| XS-MEM-PAGE-ALIGN(v1.1) | VMA 页对齐:公开/私有区域 `byteLength` 与公开 `pageSizeBytes` 均为 4096 的倍数(Schema `multipleOf` 之外的跨包纵深防御;G3/D2) |
| XS-SEED-DECL | 路径根 ∈ 投影七字段且可解析到 `initialProjection` 叶子 |
| XS-STAGE-REACH / XS-STAGE-BUDGET | 迁移目标存在且自首阶段全可达;每状态 `maxInstructionSteps` 必填 |
| XS-IR-LABEL | `labelId` 唯一;指令 / 入口索引 < 长度 |
| XS-CUSTOM-DEF(v1.3) | 自定义助记符不与基线 opcode 冲突(纵深防御:Schema 大小写形态已结构性不相交,本规则拦截被类型断言绕过的手写包;条目唯一性归 XS-ID-UNIQUE;G4/D4) |
| XS-CUSTOM-REF(v1.3) | IR 中非基线 `op` 必须引用已声明的 `customInstructions` 助记符(G4/D4;13.2 未定义引用) |
| XS-SYSCALL-DECL(v1.3) | `syscall` 封闭单值伪操作:操作数必须为恰好一个立即数;派发号 ∈ 保留系统号带 [0x0, 0xFF](内置 exit 语义不变)或精确匹配已声明 `interfaces[].interfaceId`(G4/D4) |
| XS-IFACE-REF(v1.3) | `call` 的 `interface` 操作数 ∈ `interfaces[]`;接口效果引用可解析:fileId ∈ `secrets.virtualFiles`,`set_flag` 的 FLAG 寄存器 ∈ 私有初始寄存器集(I-3 污点检查落位前提;G4/D4 + 7.3 结构化引用) |
| XS-IR-LEAVE(v1.3) | IR 含 `leave` ⇒ 私有初始寄存器集含 `RBP`(`RSP ← RBP` 栈帧语义的前提;G4/D4) |
| XS-CUSTOM-DISPLAY(v1.3) | `customInstructions` / `interfaces` 的 `displayText` 扫描 E-4/E-6 私有标识:隐藏区域 `regionId`、隐藏测试 `testId`、虚拟文件 `fileId`,命中即拒(I-10 静态模板类的编译期防线;运行时存在性泄露归 T-SC1 探针变体) |
| XS-PRED-REFS | 谓词引用可解析(寄存器 ∈ 初始寄存器集;`regionId` / `fileId` 存在;内存谓词偏移 + 长度在区域内) |
| XS-DUP-KEY | 重复 JSON 键拒绝(`JSON.parse` 静默去重且 reviver 观察不到;装载器以字符级严格扫描器在解析前拒绝,§5.1) |
| XS-NESTING | 条件深度由三级结构静态承接(Ajv 按 `$defs` 逐层封顶);检查器对实例深扫描复核 ≤ 3(纵深防御);无数值数组预算逃逸(`maxItems` 承接) |
| XS-1(公开 Schema 元检查) | `FORBIDDEN_PUBLIC_PROPERTIES`(私有包顶层属性名 − 4 共享身份字段)不得以键或字符串值出现在公开 Schema 任意层;公开 Schema 禁 `default` / `examples`(`const` / `enum` 允许,`schemaVersion` const 1 合法);`x-sm-class === "public"` |

### 5.1 装载纪律(`internal/schema-loader.ts`,不导出)

- `node:fs` 读取 `schema/*.json`(构建产物同仓库布局);**重复键拒绝严格扫描器**(XS-DUP-KEY:`JSON.parse` 之前的字符级状态机,reviver 观察不到重复键);
- Ajv 2020-12,`strict: true`、`coerceTypes: false`、`allErrors: false`,按 `$id` 编译缓存;
- 本模块不进浏览器构建图:私有包 Schema 与检查器仅经 `./server-only` 子路径导出。

## 六、TS 类型与 Schema 防漂移

TS 类型为手工镜像(本包保持叶子包,不依赖 protocol/Zod)。防漂移三闸:

1. **完整正反样例**:公开包 fixture(JSON,入 git,兼作 WP-6 golden fixture 源);私有包样例由测试 helper 的 builder 构造(**私有包样例永不入 git**,CLAUDE.md 红线),覆盖每条规则的红灯变体;
2. **Schema 严格性测试**(`schema-strictness.test.ts`):递归断言每层 `additionalProperties: false`;公开 Schema 零 `$ref`/`$defs`,私有 Schema `$defs` 引用图无环(非递归);公开 Schema 无 `default`/`examples`;`classification.json` ≡ 常量;`fieldClasses` 键 ≡ 顶层 `properties` 键;
3. **跨包一致性测试**(`cross-package-consistency.test.ts`):仅测试代码以 `node:fs` 读取 `../protocol/schema/*.schema.json` 比对(数据文件读取不是 import 边,dependency-cruiser 边界不受影响;**src/ 永不做此读取**):12 动作 / 16 错误码枚举一致;区域、寄存器、高亮三个复用子形状深等价;投影排除集 ≡ {revision, callStackSummary, controlFlow, status};寄存器命名模式 ≡ 一般命名空间(G2/D3,协议 `RegisterNameSchema` 与本包 `$defs/vmRegisterName` 同串;v1.2 起不再比对冻结基集——基集已废止);opcode 集 ≡ DSL 文档 §三。

## 七、版本与演进

| 版本字段 | 载体 | 面向 |
|---|---|---|
| `CHALLENGE_PACKAGE_SCHEMA_VERSION`(const 1) | 本包 | 双包格式信封;破坏性变更递增并保留 N-1 兼容窗口 |
| `schemaVersion`(文档内 const 1) | 两包实例 | 与上一致,实例侧锚点 |
| `dslSchemaVersion` | 私有包 | DSL Schema Version(7.4 第 1 类) |
| `vmEngineVersion` / `engineBuildId` | 私有包 | VM Engine Version(7.4 第 2 类;锁定执行环境) |
| `vmProfileVersion` | 双包 | VM Profile Version(7.4 第 3 类;寄存器扩展入口) |
| `challengeContentVersion` | 双包 | Challenge Content Version(7.4 第 4 类) |
| `judgingConfig.verdictRuleVersion` | 私有包 | 判题规则版本(7.4 正式判题记录项) |

### WP-4 与 challenge-compiler 分工表

| 校验 | WP-4(本包) | challenge-compiler(阶段二) |
|---|---|---|
| 双包 Schema 形态 | ✓ Ajv | 消费 |
| 字段分类与分离 | ✓ 检查器 | 消费(编译前置校验) |
| IR 结构(op 双形态、标签引用、索引界、G4 引用可解析) | ✓ XS-IR-LABEL + XS-CUSTOM-REF / XS-SYSCALL-DECL / XS-IFACE-REF / XS-IR-LEAVE(v1.3) | — |
| 逐 opcode 操作数合法性与数量 | — | ✓(编译期) |
| CFG 可达性、终止性、循环回边 vs 预算 | — | ✓(编译期) |
| DSL 源(作者语言)→ 双包生成 | — | ✓ |
| seed 派生、谓词求值、策略组装 | — | 运行时(阶段二/三引擎) |

# 秘密零驻留 CI 检查项映射

| 项 | 值 |
|---|---|
| 版本 | v1.3(2026-09-09,rust-miri 的 miri 运行收敛为 UB 敏感面子集(arch / decode / memory / state / registers / judge::predicate 模块;唯一 skip 手写 256 轮 × 整引擎重建循环 constant_cost_predicate_count_under_mutation——其不变式由同模块 miri 缩减用例的 proptest 覆盖,原生 job 仍全量执行)。理由:Miri 解释执行慢 10~100 倍,nightly 每日轮换令 rust-cache 与 Miri sysroot(`~/.cache/miri`,不在 rust-cache 覆盖内)每日冷重建,全量 167 测试在 CI 逼近 60 分钟超时(暖缓存实测:全量 >40 分钟未完,过滤集 80 测试 6.3 分钟);本地全量入口保留 `pnpm test:miri`。v1.2(2026-09-09,WP-9:新增 ENG-8 miri / ENG-9 fuzz / ENG-10 黄金向量与跨 profile·跨平台一致性门禁及对应 CI 落点;登记 ENG-4 测试期依赖允许清单首项 proptest。v1.1(2026-09-06,WP-0 初版;同日修订:rust-gate 的纪律门禁 CI 落点由 `pnpm lint:rust` 改为直调脚本——rust-gate 不安装 node 依赖,解除 CI 对 npm registry 的依赖,turbo 任务保留为本地 / turbo 图入口))) |
| 状态 | 实现期文档(随各 WP 接线持续更新;所映射的上游清单为冻结面) |
| 上游依据 | `docs/contracts/数据分类与秘密零驻留清单.md` §二(驻留三原则)、§九(机检条目)、§13.5 构建面;`docs/项目计划书.md` 5.8(质量门禁)、13.5 |
| 效力范围 | 阶段二起全部工作包;实现侧 CI 落点与上游条目 ID 的一一对照 |

本文把秘密零驻留清单的机检条目落到**具体 CI 检查项**。按清单 §九扫描器纪律:检查项的脚本输出、CI 步骤名、反例命名均携带条目 ID;扫描器数值参数(语料格式、阈值)在其落地阶段确定并回填本文。每条已接线门禁都带**必触发反例**(红灯样例)——glob 写错、扫描器失效、语料缺失都表现为静默绿灯,与零命中不可区分,属无效控制;反例位置见各表"红灯反例"列。

---

## 一、CI 工作流总览

`.github/workflows/ci.yml`(GitHub Actions,push / pull_request 触发):

| job | 步骤 | 门禁 ID |
|---|---|---|
| `ts-gate` | install → build → typecheck → test(turbo) | 质量门禁 1、3(计划书 5.8) |
| `ts-gate` | eslint + dependency-cruiser 依赖边界 | ZR-B3 |
| `ts-gate` | `pnpm scan:public` 隔离扫描(TS 构建图与浏览器产物) | ZR-B3、ZR-B8、ZR-B9(部分)、ZR-B4(部分) |
| `ts-gate` | `pnpm fixtures:manifest --check` 摘要清单防漂移 | 规范化序列化契约(WP-6) |
| `rust-gate` | `node tooling/check-engine-discipline.mjs`(check-engine-discipline 全量;与 turbo 任务 `lint:rust` 同一脚本,rust-gate 不装 node 依赖故直调) | ENG-1 ~ ENG-6 |
| `rust-gate` | `pnpm test:rust`(cargo test dev + release) | ENG-3(运行时反例)、ENG-6 |
| `rust-gate` | `cargo llvm-cov --fail-under-lines 90` | ENG-7 |
| `rust-gate` | contract-smoke `cargo test` + `pnpm smoke:contract` | 规范化序列化跨语言冒烟(WP-6) |
| `rust-miri` | `cargo +nightly miri test -p vm-core --` + UB 敏感面过滤器(arch:: decode:: memory:: state:: registers:: judge::predicate::,skip constant_cost_predicate_count_under_mutation) | ENG-8(WP-9) |
| `rust-fuzz` | `cargo fuzz run` × 3 目标(frame_command / challenge_bundle / byte_decode,每目标限时冒烟) | ENG-9(WP-9) |

`.github/workflows/cross-platform.yml`(WP-9;x86-64 `ubuntu-latest` × ARM64 `ubuntu-24.04-arm` × debug/release 全组合):

| job | 步骤 | 门禁 ID |
|---|---|---|
| `determinism` | `cargo test [-–release] -p vm-core -p vm-runtime`(确定性黄金向量测试为断言载体) | ENG-10(WP-9)、ENG-3(ARM 侧 release 复验) |

根脚本入口:`pnpm lint:rust`(turbo 任务 `lint:rust`,vm-engine 包脚本承载)、`pnpm test:rust`、`pnpm cov:rust`;TS 门禁沿用 `pnpm build / typecheck / test / lint / lint:deps / scan:public / fixtures:manifest --check`。

---

## 二、vm-engine 确定性纪律门禁(ENG-*,WP-0 新增)

实现脚本:`tooling/check-engine-discipline.mjs`;引擎 clippy 禁用清单:`tooling/engine-lints/clippy.toml`。

| ID | 门禁 | 机检实现 | 红灯反例(必触发) | 对应纪律 |
|---|---|---|---|---|
| ENG-1 | 全 crate `#![forbid(unsafe_code)]` | 脚本静态断言四个 crate 根文件 + 编译器 forbid 硬错误 | 反例 crate `ce-unsafe`(unsafe 块被编译器拒绝,自检断言信号);脚本自检:缺属性样例 | ADR-8 纯 safe Rust |
| ENG-2 | 引擎三 crate(vm-core / vm-runtime / projection)`#![no_std]`:std::time / std::io / std::net / std::fs 结构性不可解析;`extern crate std` 仅限 cfg(test) 行 | 脚本静态断言 + 编译器(no_std 下 std 路径不可解析);clock / rng 由 trait 注入,实现归 vm-worker | 脚本自检:缺 `no_std` 样例、非 cfg(test) 的 `extern crate std` 样例(均按预期触发) | ADR-8;6.3 确定性;CLAUDE.md 引擎纪律 |
| ENG-3 | release 构建 `overflow-checks = true`,溢出不静默回绕 | workspace `[profile.release]` 配置断言(CI 构建脚本层)+ 运行时探针 | `vm-core::overflow_probe::release_overflow_checks_active`:`cargo test --release` 下,若配置缺失则静默回绕 → 测试红灯(已实测验证;black_box 阻断常量折叠) | WP-0 门禁原文(构建脚本 + 运行时双强制);WP-9 构建级验证的前置 |
| ENG-4 | 引擎三 crate 运行时依赖 ⊆ 允许清单;rand / getrandom / chrono / time / tokio 等时间·随机源 crate 全禁 | 脚本解析 crate Cargo.toml([dependencies] / [dev-dependencies]) | 脚本自检:rand 依赖样例按预期触发 | 禁 rand / 直接时间源;依赖方向 5.5 |
| ENG-5 | 引擎 clippy 禁用清单(第二层 lint:std::time / fs / net / process 类型与方法) | `CLIPPY_CONF_DIR=tooling/engine-lints` 对引擎三 crate 逐个 `cargo clippy -D warnings` | 反例 crate `ce-std-time`(Instant / Command):带配置红灯且信号命中 disallowed,无配置对照绿灯(红灯归因于清单);反例 crate `ce-no-std-clean`:无误报 | ADR-8;清单 §九"必触发反例"纪律 |
| ENG-6 | `cargo fmt --check` + `cargo clippy --workspace --all-targets -D warnings` + cargo test(dev / release) | CI 步骤 `node tooling/check-engine-discipline.mjs`(本地同 `pnpm lint:rust`)、`pnpm test:rust` | 常规 CI 语义:任一违规即红灯 | 质量门禁 1、3(计划书 5.8) |
| ENG-7 | 覆盖率门槛:vm-core / vm-runtime / projection ≥ 90% | `cargo llvm-cov --workspace --exclude vm-worker --fail-under-lines 90`(vm-worker 为进程边界二进制,不在门槛内) | 覆盖率跌破 90% 即红灯(骨架期实测:含未覆盖二进制 crate 时 71.43% → 退出码 1);WP-0 骨架期即接线,避免"补门禁"窗口 | 质量门禁 3 |
| ENG-8 | `cargo miri`:vm-core UB 敏感面无未定义行为(13.1 引擎侧补充覆盖第 1 条;2026-09-09 范围收敛,理由见版本行 v1.3) | CI job `rust-miri`:nightly + miri 组件,`cargo +nightly miri test -p vm-core --` + UB 敏感面过滤器(arch 掩蔽算术 / decode 译码边界 / memory 页与 COW / state 快照克隆 / registers / judge::predicate 条件求值;skip 手写大循环 constant_cost_predicate_count_under_mutation,其不变式由同模块 miri 缩减用例的 proptest 覆盖);exec / instr / judge 行为面由原生测试 job(`pnpm test:rust`)全量覆盖;属性测试以 `RngSeed::Fixed` + `failure_persistence = None` 保证 miri 隔离模式纯净(无 OS 熵 / 无文件 IO) | miri 检出未定义行为即红灯;本地全量复跑:`pnpm test:miri` | 13.1;质量门禁 4(WP-9) |
| ENG-9 | cargo-fuzz:题目包与动作解析器 fuzz 无 panic(13.1 引擎侧补充覆盖第 2 条) | CI job `rust-fuzz`:三目标 `frame_command`(动作 / 命令解析器)/ `challenge_bundle`(双包管线含 IR 装配)/ `byte_decode`(字节模式取指译码),管线与 worker 处理路径同构;每目标 `-max_total_time=60` 冒烟;目标源 `vm-engine/fuzz/`(独立 workspace,不进引擎门禁图) | fuzz 目标内的不变量断言(如译码有界推进)或 panic 即红灯;语料纪律:不提交语料——私有题目包样本永不入 git | 13.1;质量门禁 4(WP-9) |
| ENG-10 | 确定性黄金向量:跨 profile(debug / release)与跨平台(x86-64 / ARM64)逐字节一致(13.1 引擎侧补充覆盖第 3 条) | `vm-runtime/tests/determinism_vectors.rs`:黄金脚本 13 动作的状态哈希序列 / revision 序列 / checkpoint 确定性 ID / 动作日志摘要**硬编码为仓库常量**;CI job `determinism`(cross-platform.yml)在 x86-64 + ARM64 × debug + release 四组合上断言;本地:`pnpm cross:test` | 常量漂移即红灯(语义按版本策略冻结:常量变化 = vmEngineVersion 必须演进);向量生成环境与双 profile 一致性实测记录见测试文件头注 | 13.1;6.3 确定性(WP-9) |

分层说明:ENG-2 的 `#![no_std]` 是**结构性主防线**(std 路径在引擎 crate 内不可解析,lint 不可绕过);ENG-5 的 clippy 清单是第二层,兜底"漏掉 no_std 的回归"。disallowed-* 不支持通配,清单为尽力枚举,以 no_std 为准。

---

## 三、构建产物检查(ZR-B*,清单 §9.1)

检查对象:前端 bundle、SourceMap、静态资源。实现:`tooling/scan-public-artifacts.mjs`(浏览器可达包 dist 全量 JS 产物,注释剥离后扫描)+ `tooling/dependency-cruiser.cjs`。

| ID | 条目 | CI 落点 | 状态 | 红灯反例 |
|---|---|---|---|---|
| ZR-B1 | 隐藏 flag 值(语料扫描) | 待题目 fixture 到位(阶段二 WP-2 后)接入 `scan:public` 语料法 | 🔜 | 随语料落地:合成秘密 fixture 必须触发 |
| ZR-B2 | 隐藏测试与私有谓词数据 | 同上 | 🔜 | 同上 |
| ZR-B3 | 完整 IR 与引擎代码 | ① dependency-cruiser 规则 `no-ts-dependency-on-vm-engine`(TS 构建图不含 vm-engine);② `scan:public` 内容模式:引擎 crate 标识(vm-engine / vm-worker / vm-core / vm-runtime / challenge-compiler)、Rust 产物路径(`target/(debug|release)`)、中间产物(`.rlib` / `.rmeta`)、引擎符号名(`libvm_*`);③ `scan:public` 产物结构检查:dist 禁携 `.exe / .dll / .so / .dylib / .rlib / .rmeta / .node / .lib / .pdb / .a` 与引擎命名 `.wasm` | ✅(WP-0) | 自检:模式反例 5 组(路径 / 中间产物 / crate 标识 / 符号名 / 注释免疫对照)+ 产物分类器反例 7 组;实地反例:dist 放置违规 JS 与 `.rlib` 文件即红灯 |
| ZR-B4 | 私有题目包内容 | 字段键名集合:`scan:public` 私有面标记(private-bundle、secretSinkRegisters、declaredSeedPublicPaths、seedHex、hiddenTests、judgingConfig、compiledIr 等);语料法随 fixture | 🚧(键名 ✅ / 语料 🔜) | 自检:既有模式反例(R16 期)+ 实地反例 |
| ZR-B5 | 权威快照(魔数 / 版本头) | 快照格式随 WP-6 落地后接入 | 🔜 | 随格式落地 |
| ZR-B6 | 服务端 seed 值(语料) | 随题目 fixture 到位 | 🔜 | 随语料落地 |
| ZR-B7 | 内部堆栈与文件路径 | 检查对象为浏览器可达响应(阶段四 / 五运行时);构建面模式随公开面扩展登记 | 🔜 | — |
| ZR-B8 | 私有 capability 名称 | `scan:public` 模式 `virtual_file:` 前缀;动态拼接形态由 DSL 编译期规则兜底(WP-2) | ✅(前缀)/ 🔜(拼接) | 自检:既有模式反例 |
| ZR-B9 | `SERVER_ONLY` 类型标识符(§3.3 清单) | `scan:public` 词边界模式:类型名(VmState / RuntimeConstraints / SeedState / VirtualMemory / VmEvent)+ 字段名(privateEventLog / seedState / instructionPointer)+ crate 名(ZR-B3 引用);共现形态规则(单 JSON 对象 ≥ 3 个 VmState 字段名键)随跨域载荷录制(阶段三)接入 | 🚧(标识符 ✅ / 共现 🔜) | 自检:既有模式反例 + 实地反例;扫描器自检纪律见脚本内 selfTest |
| ZR-B10 | 完整事件日志(形态检测) | 引擎生成面(WP-7):公开事件管线只产出冻结六类 + 冻结字段集(`projection::events`,Internal / FileGranted / FileRead 结构性无映射路径);跨域载荷形态检测随录制面(阶段三 / 四) | 🚧(生成面 ✅ / 录制面 🔜) | 差分套件事件面断言(`differential.rs`)|
| ZR-B11 | 私有 capability 返回值(语料) | 随题目 fixture 到位 | 🔜 | — |

语料法条目(ZR-B1 / B2 / B4 / B6 / B11)定位为兜底控制,主控制是结构性不变量(I-1 / I-2 / I-9 / I-10)——与清单 §九定位一致,随阶段二 WP-2 起的题目 fixture 逐条补齐。

---

## 四、运行时 / 投影 / 篡改检查(ZR-R / ZR-P / ZR-T)

| 条目组 | CI 落点 | 归属 |
|---|---|---|
| ZR-R1 ~ R5(堆快照、全通道录制、存储、诊断 trace) | Playwright + CDP 基建 | 阶段四 / 五(规则已冻结) |
| ZR-P1(字段白名单 Schema 驱动) | 生成面按冻结 Schema 校验 + 未知字段拒绝:出站契约三重闭环(`vm_worker::contract::outbound`,投影语义规约 §六) | ✅(WP-7,2026-09-08)/ 通道录制面阶段三 |
| ZR-P2(T-SC4 随机秘密差分) | 差分套件:异 seed 逐字节相等,差异字段注册表空集(`projection::differential::tsc1_tsc4_*`) | ✅(WP-7,2026-09-08)/ 题目发布管线逐题必跑 |
| ZR-P3(T-SC1 确定性通道无相关性) | 差分套件:秘密长度变体 8/16/32/64 + 同长异值 + 探针变体(双布局 I-9),规范化后逐字节相等;差异注册表空集 | ✅(WP-7,2026-09-08)|
| ZR-P4(T-SC3 时序) | 引擎 crate 无时钟;时序判定归编排器层统计面 | 阶段三(引擎面无时钟,结构前提 ZR-P7 已满足) |
| ZR-P5(序号与计数) | 差分套件:15 步脚本 revision 增量 ∈ {0,+1} 逐响应断言(执行 +1 / 拒绝 +0) | ✅(WP-7,2026-09-08)/ 运行时断言归 WP-8 |
| ZR-P6(错误粗化一致性) | 生成侧强制:coarse 零解释机检(`coarse_level_payloads_have_zero_explanation_fields`)+ 能力矩阵 fail-closed(`error.rs` 红灯矩阵)+ 同 (code, 级别) 字节稳定 | ✅(WP-7,2026-09-08)|
| ZR-P7(T-SC2 恒定步数) | 引擎侧属性测试 | ✅(WP-5,2026-09-07)|
| ZR-P8(公开字节信息流) | 结构性白名单(I-10 值来源 ⊆ 可见区域读回 / 玩家回显)+ 语料扫描兜底(泄漏策略红灯反例证明扫描器可检出)| 🚧(引擎生成面 ✅ / 污点插桩断言随实现面扩展)|
| ZR-T1 ~ T4(篡改、幂等、伪造) | Compose 集成测试 | 阶段二 WP-8(最小闭环)/ 阶段三 |

阶段二后续工作包交付时,本表同步回填 CI 落点与反例位置;新增检查项必须先在上游清单登记条目 ID,再在本文登记 CI 落点(顺序不可逆)。

---

## 五、接线与演进纪律

1. **ID 单一来源**:CI 步骤名、脚本输出(`[ENG-x]` / `(ZR-Bx)`)、反例命名必须携带上游清单条目 ID;上游清单 §九是唯一条目来源,本文不新增条目,只登记落点。
2. **必触发反例**:每条已接线门禁必须有至少一个反例(脚本 self-test、反例 crate、实地反例或测试探针),且反例与门禁同仓同 CI 运行;反例失效(如样例被误改)按门禁失败处理。
3. **豁免纪律**:浏览器产物扫描的误报豁免走 `scan-public-artifacts.mjs` 的 ALLOWLIST(带原因与到期日,过期自动失效);引擎纪律门禁无豁免机制——需要豁免即代表违反 ADR-8 纪律,须走契约变更评审。
4. **依赖允许清单演进**:引擎 crate 新增依赖(如 WP-1 的 serde / schemars)须修改 `check-engine-discipline.mjs` 允许清单并在此登记理由;时间 / 随机源 crate 永不进入。WP-9 登记 `ENGINE_DEV_DEP_ALLOWLIST` 首项 **proptest**(vm-core / vm-runtime 测试期依赖,属性测试:掩蔽域算术 / COW 一致性 / 谓词求值器 / 译码纯函数):其输入生成 RNG 只存在于测试进程,与引擎行为的确定性正交,且属性测试侧固定 `RngSeed::Fixed` 种子 + 关闭失败持久化——可复现、无 OS 熵、无文件 IO(miri 隔离模式纯净);生产依赖允许清单不变。

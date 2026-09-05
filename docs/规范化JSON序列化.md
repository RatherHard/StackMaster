# 规范化 JSON 序列化(WP-6 · v1)

| 项 | 值 |
|---|---|
| 规范标识 | `stackmaster-canonical-json/1`(整数域 JCS 子集) |
| 状态 | 阶段一 WP-6 交付物:规则冻结,TS 与 Rust 双实现,由 golden fixture 摘要清单锁定 |
| 日期 | 2026-09-05 |
| 参考实现 | TS:`packages/protocol/src/common/canonical-json.ts`(`@stackmaster/protocol` 入口导出);Rust:`tooling/contract-smoke`(消费侧镜像实现,冒烟验证) |
| 跨语言锁定 | `tooling/contract-smoke/canonical-digests.json`:全部 fixture 的规范化 SHA-256 摘要清单,TS 生成、Rust 逐条比对,任一侧实现漂移即冒烟失败 |
| 上游依据 | 计划书 5.6(golden fixture 规范化序列化一致)、6.3(动作日志与回放的状态哈希)、7.4(规范化提交内容哈希)、13.5(客户端篡改检查);WP-1 §五(清单机检引用);CLAUDE.md 契约纪律 |
| 效力范围 | 一切需要"同一逻辑内容 ⇒ 同一字节序列"的契约 JSON 场景;与计划书冲突时以计划书为准 |

**为什么需要本规范**:TS 与 Rust 分别以 `JSON.stringify` 与 `serde_json` 序列化,两者对键序、空白、数字与转义的选择各不相同——同一对象两次序列化即可产生不同字节。凡哈希、签名比对、回放复现、跨语言 fixture 比对,必须先经本文的规范化规则消除这些自由度,否则双语言漂移从第一次哈希就开始(计划书 §十四"TS 与 Rust 契约漂移"风险)。

---

## 一、适用场景(何时必须规范化)

| 场景 | 消费方 | 依据 |
|---|---|---|
| golden fixture 跨语言摘要比对 | CI(摘要清单 + Rust 冒烟) | 5.6 |
| 动作日志条目的前后状态哈希 | vm-worker / verifier | 6.3 |
| 回放记录中的题目包哈希、VM Profile 哈希 | verifier、`verifier_runs` 记录 | 7.4 |
| 规范化提交内容哈希 | 裁决域(`submissions`) | 7.4 |
| 幂等缓存键的载荷指纹(阶段三实现期) | 编排器 | WP-2 §3.2 |

普通传输(ActionRequest / ProjectionDelta 的线上字节)**不要求**规范化——契约校验只关心结构;规范化只在"把内容变成可哈希、可比对的字节"时介入。

---

## 二、输入前置条件(fail-closed)

规范化器的输入必须满足:

1. **严格 JSON**:UTF-8 无 BOM;不得有注释、尾随逗号、尾随垃圾;对象键**不得重复**(按转义解码后的精确拼写比较,`"a"` 与 `"\u0061"` 视为同键——语义与 challenge-schema XS-DUP-KEY 一致,两包各自实现、拒绝语义对齐);
2. **数值域 = 整数**:契约面上一切数值字段在 Schema 层即为整数(`.int()` / 字面量联合 / `const`,见 §六论证);规范化器遇到非整数、`NaN`、`±Infinity`、超出 `±(2^53 − 1)` 安全整数域的数值一律**拒绝**,不做任何近似或舍入;
3. **字符串必须是合法 Unicode 标量序列**:孤立代理项(lone surrogate)拒绝——其无法编码为 UTF-8,序列化即无定义;
4. **无未定义形态**:`undefined`、函数、`symbol`、`bigint` 不是 JSON 值,拒绝(仅可能来自内存态调用,文本输入经 JSON.parse 天然排除)。

任何一条不满足即抛错并中止,不产出"尽力而为"的规范化形态。

---

## 三、文法规则(JCS 子集)

规则与 RFC 8785(JCS)对齐,差异只有一处:**数值域收窄为安全整数**(JCS 允许 IEEE 754 双精度浮点,其序列化依赖 ECMAScript `Number::toString` 的最短往返表示,是双语言实现分歧的最大来源)。契约面整数-only 使我们可以绕开整个浮点表示问题。

对已解析的 JSON 值 `v`:

| `v` 类型 | 规范化输出 |
|---|---|
| `null` | `null` |
| `true` / `false` | `true` / `false`(小写字面量) |
| 数值 | 十进制整数字面量:无前导零、无 `+` 号、无小数点与指数、无 `.0`;`-0` 规范化为 `0`(承 JCS);其余按十进制的最短精确表示,安全整数域内即 `String(n)` |
| 字符串 | 最短转义形态(§3.1) |
| 数组 | 元素**按原序**,`[` + `,` 连接 + `]`;数组是有序语义(publicEvents 时序、hints 分层、dirtyRanges 顺序),不排序 |
| 对象 | 键按 **UTF-16 码元序升序**排序(与 JCS / ECMAScript 字符串 `<` 比较一致),`{` + `"键":值` 以 `,` 连接 + `}`;**零空白** |

### 3.1 字符串转义(最短形态)

仅以下字符转义,其余字符(含非 ASCII)一律按 UTF-8 原样输出:

| 码位 | 输出 |
|---|---|
| `U+0022`(`"`) | `\"` |
| `U+005C`(`\`) | `\\` |
| `U+0008` | `\b` |
| `U+0009` | `\t` |
| `U+000A` | `\n` |
| `U+000C` | `\f` |
| `U+000D` | `\r` |
| 其他 `U+0000`–`U+001F` | `\u00xx`(`xx` 小写十六进制) |

`/` **不**转义;非 ASCII 不用 `\uXXXX`(UTF-8 直出);禁止对增补平面字符做代理对拆分(它们按整个码位编码为 4 字节 UTF-8)。

### 3.2 顶层输出

规范化结果是一个字符串;参与哈希时取其 **UTF-8 字节序列**(`Buffer.from(s, "utf8")` / Rust `String::into_bytes`),无 BOM、无尾随换行。哈希算法 = **SHA-256**,摘要以小写十六进制(64 字符)表示,字段命名约定 `canonicalSha256`(记录项落地归阶段二 / 三,本阶段冻结算法)。

### 3.3 嵌套深度

规范化器对嵌套深度设上限 **512**(超出拒绝)。契约实例的实际深度由消息字节上限约束(嵌入消息 64 KiB 等),该值仅为防御性护栏,正常负载远不可达。

---

## 四、值级规则:十六进制标量的规范形态(序列化发射面)

`packages/protocol/src/common/hex.ts` 将十六进制标量的"规范化形态(位宽补齐、大小写)"交由本节冻结。**输入接受面不变**(校验保持宽松,大小写 / 不定宽均可);本节约束的是**服务端序列化器发射**与**进入哈希计算之前**的值形态:

| 标量类别 | 规范形态 | 例(64 位架构) |
|---|---|---|
| 地址 / 架构值(`0x` 前缀标量:`addrHex`、`targetHex`、`valueHex` 等) | 小写 `0x` 前缀 + 小写十六进制数字,**按架构位宽左补零**(archBits/4 位:64 位 → 16 位数字,32 位 → 8 位) | `0x0000000000401200` |
| 字节序列(`bytesHex`,无前缀) | 小写、偶数长度 | `9090` |
| seed(`seedHex`,私有面) | 小写,长度按 seedPolicy 约束 | — |
| 编码 token(`tokenHex`) | 恰 2 位小写(D4.4 定宽 1 字节) | `0f` |

要点:

- **规范化分两层、互不越权**:文法层(§三)是上下文无关的机械变换,不知道某个字符串是不是地址;值层(本节)由**生产者**在构造载荷时完成(服务端序列化器、动作日志记录器)。规范化器的输入必须是已值级规范化的数据;
- golden fixture 是契约样例(覆盖宽松接受面,允许非规范十六进制形态);摘要清单对 fixture **原文**计算,不预设其值级形态;
- 64 位容器承载、高位按位宽掩蔽(G1/D1)在值层不变:32 位题目发射 8 位数字。

---

## 五、双语言实现纪律

1. TS 参考实现:`canonicalizeJsonText`(文本入口,含严格解析)与 `canonicalize`(内存态入口);错误以 `CanonicalJsonError` 抛出,携带机器可读 `code`(`duplicate_key` / `non_integer_number` / `unsafe_integer` / `lone_surrogate` / `unsupported_type` / `invalid_json` / `max_depth_exceeded`);
2. Rust 消费侧镜像:`tooling/contract-smoke` 以 serde_json 严格解析 + 等价规范化,逐 fixture 比对摘要清单;任何一侧修改规则而未同步另一侧,冒烟立即失败;
3. **规则变更 = 契约变更**:本规范标识 `stackmaster-canonical-json/1`;放宽数值域、改变键序或转义均为破坏性变更,必须走 WP-1 §1.3 契约变更流程,并重建摘要清单(`pnpm fixtures:manifest`)+ 通过 Rust 冒烟;
4. 摘要清单生成命令:`pnpm fixtures:manifest`(tooling/generate-canonical-manifest.mjs,确定性输出:无时间戳,键即 fixture 相对路径);`--check` 模式只校验不写,供 CI 防漂移。

---

## 六、整数域论证(为何 fail-closed 是安全的)

对两包全部落盘 JSON Schema 的机械扫描结论(2026-09-05,schema/ 目录 12 个 `.schema.json`):

- 协议包数值字段全部来自 `z.number().int()`(min/max 有界)、整数字面量联合(如 `alignmentBytes: 1|2|4|8`)或 `const`(如 `protocolVersion: 1`);
- challenge-schema 数值字段全部为整数界(`dslSchemaVersion: const 2`、数量护栏、地址上限等);架构值在契约面是十六进制**字符串**(`0x…`),不是数值;
- 因此整数域约束不排除任何已冻结字段;若未来某字段确需非整数数值,那是破坏性契约变更,必须先扩展本规范(引入 JCS 浮点最短表示)并同步双实现,而不是让某个实现静默自定表示。

该论证以测试固化:`packages/protocol/test/canonical-json.test.ts` + `tooling/contract-smoke`(Rust 侧同一拒绝集合)。

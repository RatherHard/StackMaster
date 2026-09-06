# contract-smoke —— 跨语言契约冒烟(WP-6;WP-1 扩展)

证明 `@stackmaster/protocol` 与 `@stackmaster/challenge-schema` 的 JSON Schema
可被 Rust 侧消费(计划书 5.6 / ADR-5:serde + schemars),并锁定规范化 JSON
序列化([docs/contracts/规范化JSON序列化.md](../../docs/contracts/规范化JSON序列化.md))的双语言一致。

**WP-1 起实现单一来源**:规范化序列化(canonical)、严格解析(strict_value)、
语义承接(semantic)提升为引擎模块(`vm-engine/vm-worker` 的
`vm_worker::contract`),本 crate 经路径依赖**消费同一实现**——§3 摘要比对与
§2 实例校验从此校验引擎实际使用的代码,第二套实现退场。

## 运行

```bash
pnpm smoke:contract          # = cargo run --manifest-path tooling/contract-smoke/Cargo.toml
cargo test --manifest-path tooling/contract-smoke/Cargo.toml   # 同一断言的测试形态
```

前置:`pnpm build`(fixture 与 schema 在仓库内,无需构建 TS;仅清单生成需要)。

## 五段检查

| 段 | 内容 | 对应 |
|---|---|---|
| §1 Schema 编译 | 两包全部 `*.schema.json` 可被 jsonschema(2020-12)编译 | 5.6 跨语言可实现 |
| §2 实例校验 | 有效 fixture 一律接受、非法一律拒绝;判定 = 结构(JSON Schema)**且**语义(superRefine 承接),与 TS 侧判定完全一致 | 5.6 同时接受或拒绝 |
| §3 摘要比对 | 对 `canonical-digests.json` 全量逐条复算(摘要或拒绝码);同一实现的第二遍机检在 `vm-worker` 测试(`canonical_digest_manifest_is_reproduced_by_engine_module`) | 规范化序列化一致 |
| §4 类型消费 | serde 反序列化镜像类型;schemars 生成面与 Zod Schema 的属性 / 必需键比对 | ADR-5 / ADR-8 |
| §5 private-bundle 消费 | 双程序形态(IR / 字节)builder **现场生成**合法私有包(永不入 git)+ 定向破坏反例 + serde 镜像 + schemars 顶层比对 | 阶段一验收评审 §三移交项 5;WP-1 |

## 语义层承接(vm_worker::contract::semantic)

四条跨字段规则超出 JSON Schema 结构表达能力,TS 侧由 Zod `superRefine`
机检、JSON Schema 落盘产物不携带(各 Schema 源码与语义文档 §六明文);
Rust 侧由引擎模块按相同语义承接,golden fixture 反例锁定两侧结论一致:

1. PublicError 能力矩阵(按 code 冻结 addressHex 形态与 explanation 字段白名单);
2. ActionResponse:非 null `projectionDelta` 的 `revision` 必须等于信封 `revision`;
3. PublicEvent:`payloadHex` 字节长度必须与 `byteLength` 一致(两者都出现时);
4. ProjectionDelta:`dirtyRanges` 字节总数 ≤ 8192(WP-1 D3)。

修改任一 TS 侧 superRefine 而不同步引擎模块,§2 立即失败;反之亦然。

## 摘要清单(canonical-digests.json)

由 `pnpm fixtures:manifest`(tooling/generate-canonical-manifest.mjs)从全部
fixture 生成:可规范化者记规范化 SHA-256,触犯前置条件者记拒绝码
(与 TS `CanonicalJsonErrorCode` 同串)。TS 侧防漂移测试在
`packages/protocol/test/canonical-manifest.test.ts`;本 crate §3 是 Rust 侧对
同一清单的独立复算。任何一侧单方修改规范化规则,另一侧立即失败。

## 私有样例纪律

`src/bundle_builder.rs` 在冒烟进程内构造私有判题包样例(占位符值),
**私有包样例永不入 git**(CLAUDE.md 红线);反例命名即违规原因登记。

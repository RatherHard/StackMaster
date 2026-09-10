# @stackmaster/web-component

`<pwn-memory-vm>` 承载包。**阶段四(WP-F1)为占位零实现**:仅导出并注册一个
最小 LitElement 桩组件(渲染 "pwn-memory-vm placeholder" 文案),不实现任何
视图、不包含任何会话或嵌入逻辑。

## 占位性质与阶段五计划

按《阶段四任务分解》§一裁决 3 与 §三"明确不属于阶段四的范围",以下内容全部
归**阶段五**正式实现,落点即本包:

- 独立来源 iframe 内的正式插件视图托管(阶段四开发联调用
  `apps/plugin-dev` 开发壳代替);
- 与宿主平台的 postMessage 嵌入协议(宿主侧 SDK 在
  `@stackmaster/embed-runtime`,本包只做组件侧装配);
- embed token 浏览器面(浏览器对 token 不解析,契约见
  `docs/contracts/嵌入协议.md`);
- 自适应高度、主题、语言;
- 公开描述包正式下发通道(M2;阶段四以夹具样例包注入代替)。

## 依赖边界

对工作区包只允许依赖 `@stackmaster/protocol` 的**公开入口**
(dependency-cruiser `browser-packages-only-depend-on-protocol` 规则强制;
即本包不得依赖 vm-ui)。占位阶段尚无 protocol 运行时消费,依赖声明仅固化
依赖方向与 turbo 构建序。

## 构建形态

- `pnpm build` = `tsc -b`(emitDeclarationOnly,先产 `dist/*.d.ts`)+
  `vite build`(库模式单入口 `index`,ESM 输出 `dist/index.js`);
  `emptyOutDir: false` 保护 tsc 产物;
- **产物自包含**(lit 内联):阶段五宿主平台以 `<script type="module">`
  直接加载 dist 产物,不经打包器解析裸模块导入;
- 本包在根 `pnpm scan:public` 的浏览器产物隔离扫描范围内
  (`tooling/scan-public-artifacts.mjs` PUBLIC_PACKAGES),dist 落地后自动
  纳入扫描。

## 版本组合登记(WP-F1 锁定,2026-09-11)

| 依赖 | 锁定范围 | 说明 |
|---|---|---|
| `lit` | `^3.3.3` | Lit 3 最新稳定(与 vm-ui 同源同版) |
| `vite` | `^8.3.0` | 最新稳定(rolldown/oxc 工具链) |
| `jsdom` | `^30.0.1` | 组件测试环境 |

装饰器模式与 vm-ui 一致:`experimentalDecorators: true` +
`useDefineForClassFields: false`(Vite 8 oxc 暂不支持标准装饰器 lowering,
理由详见 `packages/vm-ui/README.md`)。

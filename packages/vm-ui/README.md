# @stackmaster/vm-ui

投影渲染库(阶段四 WP-F1 脚手架):公开投影的浏览器渲染层,Lit 3 + TypeScript,
Vite library mode 多入口构建。依赖方向强制为只依赖 `@stackmaster/protocol` 的
**公开入口**(dependency-cruiser `browser-packages-only-depend-on-protocol`);
禁止依赖 `@stackmaster/protocol/server-only`、challenge-schema、session-core /
session-api / vm-engine。

## 目录

```
src/
├── index.ts          公开入口(当前导出 <sm-workspace>;后续 WP 在此扩充)
├── ui/               视图组件(sm-workspace 工作区空壳;WP-F3/F4/F5 填充)
├── client/           [占位] WP-F2:session-client(REST 5 命令、认证 WSS、
│                     断线重连、rAF 合帧)
└── datasource/       [占位] WP-F2:MemoryDataSource 双档抽象与
                      ProjectionDataSource 公开档
```

## 构建形态

- `pnpm build` = `tsc -b`(emitDeclarationOnly,先产 `dist/*.d.ts`)+
  `vite build`(库模式多入口:`index` 与 `sm-workspace`,ESM 输出 `dist/`);
  `emptyOutDir: false`——vite 不得抹掉 tsc 先行产出的声明文件;
- **产物自包含**:运行时依赖(lit、@lit-labs/virtualizer)内联进 dist 产物,
  产物不含裸模块导入——宿主(含 `apps/plugin-dev` 开发壳)可以用
  `<script type="module">` 直接加载 `dist/index.js`,不经打包器;
- turbo 任务对齐:`build` outputs 为 `dist/**` 与 `*.tsbuildinfo`。

## 版本组合登记(WP-F1 锁定,2026-09-11)

| 依赖 | 锁定范围 | 说明 |
|---|---|---|
| `lit` | `^3.3.3` | Lit 3 最新稳定 |
| `@lit-labs/virtualizer` | `^2.1.1` | 声明依赖 `lit ^3.2.0`,与 lit 3.3.3 组合经兼容冒烟验证 |
| `vite` | `^8.3.0` | 最新稳定(rolldown/oxc 工具链) |
| `jsdom` | `^30.0.1` | 组件测试环境(vitest `environment: "jsdom"`) |

已验证组合:**lit 3.3.3 × @lit-labs/virtualizer 2.1.1 × vite 8.3.0**;
兼容证据 = `test/lit-virtualizer-compat.test.ts`(10 万行虚拟列表首屏渲染冒烟,
《前端实施计划》§六登记风险的落地对策)。升级任一依赖先更新此处与本测试,
再跑 `pnpm --filter @stackmaster/vm-ui test`。

**装饰器模式登记**:本包 tsconfig 采用 `experimentalDecorators: true` +
`useDefineForClassFields: false`(Lit 经典装饰器形态)。原因:Vite 8 的
oxc 转换器**尚不支持 TC39 标准装饰器 lowering**(oxc-project/oxc#9170),
标准装饰器需退回 Vite 7(esbuild)或引入 Babel;Lit 3 对两种模式均兼容,
待 oxc 支持后可统一切换标准模式(`@property` 需改 `accessor` 字段)。

## 测试

- 环境:jsdom(无布局引擎),`test/setup.ts` 桩补 `ResizeObserver`、
  `getBoundingClientRect`(固定 300×300)与 rAF 兜底——虚拟列表首屏计算
  在该桩下进行;
- 覆盖率:本包自 WP-F1 起纳入根 `pnpm test:coverage` 聚合
  (`vitest.coverage.config.ts` projects 含 `packages/*`),整体门槛 ≥ 80%。

## 纪律速查

- 视图组件禁止绕过 `MemoryDataSource` 接口直读 session-client 投影存储
  (前端实施计划 §四;评审解耦的关键约束);
- 浏览器任何位置只保存公开投影与 UI 状态;
- 动画只用 transform / opacity 等 compositor 友好属性;语义化 DOM +
  虚拟列表,控制流用 SVG;屏幕阅读器信息不得只存在于 Canvas。

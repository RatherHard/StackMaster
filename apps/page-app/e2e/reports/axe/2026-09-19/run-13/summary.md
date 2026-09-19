# axe 真机面矩阵报告(page-app 新面集合;2026-09-19 / run-13)

- 载体:`apps/page-app/e2e/axe-matrix.spec.ts`(真 chromium + 真 vm-ui 产物 + `vite preview`;
  `POST /sessions` 由 Playwright 按契约形态注入 ⇒ **不需要 Docker**)。
- 归档目录:apps/page-app/e2e/reports/axe/2026-09-19/run-13/
  (**同日复跑不覆盖**:序号目录或 `AXE_ARCHIVE_LABEL` 显式命名;遗留 #13 修法)。
- 归档确定性(遗留 #13):剥 `esid`(UUID)与 Lit `` 标记、对象键排序、统一 LF ⇒
  「测量结果相同 ⇒ 归档字节相同」,不再产生伪 diff。
- **历史归档** `apps/plugin-dev/e2e/reports/axe/**`(九面 `plugin-iframe-*` 等)**只增不改**,
  本报告不触碰;那些面随嵌入协议整体退役而不再可达。

## 面集合(新形态;逐面理由)

| 面 | 视口 | 状态 | 单独成面的理由 |
|---|---|---|---|
| page-app-1440x900-default | 1440×900 | default | 默认形态:两个可见视图位(栈 + 寄存器)+ 列表收起 + 右半侧 payload 同屏 |
| page-app-1440x900-list-open | 1440×900 | list-open | 列表按钮展开:原生 checkbox 勾选面 + aria-live 播报区(D-UI-4 / D-UI-7 ③) |
| page-app-1440x900-instruction | 1440×900 | instruction | 指令视图:伪汇编 chip / 跳转链(历史上 graytext 4.47:1 缺陷所在面) |
| page-app-1440x900-payload | 1440×900 | payload | payload 搭建窗口:WP-83 惰性宿主 + Blockly 画布(深底精灵处理 token) |
| page-app-1024x768-default | 1024×768 | default | 中档默认形态(工具区开始换行) |
| page-app-1024x768-list-open | 1024×768 | list-open | 中档列表展开面 |
| page-app-768x900-default | 768×900 | default | 窄档默认形态(页面横向滚动,右半侧在视口外) |
| page-app-375x667-default | 375×667 | default | 极窄档默认形态(两半侧各保底 452.4px) |
| page-app-375x667-payload | 375×667 | payload | 极窄档 payload 面 |

## 结果(**自动判定通过 / 无法判定**分列 —— 不得把 incomplete 写成「正向通过」)

| 面 | violations | 自动判定通过(节点) | 无法判定 incomplete(节点) | color-contrast(通过 / 无法判定 / 违规) |
|---|---|---|---|---|
| page-app-1440x900-default | 0 | 814 | 92 | passed(19 / 92 / 0) |
| page-app-1440x900-list-open | 0 | 1256 | 131 | passed(17 / 131 / 0) |
| page-app-1440x900-instruction | 0 | 1191 | 76 | passed(17 / 76 / 0) |
| page-app-1440x900-payload | 0 | 1191 | 112 | passed(17 / 112 / 0) |
| page-app-1024x768-default | 0 | 1124 | 94 | passed(22 / 94 / 0) |
| page-app-1024x768-list-open | 0 | 1189 | 101 | passed(22 / 101 / 0) |
| page-app-768x900-default | 0 | 1120 | 96 | passed(18 / 96 / 0) |
| page-app-375x667-default | 0 | 1114 | 100 | passed(13 / 100 / 0) |
| page-app-375x667-payload | 0 | 1114 | 100 | passed(13 / 100 / 0) |

- 合计:9 面,**violations = 0**;自动判定通过节点 = 10113;无法判定节点 = 902。
- **声明的边界**「violations = 0」只说明**自动可判定**部分无违规;`incomplete` 面(含
  color-contrast 因半透明覆盖层 / 扫描线无法计算合成对比度者)属**人工复核项**,与
  「正向通过」不是同一句话(遗留 #14 的薄绿纪律)。

### 无法判定明细(incomplete;逐面逐规则)

- page-app-1440x900-default:color-contrast×92
- page-app-1440x900-list-open:color-contrast×131
- page-app-1440x900-instruction:color-contrast×76
- page-app-1440x900-payload:color-contrast×112
- page-app-1024x768-default:color-contrast×94
- page-app-1024x768-list-open:color-contrast×101
- page-app-768x900-default:color-contrast×96
- page-app-375x667-default:color-contrast×100
- page-app-375x667-payload:color-contrast×100

## 未扫描面清单(归档自洽性;遗留 #13 ⑤)

- 无 —— 声明的 9 面全部产出 JSON。

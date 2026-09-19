# docs/archive —— 随退役面归档的历史证据

## 1. 本目录的纪律

- 本目录只存放**随退役面一并失去载体的历史证据**:生成它的应用 / 测试 / 夹具已被物理删除,重跑已不可能 ⇒ 本目录是它在仓库内的**唯一留存点**。
- **只增不改**:已归档的目录与文件**逐字节冻结**,不得覆盖、不得重写、不得「顺手规范化」(会话 id / Lit 模板标记 / 行尾符一律保留原样)。新增归档 = 新建日期或形态子目录。
- 本目录**不是**活契约、**不是**现行门禁口径、**不是**产品现状描述。引用它的唯一正当用途是**证据溯源**(§3)。

## 2. 归档条目

### 2.1 `axe-归档-plugin-dev/`(2026-09-19,WP-96 归档)

| 项 | 内容 |
|---|---|
| 原出处 | `apps/plugin-dev/e2e/reports/axe/**`(WP-74 落地;目录按**运行当日**生成,`RUN_DATE`) |
| 归档目标 | `docs/archive/axe-归档-plugin-dev/<原日期目录名>/**`(日期目录名逐字保留:`2026-09-11/`、`2026-09-17/`、`2026-09-18/`) |
| 条目 | 3 个日期目录 / **27 个文件**(`2026-09-11/` = 6 份 `plugin-*.json` + `summary.md`;`2026-09-17/`、`2026-09-18/` 各 9 份 + `summary.md`) |
| 字节一致性 | 归档与源**逐文件 SHA256 相同(27/27)**;拷贝为字节级拷贝,`summary.md` 逐字节不变 |
| 对应形态 | **嵌入协议 / iframe 面矩阵**(插件形态):`plugin-iframe-{light,dark,terminal} × {registers,stack}` + `plugin-dev-shell-{light,terminal}` + `plugin-degraded-light` |
| 退役处置 | 2026-09-19 WP-96:**原件随 `apps/plugin-dev/` 物理删除**;本目录即其留存载体 |

**为什么保留(不保留 = 静默销毁证据)**:

- `docs/phases/中期验收评审.md:133`(§六 **#13**,「axe 归档的证据卫生」)的**全部实测依据**都在该归档内:`:133` 的补充核实 ⑤(「`summary.md` 不记录未扫描面 ⇒ 目录会留着旧文件而汇总无对应行 = 归档自相矛盾」)以 `2026-09-17/` 内**旧文件与 summary 行数不一致**为证;⑥(面矩阵口径自称 10 份、代码最多只写 9 份)与 ⑦(`AxeFaceResult` 声明 `axeVersion` 而落盘 JSON 无该字段)均须**逐文件读该目录**才能复核。
- `docs/phases/中期验收评审.md:134`(§六 **#14**,「terminal 三面的 color-contrast 自动判定覆盖度倒挂」)的结论 = **逐面读 `2026-09-17/` 归档 JSON** 的 `colorContrastCheckedNodes` 与 `incomplete[].count` 得到的读数表(评审 `:136-142`:light / dark 面 132 自动判定 / 7 无法判定;terminal 面 **7 / 132** 倒挂;shell-terminal 19 / 134)—— 删掉该目录,该表及其结论**不可复核**。
- 同一评审 `:145` 另有一条**关于归档自身字节状态**的断言(「归档 `summary.md` 与 M2 提交版字节相同」),只有原样保留归档才成立。
- 执行视图:`docs/phases/中期遗留清单.md:116`(P2-1 · 遗留 14)与 `:133`(P2-2 · 遗留 13);两条均为**仍开放**项,其「证据强度」判定不因形态退役而消失。

⇒ 一句话:这两条遗留的**证据本体在此**。退役可以删除**生成证据的载体**,但不得**同时销毁证据** —— 那会让两条开放遗留变成不可复核的空指针(「不得以沉默结案」,评审 `:146` / 清单 `:131`)。

## 3. 这些面已不可达(退役后扫描面清单的显式说明)

- **生成面不存在**:`apps/plugin-dev`(host-mock 模拟页 / 5174 插件产物页 / `e2e/axe-contrast.spec.ts` / `e2e/reports/axe/**` 的写入点)已于 2026-09-19 随 WP-96 物理删除;`packages/web-component`(面矩阵里的 `pwn-memory-vm` 自定义元素宿主)与 `packages/embed-runtime`(嵌入协议 SDK)同批删除。⇒ 上表面矩阵**没有任何可复现路径**,重跑已不可能。
- **面清单(已不可达,仅作历史对照)**:`plugin-iframe-{light,dark,terminal} × {registers,stack}`(6)+ `plugin-dev-shell-{light,terminal}`(2)+ `plugin-degraded-light`(1)= 可达 **9 面**;`degraded terminal` **有意从不扫描**(M2 登记)。归档 `2026-09-17/`、`2026-09-18/` 各 9 份 JSON;`2026-09-11/` 为 WP-55 期的 6 份。
- **现行形态**:与 API 同源的独立页面分发(`apps/page-app`);其 axe 面矩阵与归档在 `apps/page-app/e2e/axe-matrix.spec.ts` 与 `apps/page-app/e2e/reports/axe/**`(九面,新形态)。**本目录与它无关**,两套面名不可互相套用。

## 4. 未归档项(随退役面删除,不另存)

`apps/plugin-dev/**` 的其余全部内容(源码、夹具、E2E spec、`host-mock/`、`README.md`、`e2e/RETIRED-SURFACE.md` 等)属**可重写或已由新形态承接**的工程载体,不属「不可复现的历史证据」⇒ 随 WP-96 物理删除,不另存。其中 `e2e/RETIRED-SURFACE.md` 是 WP-95 的逐文件处置登记,其**结论**已被记账在 `CLAUDE.md`「分发改版与 UI 重设计落地事实」段与 `docs/develop/decisions-分发改版与UI重设计.md`;若后续需要其正文,取 git 历史(`2840eac` 及更早)。

## 5. 与退役面的关系

退役面的边界与处置依据见 `docs/develop/decisions-分发改版与UI重设计.md` 与 `docs/phases/分发改版与UI重设计任务分解与接手入口.md` §4.3。本目录**只承载证据**,不承载裁决。

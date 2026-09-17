# axe color-contrast 真机补测报告(2026-09-17)

- 生成:WP-74 `e2e/axe-contrast.spec.ts` 真机扫描(chromium 门禁口径),归档目录 = **运行当日**
  `e2e/reports/axe/2026-09-17/`(每扫描面一份 JSON + 本汇总)。
- **归档纪律**:归档即历史证据,目录按日期新增、**无覆盖开关**;历史目录(如 WP-55 的
  `2026-09-11/`)只增不改,永不被新测量覆写。
- 口径:chromium(Playwright 真机)+ axe-core 全规则(**含 color-contrast**,
  `test/ed/axe.test.ts` 豁免清单第 1 条于真机关闭);页面级 harness 沿豁免清单
  第 2 条(lang / title / main landmark,扫描变体页挂载前携带)。
- 判定:每扫描面 violations = 0,color-contrast 规则必须真实执行(判定桶
  passed / incomplete 均为已执行;incomplete = 引擎无法自动判定,人工复核项)。
- 豁免对照:jsdom 豁免清单仅 color-contrast 一条(环境伪影),真机已启用;
  其余规则在 jsdom 与真机均全程启用,两侧判定期望一致。
- 面矩阵:三预设 × 既有扫描面 = 插件面(registers / stack × light / dark / terminal);
  降级面(light / terminal);壳面(light / terminal)。预设承载路径:light / dark 走嵌入协议
  `theme_changed`;terminal 不经协议(EMBED_THEMES 冻结),由外部 `data-sm-theme` 锚承载
  (插件文档页预置 / 运行期写入 / 独立使用形态 theme 属性,见 `e2e/helpers/theme-anchor.ts`)。
- 不可达格登记(如实登记):shell dark(本机 headless 不绘制 root 级暗色画布,半暗态伪影)、
  degraded dark(降级形态无握手 ⇒ 无 theme_changed 通道,宿主元素外部锚被插件写回 resolvedTheme)。

| 扫描面 | 预设 | 视图 / 形态 | 归档 JSON | color-contrast 判定桶(检查节点数) | violations | incomplete |
|---|---|---|---|---|---|---|
| plugin-iframe | light | registers | plugin-iframe-light-registers.json | passed(132) | 0 | color-contrast×7[[["pwn-memory-vm","sm-workspace","#blockly-4\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-5\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-6\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-7\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-8\\.label"]]] |
| plugin-iframe | light | stack | plugin-iframe-light-stack.json | passed(132) | 0 | color-contrast×7[[["pwn-memory-vm","sm-workspace","#blockly-4\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-5\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-6\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-7\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-8\\.label"]]] |
| plugin-iframe | dark | registers | plugin-iframe-dark-registers.json | passed(132) | 0 | color-contrast×7[[["pwn-memory-vm","sm-workspace","#blockly-4\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-5\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-6\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-7\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-8\\.label"]]] |
| plugin-iframe | dark | stack | plugin-iframe-dark-stack.json | passed(132) | 0 | color-contrast×7[[["pwn-memory-vm","sm-workspace","#blockly-4\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-5\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-6\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-7\\.label"]]; [["pwn-memory-vm","sm-workspace","#blockly-8\\.label"]]] |
| plugin-iframe | terminal | registers | plugin-iframe-terminal-registers.json | passed(7) | 0 | color-contrast×132[[["pwn-memory-vm","sm-workspace","sm-workspace-menu",".window-group-label"]]; [["pwn-memory-vm","sm-workspace","sm-workspace-menu","button[data-window-type=\"stack\"]"]; [["pwn-memory-vm","sm-workspace","sm-workspace-menu","button[data-window-type=\"free\"]"]]; [["pwn-memory-vm","sm-workspace","sm-workspace-menu","button[data-window-type=\"registers\; [["pwn-memory-vm","sm-workspace","sm-workspace-menu","button[data-window-type=\"payload\"]] |
| plugin-iframe | terminal | stack | plugin-iframe-terminal-stack.json | passed(7) | 0 | color-contrast×132[[["pwn-memory-vm","sm-workspace","sm-workspace-menu",".window-group-label"]]; [["pwn-memory-vm","sm-workspace","sm-workspace-menu","button[data-window-type=\"stack\"]"]; [["pwn-memory-vm","sm-workspace","sm-workspace-menu","button[data-window-type=\"free\"]"]]; [["pwn-memory-vm","sm-workspace","sm-workspace-menu","button[data-window-type=\"registers\; [["pwn-memory-vm","sm-workspace","sm-workspace-menu","button[data-window-type=\"payload\"]] |
| plugin-degraded | light | — | plugin-degraded-light.json | passed(2) | 0 | — |
| plugin-dev-shell | light | — | plugin-dev-shell-light.json | passed(146) | 0 | color-contrast×7[[["sm-workspace","#blockly-4\\.label"]]; [["sm-workspace","#blockly-5\\.label"]]; [["sm-workspace","#blockly-6\\.label"]]; [["sm-workspace","#blockly-7\\.label"]]; [["sm-workspace","#blockly-8\\.label"]]] |
| plugin-dev-shell | terminal | — | plugin-dev-shell-terminal.json | passed(19) | 0 | color-contrast×134[[["sm-workspace","sm-workspace-menu",".window-group-label"]]; [["sm-workspace","sm-workspace-menu","button[data-window-type=\"stack\"]"]]; [["sm-workspace","sm-workspace-menu","button[data-window-type=\"free\"]"]]; [["sm-workspace","sm-workspace-menu","button[data-window-type=\"registers\"]"]]; [["sm-workspace","sm-workspace-menu","button[data-window-type=\"payload\"]"]]] |

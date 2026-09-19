# WP-55 axe color-contrast 真机补测报告(2026-09-11)

- 口径:chromium(Playwright 真机)+ axe-core 全规则(**含 color-contrast**,
  `test/ed/axe.test.ts` 豁免清单第 1 条于真机关闭);页面级 harness 沿豁免清单
  第 2 条(lang / title / main landmark,扫描变体页挂载前携带)。
- 判定:每扫描面 violations = 0,color-contrast 规则必须真实执行(判定桶
  passed / incomplete 均为已执行;incomplete = 引擎无法自动判定,人工复核项)。
- 豁免对照:jsdom 豁免清单仅 color-contrast 一条(环境伪影),真机已启用;
  其余规则在 jsdom 与真机均全程启用,两侧判定期望一致。

| 扫描面 | 主题 | color-contrast 判定桶(检查节点数) | violations | incomplete |
|---|---|---|---|---|
| plugin-iframe | light-registers | passed(51) | 0 | — |
| plugin-iframe | light-stack | incomplete(1) | 0 | color-contrast×1[[["pwn-memory-vm","sm-workspace","sm-byte-tab","sm-vma-list","h3"]]] |
| plugin-iframe | dark-registers | incomplete(1) | 0 | color-contrast×1[[["pwn-memory-vm","sm-workspace","sm-byte-tab","sm-vma-list","h3"]]] |
| plugin-iframe | dark-stack | incomplete(1) | 0 | color-contrast×1[[["pwn-memory-vm","sm-workspace","sm-byte-tab","sm-vma-list","h3"]]] |
| plugin-degraded | light | passed(2) | 0 | — |
| plugin-dev-shell | light | passed(65) | 0 | — |

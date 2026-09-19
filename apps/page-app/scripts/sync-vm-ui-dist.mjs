#!/usr/bin/env node
/**
 * 把 vm-ui 构建产物同步到本应用的 public/ 暂存目录(WP-92)。
 *
 * ## 为什么要这一趟拷贝
 *
 * 两件事同时成立,才需要一个显式步骤:
 *
 *  1. **apps 不得静态依赖浏览器可达包**(`tooling/dependency-cruiser.cjs` 的
 *     `no-backend-dependency-on-browser-packages`)⇒ 页面只能以**运行期 URL**
 *     加载 vm-ui 产物(见 `src/vm-ui-module.ts`),而这份产物必须真的躺在
 *     同源静态路径上;
 *  2. **vite 的 `publicDir` 语义是"内容平铺到 outDir 根"** —— 直接把
 *     `packages/vm-ui/dist` 指成 publicDir,vm-ui 的 `index.html` / `index.js`
 *     会与本应用自己的产物**同名相撞**(实测:`vite build` 报
 *     「public 目录里的文件会覆盖构建产物」且 `dist/index.html` 变成 vm-ui 的)。
 *
 * 因此:先把 vm-ui 产物同步到 `public/vm-ui/`,再让 vite 以 `public/` 为
 * publicDir 整目录拷贝到 `dist/vm-ui/`。开发态同样受用(vite 的 `public/`
 * 在 dev server 上按 `/` 提供 ⇒ `/vm-ui/index.js` 可用)。
 *
 * ## 纪律
 *
 *  - **只动 `public/vm-ui/`**(先删后拷,保证 vm-ui 侧删掉的文件不会在本应用
 *    产物里留下陈旧副本);`public/` 下其它内容一律不碰;
 *  - 源目录不存在 ⇒ **非零退出并给出可操作提示**(先构建 vm-ui)。静默产出
 *    一个没有前端资源的页面,是比构建失败更坏的失败模式。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
const sourceDir = join(appDir, "..", "..", "..", "packages", "vm-ui", "dist");
const targetDir = join(appDir, "..", "public", "vm-ui");

if (!existsSync(sourceDir)) {
  console.error(
    `[sync-vm-ui-dist] 源目录不存在:${sourceDir}\n` +
      "[sync-vm-ui-dist] 请先执行 `pnpm --filter @stackmaster/vm-ui build`(或整仓 `pnpm build`)。",
  );
  process.exit(1);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true, force: true });

console.log(`[sync-vm-ui-dist] ${sourceDir} → ${targetDir}`);

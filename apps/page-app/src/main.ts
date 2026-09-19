/**
 * page-app 入口(分发改版 WP-92)。
 *
 * 页面由 **session-api 同源托管**(`SESSION_API_PAGE_APP_DIR` 指向本应用产物),
 * 加载路径只可能是两种:
 *
 *  - `/app/c/:challengeId/:version` —— 换票 302 之后的**干净路径**(无票据
 *    查询串),页面在此引导;
 *  - 其它路径 —— 引导层判定为无效地址并给出一条可读提示(绝不白屏)。
 *
 * 本文件刻意保持极小:一切序列在 `boot.ts`(可注入、可单测),这里只做
 * 「取挂载根 → 调用 → 失败兜底」。
 */
import { bootPage } from "./boot.js";

/** 缺省挂载根;index.html 中的 `#app`。 */
const MOUNT_SELECTOR = "#app";

async function main(): Promise<void> {
  const root = document.querySelector<HTMLElement>(MOUNT_SELECTOR);
  if (root === null) {
    // 结构性异常(html 与入口不匹配):退化为 body 上呈现,不静默丢消息。
    document.body.textContent = "页面挂载点 #app 缺失:请检查 index.html 与入口是否同源部署。";
    return;
  }
  await bootPage({ root });
}

void main();

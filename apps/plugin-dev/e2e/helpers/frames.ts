/**
 * 帧定位帮手(WP-74 抽面):插件 iframe 的跨源 Frame 对象。
 *
 * 使用场景:需要在**插件文档**上下文内执行脚本 / 求值(axe 注入、terminal 锚
 * 写入、装饰面探测)。此前面为此 axe 真机 spec 的内联函数;WP-74 起 axe 真机
 * spec 与 reduced-motion spec 共用,收敛到本文件(选择器 / 定位策略唯一登记点)。
 *
 * 定位策略 = 帧 URL 前缀(插件独立来源 origin,与 helpers/embed.ts 的
 * `PLUGIN_SITE_URL` 同值);宿主模拟页不匹配该前缀,故结果唯一。
 */
import type { Frame, Page } from "@playwright/test";

import { PLUGIN_SITE_URL } from "./embed.js";

/** 定位插件 iframe 的 Frame(跨源帧对象,供 addScriptTag / evaluate)。 */
export function pluginFrameOf(page: Page): Frame {
  const frame = page.frames().find((candidate) => candidate.url().startsWith(PLUGIN_SITE_URL));
  if (frame === undefined) {
    throw new Error(`插件 iframe 帧未找到(期望 URL 前缀 ${PLUGIN_SITE_URL})`);
  }
  return frame;
}

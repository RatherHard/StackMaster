/**
 * Playwright globalTeardown(WP-F7):收尾本 setup 拉起的 compose 拓扑。
 *
 * 收口纪律:只回收 global-setup 自己拉起的拓扑(状态文件 assumedRunning=false);
 * 外部托管(E2E_SKIP_COMPOSE=1 / 已在运行)与 E2E_KEEP_COMPOSE=1(调试复跑)
 * 一律不动拓扑。收尾 = compose:app:down 等价(down -v,含数据卷)。
 */
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { e2eEnv } from "./helpers/env.js";
import { composeAppDown } from "./helpers/compose.js";

const STATE_PATH = join(fileURLToPath(new URL("../.tmp/e2e-state.json", import.meta.url)));

interface SetupState {
  readonly assumedRunning: boolean;
}

function readState(): SetupState | null {
  if (!existsSync(STATE_PATH)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as SetupState;
  } catch {
    return null;
  }
}

export default async function globalTeardown(): Promise<void> {
  const env = e2eEnv();
  const state = readState();

  if (env.keepCompose) {
    console.log("[e2e] E2E_KEEP_COMPOSE=1:保留 compose 拓扑(复跑调试用)");
    return;
  }
  if (state === null) {
    console.log("[e2e] 无 setup 状态文件(setup 未完成或外部托管):跳过拓扑收尾");
    return;
  }
  if (state.assumedRunning) {
    console.log("[e2e] 拓扑为外部托管:跳过 compose:app:down");
    return;
  }

  console.log("[e2e] 收尾 compose 拓扑(down -v;失败也执行,不掩盖测试结果)……");
  try {
    composeAppDown();
  } finally {
    // 状态文件一次性消费;残留即清理(.tmp/ 本就在版本库外)。
    try {
      unlinkSync(STATE_PATH);
    } catch {
      rmSync(STATE_PATH, { force: true });
    }
  }
}

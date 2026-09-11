/**
 * Playwright globalSetup(WP-F7):compose 全拓扑就绪 + 题目登记。
 *
 * 职责(可配置):
 *  - 前置产物检查(vm-ui dist / session-api dist,给出可操作指引);
 *  - E2E_SKIP_COMPOSE=1 或拓扑已就绪(readyz 200)→ 视为外部托管,跳过
 *    compose:app:up(teardown 相应跳过 down);
 *  - 否则拉起全拓扑(PostgreSQL + Redis + MinIO + session-api;vm-worker 由
 *    编排器按会话 spawn,不参与 up --wait,D-API-64);
 *  - 题目登记:复用 `apps/session-api/k6/seed-challenge.mjs` 的真实登记路径
 *    (ChallengeRegistrar + Ed25519 登验签;版本不可变,已存在即复用)。
 *
 * 运行状态经 `.tmp/e2e-state.json` 传给 global-teardown(只有本 setup 拉起的
 * 拓扑才由 teardown 收尾,避免误关开发者自管拓扑)。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { e2eEnv } from "./helpers/env.js";
import {
  assertPrerequisites,
  composeAppUp,
  seedChallenge,
  topologyRunning,
  waitForReady,
} from "./helpers/compose.js";

/** setup → teardown 状态传递文件(.tmp/ 在仓库 .gitignore 内)。 */
const STATE_PATH = join(fileURLToPath(new URL("../.tmp/e2e-state.json", import.meta.url)));

export default async function globalSetup(): Promise<void> {
  const env = e2eEnv();
  assertPrerequisites();

  let assumedRunning = false;
  if (env.skipCompose) {
    console.log("[e2e] E2E_SKIP_COMPOSE=1:跳过 compose 拉起(假设拓扑已由外部托管)");
    assumedRunning = true;
  } else if (await topologyRunning(env.sessionApiOrigin)) {
    console.log("[e2e] session-api readyz 已就绪:跳过 compose:app:up(外部托管拓扑)");
    assumedRunning = true;
  } else {
    console.log("[e2e] 拉起 compose 全拓扑(up -d --build --wait;冷构建可能需要数分钟)……");
    composeAppUp();
  }

  const ready = await waitForReady(env.sessionApiOrigin);
  if (!ready) {
    throw new Error(`session-api readyz 未就绪(${env.sessionApiOrigin}):核对 compose 拓扑日志`);
  }

  console.log(`[e2e] 登记题目:${env.tenantId}/${env.challengeId}@${env.challengeVersion}`);
  seedChallenge({ challengeId: env.challengeId, tenantId: env.tenantId });

  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ assumedRunning }, null, 2), "utf8");
  console.log(`[e2e] global-setup 完成(assumedRunning=${assumedRunning})`);
}

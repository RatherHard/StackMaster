/**
 * 断线保持到期回收的接线面(任务分解 WP-6 第 3 条;D-API-55)。
 *
 * 挂载点 = `SessionConnectionRegistry` 的 `onKeepaliveExpiry(sessionId, tenantId)`
 * 钩子(WP-5 只负责保持计时器的启动 / 取消与 route 键释放,回收执行面归
 * WP-6,D-API-45)。执行序:注册表先释放 `route:{sessionId}`(无双重释放——
 * 回收路径不触碰 route 键),再进入本钩子:会话优雅关闭(worker 回收)+
 * sessions 行 phase 对齐 + 移出在途表 + 强制关闭审计
 * (`LiveSessionManager.reclaimDisconnected`)。
 *
 * 钩子异常不向上传播:到期回收失败(如会话行已被并发关闭)只进受控日志,
 * 不打断注册表的到期路径(计时器已消费,拒绝路径无重入语义)。
 */
import type { LiveSessionManager } from "../sessions/session-manager.js";
import type { Logger } from "pino";

/** 注册表 onKeepaliveExpiry 的钩子形态(与 connection-registry.ts 同构)。 */
export type KeepaliveExpiryHook = (session: {
  readonly sessionId: string;
  readonly tenantId: string;
}) => void | Promise<void>;

/**
 * 构造回收钩子:保持窗口到期 → closeSession 语义的资源回收
 * (会话关闭 + worker 回收 + 会话行 phase 对齐);失败只进受控日志。
 */
export function keepaliveExpiryReaper(manager: LiveSessionManager, logger: Logger): KeepaliveExpiryHook {
  const log = logger.child({ component: "keepalive-reaper" });
  return async ({ sessionId, tenantId }) => {
    try {
      await manager.reclaimDisconnected(sessionId, tenantId);
    } catch (error) {
      log.warn(
        {
          sessionId,
          tenantId,
          reason: error instanceof Error ? error.message : "reclaim failed",
        },
        "session reclaim on keepalive expiry failed",
      );
    }
  };
}

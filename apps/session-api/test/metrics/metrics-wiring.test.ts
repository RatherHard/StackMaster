/**
 * 指标面端到端接线测试(阶段三 WP-8;D-API-70 / D-API-71 / D-API-72):
 * rig(内存同构栈 + 假 worker)注入 SessionMetrics,经真实 manager.applyAction
 * 与生命周期路径断言——
 *  - 动作 RTT 按 outcome(accepted / rejected / error)三值产生样本;
 *  - 投影增量字节只对已接受动作观测(fake worker 的 delta 非空形态);
 *  - 并发会话数 / Worker 占用随 create / close 同步;队列深度执行后归零;
 *  - 渲染输出过标签纪律机检零违例,且真实会话 ID(服务端签发标识符)零出现
 *    ——指标输出零秘密泄露面的断言(与 /metrics 暴露面同源)。
 */
import { describe, expect, it } from "vitest";

import { SessionMetrics, assertMetricsTextDiscipline } from "../../src/metrics/metrics.js";
import {
  TEST_TENANT_ID,
  buildSessionTestRig,
  type SessionTestRig,
} from "../routes/helpers/session-rig.js";

const WRITE_ACTION = { type: "write_bytes", args: { addressHex: "0x7ffff000", bytesHex: "0102" } } as const;
const REJECT_ACTION = { type: "write_bytes", args: { addressHex: "0x7ffff000", bytesHex: "ff" } } as const;

async function createSessionDirect(rig: SessionTestRig, tenantId = TEST_TENANT_ID): Promise<string> {
  return rig.manager.createSession({
    tenantId,
    userId: "user-42",
    challengeId: "chal-stack-escape",
    challengeVersion: "1.2.3",
    embedTokenJti: `jti-${Math.random().toString(36).slice(2)}`,
  }).then((outcome) => outcome.sessionId);
}

describe("指标接线(manager → SessionMetrics,D-API-70)", () => {
  it("动作 RTT / 投影字节 / 会话 gauges 随真实链路产生样本;输出零标识符零语料", async () => {
    const metrics = new SessionMetrics();
    const rig = await buildSessionTestRig({ metrics });
    await rig.registerChallenge();
    const sessionId = await createSessionDirect(rig);

    expect(await rig.manager.applyAction(sessionId, TEST_TENANT_ID, WRITE_ACTION).then((r) => r.status)).toBe("running");
    expect(await rig.manager.applyAction(sessionId, TEST_TENANT_ID, REJECT_ACTION).then((r) => r.status)).toBe("rejected");

    const text = await metrics.render();
    // 已接受样本 + 拒绝样本(同一动作类型,按 outcome 分道)。
    expect(text).toContain('session_api_action_rtt_seconds_count{action="write_bytes",outcome="accepted"} 1');
    expect(text).toContain('session_api_action_rtt_seconds_count{action="write_bytes",outcome="rejected"} 1');
    // 投影增量字节:仅已接受动作(fake worker 拒绝路径 delta 为 null,零观测)。
    expect(text).toContain('session_api_projection_delta_bytes_count{action="write_bytes"} 1');
    // 并发会话与 Worker 占用(创建后各 1;T0 每会话单进程,D-API-72)。
    expect(text).toContain("session_api_live_sessions 1");
    expect(text).toContain("session_api_worker_processes 1");
    // 队列深度:执行结束后归零。
    expect(text).toContain("session_api_action_queue_depth 0");
    // 标签纪律机检零违例 + 真实会话 ID 零出现(指标零标识符纪律,D-API-71)。
    expect(assertMetricsTextDiscipline(text)).toEqual([]);
    expect(text).not.toContain(sessionId);

    await rig.manager.closeSession(sessionId, TEST_TENANT_ID);
    const afterClose = await metrics.render();
    expect(afterClose).toContain("session_api_live_sessions 0");
    expect(afterClose).toContain("session_api_worker_processes 0");
    await rig.app.close();
  });

  it("编排器域异常产生 outcome=error 样本(worker 崩溃路径)", async () => {
    const metrics = new SessionMetrics();
    const rig = await buildSessionTestRig({ metrics, workerMode: "crash_on_apply" });
    await rig.registerChallenge();
    const sessionId = await createSessionDirect(rig);

    await expect(rig.manager.applyAction(sessionId, TEST_TENANT_ID, WRITE_ACTION)).rejects.toThrow();
    const text = await metrics.render();
    expect(text).toContain('session_api_action_rtt_seconds_count{action="write_bytes",outcome="error"} 1');
    // 崩溃收割移出在途表 → 会话 gauges 归零(收割路径同步,D-API-72)。
    expect(text).toContain("session_api_live_sessions 0");
    expect(text).toContain("session_api_worker_processes 0");
    await rig.app.close();
  });
});

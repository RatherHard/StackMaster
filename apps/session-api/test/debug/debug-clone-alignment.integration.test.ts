/**
 * 调试克隆「对齐源」真机集成测试(中期 M3 遗留移交清单第 6 项;D-API-145)。
 *
 * 门控:`SESSION_API_IT=1`(真实 vm-worker 二进制;跑前 `cargo build -p vm-worker`
 * 或由 `ensureWorkerBinary` 按需构建)。会话侧仍走 rig 的假会话 worker
 * (动作序 → 权威 revision),**调试侧 = 真实 vm-worker**(内存字节可观察)——
 * 与 `debug-channel.integration.test.ts` 同一装配拓扑。
 *
 * 缺陷面(红灯):未提交会话的克隆在旧对齐源下**恒为种子初始态**(栈区全
 * `0x00`;M2 真机取证:请求 `targetRevision: 1`、实际 `revision: 0`)。
 * 本文件以**真机字节**固定修法:
 *  - 未提交会话(已落库权威日志 0 条)+ 已改动内存 ⇒ attach 精确对齐到请求
 *    revision,且栈区字节 = **玩家写入字节**(非种子零填充);
 *  - 同一 revision 的克隆**逐字节一致**:同形两会话之间一致、同一会话重复
 *    attach 一致(确定性);
 *  - 调试交互零污染权威日志(ADR-DC1 条款 4 不变)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureWorkerBinary } from "@stackmaster/session-core";
import { DebugFrameSchema, type DebugFrame } from "@stackmaster/protocol";

import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  buildSessionTestRig,
  sessionCommand,
  sessionCredentialFromSetCookie,
  type RigWssClient,
  type SessionTestRig,
} from "../routes/helpers/session-rig.js";

const IT_ENABLED = process.env.SESSION_API_IT === "1";

/** 字节模式程序(push RBP; mov RBP,RSP; syscall exit(1);与 WP-41 IT 同题)。 */
const BYTE_PROGRAM_HEX = "5589cd0100000000000000";
const TENANT_ID = "tenant-alpha";
/** 玩家写入点(栈区;重放对齐的真机可观察面)。 */
const STACK_ADDRESS_HEX = "0x7ffff000";
const PLAYER_BYTES_HEX = "41414141";

class DebugFrameCollector {
  readonly frames: DebugFrame[] = [];

  attach(client: RigWssClient): void {
    client.on("message", (data: Buffer) => {
      this.frames.push(DebugFrameSchema.parse(JSON.parse(data.toString("utf8"))));
    });
  }

  async waitForType(type: DebugFrame["type"], occurrence = 1, timeoutMs = 20000): Promise<DebugFrame> {
    await vi.waitFor(
      () => {
        if (this.frames.filter((frame) => frame.type === type).length < occurrence) {
          throw new Error(`等待调试帧 ${type} #${occurrence} 超时`);
        }
      },
      { timeout: timeoutMs, interval: 10 },
    );
    const match = this.frames.filter((frame) => frame.type === type)[occurrence - 1];
    if (match === undefined) {
      throw new Error(`帧 ${type} #${occurrence} 缺失`);
    }
    return match;
  }
}

describe.skipIf(!IT_ENABLED)("调试克隆对齐源(真实 vm-worker;SESSION_API_IT 门控)", () => {
  const CLEANUPS: (() => Promise<void>)[] = [];

  afterEach(async () => {
    const cleanups = CLEANUPS.splice(0, CLEANUPS.length);
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  async function buildRealWorkerRig(): Promise<SessionTestRig> {
    const workerCommand = { command: await ensureWorkerBinary() };
    const rig = await buildSessionTestRig({ debug: { workerCommand } });
    CLEANUPS.push(async () => {
      await rig.debugOrchestrator.dispose();
      await rig.wssRegistry.closeAll();
      await rig.app.close();
    });
    await rig.registerByteChallenge({ byteProgramHex: BYTE_PROGRAM_HEX });
    return rig;
  }

  /** 建会话 + 已接受动作(栈区写入 + step),**不 submit**(权威日志零落库)。 */
  async function createUnsubmittedSession(rig: SessionTestRig): Promise<{ sessionId: string; cookie: string }> {
    const issued = await rig.issueEmbedToken();
    const response = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: TEST_CHALLENGE_ID,
        challengeVersion: TEST_CHALLENGE_VERSION,
        embedSessionId: issued.claims.embedSessionId,
        embedToken: issued.token,
      }),
    });
    expect(response.statusCode).toBe(201);
    const sessionId = (response.json() as { payload: { sessionId: string } }).payload.sessionId;
    const write = await rig.manager.applyAction(sessionId, TENANT_ID, {
      type: "write_bytes",
      args: { addressHex: STACK_ADDRESS_HEX, bytesHex: PLAYER_BYTES_HEX },
    });
    expect(write.status).toBe("running");
    await rig.manager.applyAction(sessionId, TENANT_ID, { type: "step", args: {} });
    return { sessionId, cookie: sessionCredentialFromSetCookie(response) };
  }

  /** 通道 attach 至指定 revision(每次独立连接,故回执恒为该连接的第 1 帧)。 */
  async function attachAt(
    rig: SessionTestRig,
    cookie: string,
    sessionId: string,
    revision: number,
  ): Promise<{ frame: DebugFrame; collector: DebugFrameCollector }> {
    const client = await rig.connectDebugChannel(cookie);
    const collector = new DebugFrameCollector();
    collector.attach(client);
    client.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "debug_attach",
        sessionId,
        seq: 1,
        requestId: `attach-${revision}`,
        payload: { origin: { kind: "revision", revision } },
      }),
    );
    const frame = await collector.waitForType("debug_attached", 1);
    return { frame, collector };
  }

  async function stackWindow(rig: SessionTestRig, sessionId: string): Promise<string> {
    const window = await rig.debugOrchestrator.window(sessionId, TENANT_ID, STACK_ADDRESS_HEX, 4);
    return window.bytesHex;
  }

  it("未提交会话 + 已改动内存:克隆精确对齐请求 revision 且栈区 = 玩家字节(非种子零填充)", async () => {
    const rig = await buildRealWorkerRig();
    const session = await createUnsubmittedSession(rig);

    // 前提锚:权威 revision = 2 而**已落库权威日志 = 0 条**(未提交)。
    expect(rig.manager.getSessionSummary(session.sessionId, TENANT_ID)?.revision).toBe(2);
    expect(await rig.actionLog.countBySession(session.sessionId, TENANT_ID)).toBe(0);

    const { frame } = await attachAt(rig, session.cookie, session.sessionId, 2);
    expect(frame.type).toBe("debug_attached");
    if (frame.type === "debug_attached") {
      // 红灯(修前):对齐源只剩已落库日志(0 条)⇒ 克隆停在 revision 0。
      expect(frame.payload.revision).toBe(2);
    }
    // 红灯(修前):种子初始态 ⇒ 栈区全 0x00。
    expect(await stackWindow(rig, session.sessionId)).toBe(PLAYER_BYTES_HEX);

    // 调试交互零污染权威日志(条款 4)。
    expect(await rig.actionLog.countBySession(session.sessionId, TENANT_ID)).toBe(0);
  });

  it("确定性:同形两会话 / 同一会话重复 attach 的克隆逐字节一致", async () => {
    const rig = await buildRealWorkerRig();
    const first = await createUnsubmittedSession(rig);
    const second = await createUnsubmittedSession(rig);

    const attachedA = await attachAt(rig, first.cookie, first.sessionId, 2);
    const attachedB = await attachAt(rig, second.cookie, second.sessionId, 2);
    if (attachedA.frame.type !== "debug_attached" || attachedB.frame.type !== "debug_attached") {
      throw new Error("attach 回执缺失");
    }
    // 克隆身份一致(冻结回执形状:revision + status + paused presence)。
    expect(attachedB.frame.payload).toEqual(attachedA.frame.payload);

    // 逐字节一致:栈区(玩家写入)与代码区(变体代码镜像)窗口两侧比对。
    const probeWindows = [STACK_ADDRESS_HEX, "0x400000"] as const;
    for (const [addressHex, byteLength] of [
      [STACK_ADDRESS_HEX, 4],
      ["0x400000", 16],
    ] as const) {
      const windowA = await rig.debugOrchestrator.window(first.sessionId, TENANT_ID, addressHex, byteLength);
      const windowB = await rig.debugOrchestrator.window(second.sessionId, TENANT_ID, addressHex, byteLength);
      expect(windowB.bytesHex).toBe(windowA.bytesHex);
      expect(windowB.truncated).toBe(windowA.truncated);
    }
    expect(await stackWindow(rig, first.sessionId)).toBe(PLAYER_BYTES_HEX);

    // 同一会话同一 revision 重复 attach(新连接):attach 幂等复用实例,
    // 克隆**逐字节一致**(窗口读数前后比对,而非只比回执字段)。
    const before = await Promise.all(
      probeWindows.map((addressHex) =>
        rig.debugOrchestrator.window(first.sessionId, TENANT_ID, addressHex, 16),
      ),
    );
    const reattached = await attachAt(rig, first.cookie, first.sessionId, 2);
    if (reattached.frame.type === "debug_attached") {
      expect(reattached.frame.payload).toEqual(attachedA.frame.payload);
    }
    const after = await Promise.all(
      probeWindows.map((addressHex) =>
        rig.debugOrchestrator.window(first.sessionId, TENANT_ID, addressHex, 16),
      ),
    );
    expect(after.map((window) => window.bytesHex)).toEqual(before.map((window) => window.bytesHex));
    expect(after.map((window) => window.truncated)).toEqual(before.map((window) => window.truncated));
    expect(await stackWindow(rig, first.sessionId)).toBe(PLAYER_BYTES_HEX);
    expect(rig.debugOrchestrator.instanceCount).toBe(2);
  });

  it("不可得的 revision(超出权威 revision)确定性拒绝,且不留半开实例", async () => {
    const rig = await buildRealWorkerRig();
    const session = await createUnsubmittedSession(rig);

    const client = await rig.connectDebugChannel(session.cookie);
    const collector = new DebugFrameCollector();
    collector.attach(client);
    client.send(
      JSON.stringify({
        protocolVersion: 1,
        type: "debug_attach",
        sessionId: session.sessionId,
        seq: 1,
        payload: { origin: { kind: "revision", revision: 3 } },
      }),
    );
    const errorFrame = await collector.waitForType("error");
    if (errorFrame.type === "error") {
      expect(errorFrame.payload).toEqual({
        code: "invalid_input_format",
        message: "revision is not available",
      });
    }
    expect(rig.debugOrchestrator.instanceCount).toBe(0);
  });
});

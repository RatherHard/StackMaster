/**
 * 调试变体生产路径与双实例重放一致性集成测试(阶段四 WP-42 完成标准;
 * ADR-DC1 条款 2/3、§六 R2;门控:SESSION_API_IT=1 才运行,缺省跳过——
 * 需要本机 vm-worker 二进制,跑前 `cargo build -p vm-worker`)。
 *
 * 与 WP-41 的 debug-channel.integration.test.ts 同范式,差别:
 *  - 变体供给走 **productionDebugVariantProvider 生产路径**(真实
 *    challenge-compiler 装载管线 + buildDebugVariantBundle,不再走占位
 *    Provider;固定测试种子注入保证两次会话装载**同一变体**);
 *  - **双实例重放一致性**:同一变体 JSON 两次喂给调试通道(两个会话、
 *    相同权威动作日志),断言两次 attach 后 debug_state 一致——revision /
 *    暂停 rip / 窗口字节 / 检索命中逐项相等(寄存器初始面由同构变体
 *    JSON 承载,产物逐字节相同 ⇒ 寄存器面一致);
 *  - 生产路径判别:占位 Provider 的合成隐藏区域(debug-vault 占位语料)
 *    在生产变体中不存在——全内存检索占位语料零命中。
 *
 * 测试语料全部占位(SEED/FLAG 惯例),真实种子 / flag 不进任何文件。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureWorkerBinary } from "@stackmaster/session-core";
import { DebugFrameSchema, type DebugFrame } from "@stackmaster/protocol";
import { productionDebugVariantProvider } from "../../src/debug/index.js";
import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_TENANT_ID,
  buildSessionTestRig,
  sessionCommand,
  sessionCredentialFromSetCookie,
  type RigWssClient,
} from "../routes/helpers/session-rig.js";

const IT_ENABLED = process.env.SESSION_API_IT === "1";
/** 固定测试调试种子(占位语料,16 字节;生产缺省 = 随机 16 字节)。 */
const FIXED_DEBUG_SEED_HEX = "2a4f6b8e0d1c3e5f708192a3b4c5d6e7";
/** 字节模式程序(push RBP; mov RBP,RSP; syscall exit(1);与 WP-41 集成测试同题)。 */
const BYTE_PROGRAM_HEX = "5589cd0100000000000000";
/** 代码区起点 16 字节窗口 = 程序 11 字节 + NOP0(0x90)填充 5 字节。 */
const CODE_WINDOW_16_HEX = `${BYTE_PROGRAM_HEX}9090909090`;

class DebugFrameCollector {
  readonly frames: DebugFrame[] = [];

  attach(client: RigWssClient): void {
    client.on("message", (data: Buffer) => {
      this.frames.push(DebugFrameSchema.parse(JSON.parse(data.toString("utf8"))));
    });
  }

  async waitFor(predicate: (frames: readonly DebugFrame[]) => boolean, timeoutMs = 15000): Promise<void> {
    await vi.waitFor(
      () => {
        if (!predicate(this.frames)) {
          throw new Error("等待调试出站帧条件超时");
        }
      },
      { timeout: timeoutMs, interval: 10 },
    );
  }
}

/** 建立会话并施加相同权威动作(重放对齐的同源输入);返回会话与凭证。 */
async function createSessionWithActions(rig: Awaited<ReturnType<typeof buildSessionTestRig>>): Promise<{
  sessionId: string;
  cookie: string;
}> {
  const issued = await rig.issueEmbedToken();
  const createResponse = await rig.app.inject({
    method: "POST",
    url: "/sessions",
    payload: sessionCommand("create_session", {
      challengeId: TEST_CHALLENGE_ID,
      challengeVersion: TEST_CHALLENGE_VERSION,
      embedSessionId: issued.claims.embedSessionId,
      embedToken: issued.token,
    }),
  });
  expect(createResponse.statusCode).toBe(201);
  const sessionId = (createResponse.json() as { payload: { sessionId: string } }).payload.sessionId;
  await rig.manager.applyAction(sessionId, TEST_TENANT_ID, {
    type: "write_bytes",
    args: { addressHex: "0x7ffff000", bytesHex: "41414141" },
  });
  await rig.manager.applyAction(sessionId, TEST_TENANT_ID, { type: "step", args: {} });
  await rig.manager.submit(sessionId, TEST_TENANT_ID);
  return { sessionId, cookie: sessionCredentialFromSetCookie(createResponse) };
}

describe.skipIf(!IT_ENABLED)("调试变体生产路径与双实例重放一致性(真实 vm-worker;SESSION_API_IT 门控)", () => {
  const CLEANUPS: (() => Promise<void>)[] = [];

  afterEach(async () => {
    const cleanups = CLEANUPS.splice(0, CLEANUPS.length);
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  async function buildProductionRig() {
    const workerCommand = { command: await ensureWorkerBinary() };
    const rig = await buildSessionTestRig({
      debug: {
        workerCommand,
        variantProviderFactory: (bundles) =>
          productionDebugVariantProvider({
            bundles,
            // 固定测试种子:两次会话装载同一变体(双实例重放一致性的前提)。
            generateDebugSeedHex: () => FIXED_DEBUG_SEED_HEX,
          }),
      },
    });
    CLEANUPS.push(async () => {
      await rig.debugOrchestrator.dispose();
      await rig.wssRegistry.closeAll();
      await rig.app.close();
    });
    await rig.registerByteChallenge({ byteProgramHex: BYTE_PROGRAM_HEX });
    return rig;
  }

  async function attachAtRevision(
    rig: Awaited<ReturnType<typeof buildSessionTestRig>>,
    cookie: string,
    sessionId: string,
    seq: number,
    revision: number,
  ): Promise<DebugFrameCollector> {
    const client = await rig.connectDebugChannel(cookie);
    const collector = new DebugFrameCollector();
    collector.attach(client);
    client.send(JSON.stringify({
      protocolVersion: 1,
      type: "debug_attach",
      sessionId,
      seq,
      requestId: `attach-${seq}`,
      payload: { origin: { kind: "revision", revision } },
    }));
    await collector.waitFor((frames) => frames.length >= 1);
    expect(collector.frames[0]?.type).toBe("debug_attached");
    return collector;
  }

  it("双实例重放一致性:同一变体两次 attach 后 debug_state 一致(revision/rip/窗口/检索)", async () => {
    const rig = await buildProductionRig();
    const sessionA = await createSessionWithActions(rig);
    const sessionB = await createSessionWithActions(rig);

    // 两会话权威动作日志同形(重放对齐的同源输入)。
    expect(await rig.actionLog.countBySession(sessionA.sessionId, TEST_TENANT_ID)).toBe(2);
    expect(await rig.actionLog.countBySession(sessionB.sessionId, TEST_TENANT_ID)).toBe(2);

    // 同一变体(同种子)两次装载,attach 至 revision 2。
    const collectorA = await attachAtRevision(rig, sessionA.cookie, sessionA.sessionId, 1, 2);
    const collectorB = await attachAtRevision(rig, sessionB.cookie, sessionB.sessionId, 1, 2);
    const attachedA = collectorA.frames[0];
    const attachedB = collectorB.frames[0];
    if (attachedA?.type !== "debug_attached" || attachedB?.type !== "debug_attached") {
      throw new Error("attach 回执缺失");
    }
    // revision 对齐一致(权威日志重放进度锚)。
    expect(attachedB.payload.revision).toBe(attachedA.payload.revision);
    expect(attachedA.payload.revision).toBe(2);
    expect(attachedB.payload.status).toBe(attachedA.payload.status);

    // 双实例并存(两个调试 worker 进程,非复用)。
    expect(rig.debugOrchestrator.instanceCount).toBe(2);

    // 单步落点(rip)一致:同连接续发 debug_step(seq 2),收集第 2 帧。
    const clientA = await rig.connectDebugChannel(sessionA.cookie);
    const stepsA = new DebugFrameCollector();
    stepsA.attach(clientA);
    const clientB = await rig.connectDebugChannel(sessionB.cookie);
    const stepsB = new DebugFrameCollector();
    stepsB.attach(clientB);
    clientA.send(JSON.stringify({
      protocolVersion: 1, type: "debug_step", sessionId: sessionA.sessionId, seq: 2,
      requestId: "step-a", payload: {},
    }));
    clientB.send(JSON.stringify({
      protocolVersion: 1, type: "debug_step", sessionId: sessionB.sessionId, seq: 2,
      requestId: "step-b", payload: {},
    }));
    await stepsA.waitFor((frames) => frames.length >= 1);
    await stepsB.waitFor((frames) => frames.length >= 1);
    expect(stepsA.frames[0]?.type).toBe("debug_paused");
    expect(stepsB.frames[0]?.type).toBe("debug_paused");
    if (stepsA.frames[0]?.type === "debug_paused" && stepsB.frames[0]?.type === "debug_paused") {
      expect(stepsB.frames[0].payload.reason).toBe(stepsA.frames[0].payload.reason);
      // rip 一致(重放后指令指针逐字节相同)。
      expect(stepsB.frames[0].payload.addressHex).toBe(stepsA.frames[0].payload.addressHex);
    }

    // 窗口字节一致:代码区(变体代码区字节 = 真实编译程序 + NOP0 填充)
    // + 栈区(重放写入)。
    for (const [addressHex, byteLength, expected] of [
      ["0x400000", 16, CODE_WINDOW_16_HEX],
      ["0x7ffff000", 4, "41414141"],
    ] as const) {
      const windowA = await rig.debugOrchestrator.window(sessionA.sessionId, TEST_TENANT_ID, addressHex, byteLength);
      const windowB = await rig.debugOrchestrator.window(sessionB.sessionId, TEST_TENANT_ID, addressHex, byteLength);
      expect(windowB.bytesHex).toBe(windowA.bytesHex);
      expect(windowA.bytesHex).toBe(expected);
      expect(windowB.truncated).toBe(windowA.truncated);
    }

    // 全内存检索一致 + 生产路径判别:占位语料(d3adb33f…)在真实编译变体中零命中。
    const searchA = await rig.debugOrchestrator.search(sessionA.sessionId, TEST_TENANT_ID, "41414141");
    const searchB = await rig.debugOrchestrator.search(sessionB.sessionId, TEST_TENANT_ID, "41414141");
    expect(searchB.hits).toEqual(searchA.hits);
    expect(searchA.hits.length).toBeGreaterThanOrEqual(1);
    const placeholderA = await rig.debugOrchestrator.search(sessionA.sessionId, TEST_TENANT_ID, "d3adb33fc0ffee01");
    const placeholderB = await rig.debugOrchestrator.search(sessionB.sessionId, TEST_TENANT_ID, "d3adb33fc0ffee01");
    expect(placeholderA.hits).toEqual([]);
    expect(placeholderB.hits).toEqual([]);

    // 调试交互不进权威日志(条款 4):两会话权威 revision 不受调试帧影响。
    expect(rig.manager.getSessionSummary(sessionA.sessionId, TEST_TENANT_ID)?.revision).toBe(2);
    expect(rig.manager.getSessionSummary(sessionB.sessionId, TEST_TENANT_ID)?.revision).toBe(2);
  });

  it("生产路径 IR 模式题目:变体产出面确定性拒绝(attach → internal_error 错误帧)", async () => {
    const rig = await buildProductionRig();
    // IR 模式题目(公开包无编码表;独立 challengeId 避免与字节题目版本冲突):
    // 装载管线放行,变体产出面 XC-DEBUG-MODE-IR 拒绝。
    const IR_CHALLENGE_ID = "chal-ir-mode";
    const IR_CHALLENGE_VERSION = "1.0.0";
    await rig.registerChallenge({ challengeId: IR_CHALLENGE_ID, challengeVersion: IR_CHALLENGE_VERSION });
    const issued = await rig.issueEmbedToken({
      claims: { challengeId: IR_CHALLENGE_ID, challengeVersion: IR_CHALLENGE_VERSION },
    });
    const createResponse = await rig.app.inject({
      method: "POST",
      url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: IR_CHALLENGE_ID,
        challengeVersion: IR_CHALLENGE_VERSION,
        embedSessionId: issued.claims.embedSessionId,
        embedToken: issued.token,
      }),
    });
    expect(createResponse.statusCode).toBe(201);
    const sessionId = (createResponse.json() as { payload: { sessionId: string } }).payload.sessionId;
    const cookie = sessionCredentialFromSetCookie(createResponse);

    const client = await rig.connectDebugChannel(cookie);
    const collector = new DebugFrameCollector();
    collector.attach(client);
    client.send(JSON.stringify({
      protocolVersion: 1,
      type: "debug_attach",
      sessionId,
      seq: 1,
      payload: { origin: { kind: "revision", revision: 0 } },
    }));
    await collector.waitFor((frames) => frames.length === 1);
    expect(collector.frames[0]?.type).toBe("error");
    if (collector.frames[0]?.type === "error") {
      expect(collector.frames[0].payload.code).toBe("internal_error");
    }
    // 装载失败的实例不留下半开进程。
    await vi.waitFor(() => {
      if (rig.debugOrchestrator.instanceCount !== 0) {
        throw new Error("等待失败实例收割");
      }
    }, { timeout: 5000, interval: 10 });
  });
});

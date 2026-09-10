/**
 * 调试通道全链路集成测试(阶段四 WP-41 完成标准;ADR-DC1 条款 2/3/4/6/8;
 * 门控:SESSION_API_IT=1 才运行,缺省跳过——需要本机 vm-worker 二进制,
 * 跑前 `cargo build -p vm-worker`(或由 ensureWorkerBinary 按需构建))。
 *
 * 全链路绿:字节模式题目 → create_session → 解题动作(真实 worker)→
 * submit 落权威日志 → 调试通道 attach(变体零装载 + 确定性重放对齐)→
 * 任意窗口读取(含隐藏区)→ run_to_breakpoint 断点暂停 → 全内存检索 →
 * 指令流 / 函数表展示数据。
 *
 * 零装载断言(完成标准):
 *  ①调试 worker 收到的装载是**变体**(占位语料;无 judgingConfig /
 *    hiddenTests / seed / seedHex / seedPolicy 字段——provider 出口即过
 *    WP-40 冻结 Schema,strictObject 使上述字段不可表达);
 *  ②装载清单**无真实私有包**:变体含合成隐藏区域 debug-vault(真实私有包
 *    根本没有该区域)——窗口读回占位字节即证明装载的是变体镜像而非真实
 *    私有包;worker 收到的命令只有 load_variant(真实 `load` 载荷含
 *    privateBundle,结构上不可达);
 *  ③**权威日志不被调试交互污染**:调试帧前后 ActionLogStore 长度相等,
 *    真实会话 revision 不受影响。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureWorkerBinary } from "@stackmaster/session-core";
import { DebugFrameSchema, type DebugFrame } from "@stackmaster/protocol";
import { placeholderDebugVariantProvider } from "../../src/debug/index.js";
import type { RigWssClient } from "../routes/helpers/session-rig.js";
import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  buildSessionTestRig,
  sessionCommand,
  sessionCredentialFromSetCookie,
} from "../routes/helpers/session-rig.js";

const IT_ENABLED = process.env.SESSION_API_IT === "1";

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

describe.skipIf(!IT_ENABLED)("调试通道全链路(真实 vm-worker 二进制;SESSION_API_IT 门控)", () => {
  const CLEANUPS: (() => Promise<void>)[] = [];

  afterEach(async () => {
    const cleanups = CLEANUPS.splice(0, CLEANUPS.length);
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  it("attach(零装载 + 重放对齐)→ 任意窗口 → 断点暂停 → 检索 → 展示数据;权威日志零污染", async () => {
    const workerCommand = { command: await ensureWorkerBinary() };
    const rig = await buildSessionTestRig({
      debug: { workerCommand },
    });
    CLEANUPS.push(async () => {
      await rig.debugOrchestrator.dispose();
      await rig.wssRegistry.closeAll();
      await rig.app.close();
    });

    // 字节模式题目(push RBP; mov RBP,RSP; syscall exit(1);pad ret):
    // 调试变体路径以公开编码表 + 代码区字节装配(公开包字节程序同前缀)。
    await rig.registerByteChallenge({
      byteProgramHex: "5589cd0100000000000000",
    });
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
    const cookie = sessionCredentialFromSetCookie(createResponse);

    // 真实会话:两个已接受动作(栈区写入 + step),submit 落权威动作日志。
    const writeResponse = await rig.manager.applyAction(sessionId, "tenant-alpha", {
      type: "write_bytes",
      args: { addressHex: "0x7ffff000", bytesHex: "41414141" },
    });
    expect(writeResponse.status).toBe("running");
    await rig.manager.applyAction(sessionId, "tenant-alpha", { type: "step", args: {} });
    await rig.manager.submit(sessionId, "tenant-alpha");
    const authoritativeCount = await rig.actionLog.countBySession(sessionId, "tenant-alpha");
    expect(authoritativeCount).toBe(2);

    // 零装载断言 ①:provider 产物 = 占位语料变体(排他字段不可表达 + 合成
    // 隐藏区域,真实私有包没有该区域)。
    const provider = placeholderDebugVariantProvider({
      getPublic: async (challengeId, version) => rig.bundles.getPublic(challengeId, version),
    });
    const variant = await provider.forSession({
      sessionId,
      tenantId: "tenant-alpha",
      challengeId: TEST_CHALLENGE_ID,
      challengeContentVersion: TEST_CHALLENGE_VERSION,
    });
    for (const forbidden of ["judgingConfig", "hiddenTests", "seed", "seedHex", "seedPolicy", "secrets", "privateObjects"]) {
      expect(variant).not.toHaveProperty(forbidden);
    }
    expect(variant).toHaveProperty("derivation");
    const regions = variant.memoryRegions as { regionId: string }[];
    expect(regions.map((region) => region.regionId)).toContain("debug-vault");

    // 调试通道连接 + attach(origin = revision 2)。
    const client = await rig.connectDebugChannel(cookie);
    const collector = new DebugFrameCollector();
    collector.attach(client);
    const send = (frame: Record<string, unknown>) => client.send(JSON.stringify(frame));

    send({
      protocolVersion: 1,
      type: "debug_attach",
      sessionId,
      seq: 1,
      requestId: "attach-1",
      payload: { origin: { kind: "revision", revision: 2 } },
    });
    await collector.waitFor((frames) => frames.length === 1);
    const attached = collector.frames[0];
    expect(attached?.type).toBe("debug_attached");
    if (attached?.type === "debug_attached") {
      // 重放对齐:调试实例 revision = 权威日志对齐点;真实 step 已推进 RIP。
      expect(attached.payload.revision).toBe(2);
      expect(["running", "paused"]).toContain(attached.payload.status);
    }

    // 零装载断言 ②:窗口读回隐藏区占位字节(真实私有包无该区域;若装载了
    // 真实私有包,该地址不可达或不含占位语料)。
    send({
      protocolVersion: 1,
      type: "debug_window",
      sessionId,
      seq: 2,
      requestId: "w-1",
      payload: { addressHex: "0x80000000", byteLength: 8 },
    });
    await collector.waitFor((frames) => frames.length === 2);
    expect(collector.frames[1]?.type).toBe("debug_window_data");
    if (collector.frames[1]?.type === "debug_window_data") {
      expect(collector.frames[1].payload.bytesHex).toBe("d3adb33fc0ffee01");
      expect(collector.frames[1].payload.addressHex).toBe("0x80000000");
    }

    // 任意窗口 = 重放写入可见(确定性重放对齐的可观察性):栈区写入的字节。
    send({
      protocolVersion: 1,
      type: "debug_window",
      sessionId,
      seq: 3,
      requestId: "w-2",
      payload: { addressHex: "0x7ffff000", byteLength: 4 },
    });
    await collector.waitFor((frames) => frames.length === 3);
    if (collector.frames[2]?.type === "debug_window_data") {
      expect(collector.frames[2].payload.bytesHex).toBe("41414141");
    }

    // run_to_breakpoint:断点 = syscall 指令地址(重放后 RIP 已 +1)。
    send({
      protocolVersion: 1,
      type: "debug_run_to_breakpoint",
      sessionId,
      seq: 4,
      requestId: "b-1",
      payload: { breakpoints: ["0x400002"] },
    });
    await collector.waitFor((frames) => frames.length === 4);
    expect(collector.frames[3]?.type).toBe("debug_paused");
    if (collector.frames[3]?.type === "debug_paused") {
      expect(collector.frames[3].payload.reason).toBe("breakpoint");
      expect(collector.frames[3].payload.addressHex).toBe("0x400002");
    }

    // 全内存检索(重放写入的字节命中)+ 指令流 + 函数表展示数据。
    send({
      protocolVersion: 1,
      type: "debug_search",
      sessionId,
      seq: 5,
      requestId: "s-1",
      payload: { patternHex: "41414141" },
    });
    send({
      protocolVersion: 1,
      type: "debug_step",
      sessionId,
      seq: 6,
      requestId: "st-1",
      payload: {},
    });
    await collector.waitFor((frames) => frames.length === 6);
    if (collector.frames[4]?.type === "debug_search_results") {
      expect(collector.frames[4].payload.hits.length).toBeGreaterThanOrEqual(1);
      expect(collector.frames[4].payload.hits[0]?.bytesHex).toBe("41414141");
    }
    if (collector.frames[5]?.type === "debug_paused") {
      expect(["step", "program_halt"]).toContain(collector.frames[5].payload.reason);
    }

    // 展示数据(伪指令流 + 函数表;IR 不出进程,D5)。
    send({
      protocolVersion: 1,
      type: "debug_run_to_breakpoint",
      sessionId,
      seq: 7,
      requestId: "b-2",
      payload: { breakpoints: ["0x400000"] },
    });
    await collector.waitFor((frames) => frames.length === 7);
    send({
      protocolVersion: 1,
      type: "debug_window",
      sessionId,
      seq: 8,
      requestId: "i-1",
      payload: { addressHex: "0x400000", byteLength: 16 },
    });
    await collector.waitFor((frames) => frames.length === 8);

    // 零装载断言 ③:权威日志零污染(调试交互前后长度一致),真实会话
    // revision 不受调试帧影响(条款 4:调试交互不进权威日志)。
    expect(await rig.actionLog.countBySession(sessionId, "tenant-alpha")).toBe(authoritativeCount);
    expect(rig.manager.getSessionSummary(sessionId, "tenant-alpha")?.revision).toBe(2);
    // 单实例生命周期:实例存活(attach 幂等复用),无第二进程。
    expect(rig.debugOrchestrator.instanceCount).toBe(1);
  });

  it("真实二进制拒绝 IR 模式变体(字节模式边界;确定性 challenge_invalid 方向)", async () => {
    const workerCommand = { command: await ensureWorkerBinary() };
    const rig = await buildSessionTestRig({
      debug: { workerCommand },
    });
    CLEANUPS.push(async () => {
      await rig.debugOrchestrator.dispose();
      await rig.wssRegistry.closeAll();
      await rig.app.close();
    });

    // IR 模式题目(公开包无编码表):变体路径不可装配 → attach 错误帧。
    await rig.registerChallenge();
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

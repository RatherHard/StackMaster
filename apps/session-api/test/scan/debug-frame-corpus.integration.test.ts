/**
 * ZR-B12 调试通道帧语料包含性机检——集成层(阶段四 WP-44;ADR-DC1 §四前置
 * 项 5;映射文档 §三 ZR-B12 / ZR-B13 行)。
 *
 * 门控:SESSION_API_IT=1 才运行,缺省跳过——需要本机 vm-worker 二进制,跑前
 * `cargo build -p vm-worker`(或由 ensureWorkerBinary 按需构建)。
 *
 * **生产变体 + 真实 worker**:与 WP-42 debug-variant-replay.integration.test.ts
 * 同范式——变体供给走 productionDebugVariantProvider 生产路径(真实
 * challenge-compiler 装载管线 + buildDebugVariantBundle;固定测试种子注入),
 * 变体由包装 Provider **捕获编排器实际装载的那一份**(包含性语料全集 =
 * 变体自身 memoryRegions contentHex,WP-42 定案;不拿真实镜像当全集)。
 *
 * 断言面:
 *  - **ZR-B12 零命中**:录制 attach → window → step → search →
 *    instruction_stream → function_table 全程出站帧,逐帧对变体语料做包含性
 *    断言零命中(玩家输入回显语料 = 权威动作日志 write_bytes 的 bytesHex,
 *    §6.8 封闭集第三源);
 *  - **ZR-B13 零命中**:以实际注入的调试种子复算捕获变体的派生面(本
 *    fixture 无隐藏区域 / canary ⇒ draws = 0 的平凡一致性 + 声明面复核;
 *    派生槽上的非平凡复算与错误种子红灯在单测层覆盖,
 *    `test/scan/debug-variant-derivation-checker.test.ts`);
 *  - **红灯注入(与零命中同文件同套件,证明机检有效)**:①注入帧字节 =
 *    SECRET_FLAG_PLACEHOLDER / SEED_HEX_FIXTURE 占位秘密语料 → 必命中;
 *    ②注入帧字节 = 变体外合成随机字节 → 必命中;③越界地址帧 → 必命中;
 *    ④展示文本走私超长十六进制串 → 必命中。
 *
 * 展示帧(伪指令流 / 函数表)录制说明:协议 v1 的 C→S 帧族尚无拉取请求帧
 * (WP-40 §三.1 五帧封闭),WSS 客户端触发面未接线——两帧以编排器回执构造
 * **同等 wire 形态**(worker 展示数据原样转发,零本地推导)进机检;帧形态
 * 合法性由冻结 DebugFrameSchema 现场解析自证。
 *
 * 执行面边界(上游 v1.13 论证第(6)点):引擎执行派生的运行时字节(step 的
 * push 写栈)是变体镜像 × 玩家输入 × 确定性引擎的派生物,不在子串语料内,
 * 其公开性由 ADR-DC1 条款 3 确定性重放 + ZR-B13 承接;本脚本窗口全部取
 * 对齐面(代码区 / 隐藏区初像 / 玩家写入点 / 未触栈区),不读取执行突变槽。
 *
 * 测试语料全部占位(SECRET_FLAG_PLACEHOLDER / SEED_HEX_FIXTURE / 合成随机
 * 字节惯例),真实种子 / flag 不进任何文件。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureWorkerBinary } from "@stackmaster/session-core";
import { DebugFrameSchema, type DebugFrame } from "@stackmaster/protocol";
import { productionDebugVariantProvider } from "../../src/debug/index.js";
import {
  formatZrB12Violations,
  scanDebugFrameCorpus,
  scanDebugFrameCorpora,
  type DebugFrameScanView,
  type DebugVariantRegionView,
} from "../../src/scan/debug-frame-corpus-scanner.js";
import { checkDebugVariantDerivation } from "../../src/scan/debug-variant-derivation-checker.js";
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
/** 固定测试调试种子(占位语料,16 字节;与 WP-42 集成测试同值同惯例)。 */
const FIXED_DEBUG_SEED_HEX = "2a4f6b8e0d1c3e5f708192a3b4c5d6e7";
/** 字节模式程序(push RBP; mov RBP,RSP; syscall exit(1);与 WP-41/42 同题)。 */
const BYTE_PROGRAM_HEX = "5589cd0100000000000000";
/** 代码区起点 16 字节窗口 = 程序 11 字节 + NOP0(0x90)填充 5 字节。 */
const CODE_WINDOW_16_HEX = `${BYTE_PROGRAM_HEX}9090909090`;
/** 玩家输入语料(权威动作日志 write_bytes 的 bytesHex;测试自构自证)。 */
const PLAYER_INPUT_HEX = ["41414141"];

/** 红灯注入语料(仓库占位惯例常量 + 合成随机字节;非真实秘密)。 */
const SECRET_FLAG_PLACEHOLDER = "FLAG{placeholder_do_not_ship}";
const SEED_HEX_FIXTURE = "00112233445566778899aabbccddeeff";
const FOREIGN_BYTES_HEX = "7f3a9c5e1d8b04f26b92c40758e3a619";

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

describe.skipIf(!IT_ENABLED)("ZR-B12 调试通道帧语料包含性(生产变体 + 真实 vm-worker;SESSION_API_IT 门控)", () => {
  const CLEANUPS: (() => Promise<void>)[] = [];

  afterEach(async () => {
    const cleanups = CLEANUPS.splice(0, CLEANUPS.length);
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  /**
   * 生产装配台:包装 productionDebugVariantProvider,捕获编排器实际装载的
   * 变体(sessionId → variant JSON);固定种子使捕获面确定、可复算。
   */
  async function buildProductionRig(): Promise<{
    rig: Awaited<ReturnType<typeof buildSessionTestRig>>;
    capturedVariants: Map<string, Record<string, unknown>>;
  }> {
    const workerCommand = { command: await ensureWorkerBinary() };
    const capturedVariants = new Map<string, Record<string, unknown>>();
    const rig = await buildSessionTestRig({
      debug: {
        workerCommand,
        variantProviderFactory: (bundles) => {
          const inner = productionDebugVariantProvider({
            bundles,
            // 固定测试种子:捕获变体与复算输入同源(种子值仍不落盘)。
            generateDebugSeedHex: () => FIXED_DEBUG_SEED_HEX,
          });
          return {
            forSession: async (request) => {
              const variant = await inner.forSession(request);
              capturedVariants.set(request.sessionId, variant);
              return variant;
            },
          };
        },
      },
    });
    CLEANUPS.push(async () => {
      await rig.debugOrchestrator.dispose();
      await rig.wssRegistry.closeAll();
      await rig.app.close();
    });
    await rig.registerByteChallenge({ byteProgramHex: BYTE_PROGRAM_HEX });
    return { rig, capturedVariants };
  }

  async function createSessionWithActions(
    rig: Awaited<ReturnType<typeof buildSessionTestRig>>,
  ): Promise<{ sessionId: string; cookie: string }> {
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
    // 玩家输入(权威动作日志;同时构成 ZR-B12 的玩家输入回显语料)。
    await rig.manager.applyAction(sessionId, TEST_TENANT_ID, {
      type: "write_bytes",
      args: { addressHex: "0x7ffff000", bytesHex: "41414141" },
    });
    await rig.manager.applyAction(sessionId, TEST_TENANT_ID, { type: "step", args: {} });
    await rig.manager.submit(sessionId, TEST_TENANT_ID);
    return { sessionId, cookie: sessionCredentialFromSetCookie(createResponse) };
  }

  /** 捕获变体 → 扫描器输入面(语料全集 = 变体自身 memoryRegions)。 */
  function variantRegionsOf(variant: Record<string, unknown>): DebugVariantRegionView[] {
    return (variant["memoryRegions"] as {
      regionId: string;
      startAddressHex: string;
      byteLength: number;
      contentHex: string;
    }[]).map((region) => ({
      regionId: region.regionId,
      startAddressHex: region.startAddressHex,
      byteLength: region.byteLength,
      contentHex: region.contentHex,
    }));
  }

  it("attach→window→step→search→instruction_stream→function_table 全程出站帧:ZR-B12 零命中 + ZR-B13 复算零命中", async () => {
    const { rig, capturedVariants } = await buildProductionRig();
    const { sessionId, cookie } = await createSessionWithActions(rig);

    // 调试通道连接 + 全程出站帧录制。
    const client = await rig.connectDebugChannel(cookie);
    const collector = new DebugFrameCollector();
    collector.attach(client);
    const send = (frameValue: Record<string, unknown>) => client.send(JSON.stringify(frameValue));

    // ① attach(origin = revision 2;变体零装载 + 确定性重放对齐)。
    send({
      protocolVersion: 1,
      type: "debug_attach",
      sessionId,
      seq: 1,
      requestId: "attach-1",
      payload: { origin: { kind: "revision", revision: 2 } },
    });
    await collector.waitFor((frames) => frames.length >= 1);
    expect(collector.frames[0]?.type).toBe("debug_attached");

    // ② 任意窗口:代码区初像(变体语料包含面)。
    send({
      protocolVersion: 1,
      type: "debug_window",
      sessionId,
      seq: 2,
      requestId: "w-code",
      payload: { addressHex: "0x400000", byteLength: 16 },
    });
    await collector.waitFor((frames) => frames.length >= 2);
    if (collector.frames[1]?.type === "debug_window_data") {
      expect(collector.frames[1].payload.bytesHex).toBe(CODE_WINDOW_16_HEX);
    }

    // ③ 任意窗口:玩家写入点(重放对齐可观察性;玩家输入回显语料)。
    send({
      protocolVersion: 1,
      type: "debug_window",
      sessionId,
      seq: 3,
      requestId: "w-stack",
      payload: { addressHex: "0x7ffff000", byteLength: 4 },
    });
    await collector.waitFor((frames) => frames.length >= 3);
    if (collector.frames[2]?.type === "debug_window_data") {
      expect(collector.frames[2].payload.bytesHex).toBe("41414141");
    }

    // ④ 任意窗口:未触栈区(变体初像零填充;对齐窗口,不读执行突变槽)。
    send({
      protocolVersion: 1,
      type: "debug_window",
      sessionId,
      seq: 4,
      requestId: "w-zero",
      payload: { addressHex: "0x7ffff100", byteLength: 8 },
    });
    await collector.waitFor((frames) => frames.length >= 4);

    // ⑤ 全内存检索(命中玩家写入字节)。
    send({
      protocolVersion: 1,
      type: "debug_search",
      sessionId,
      seq: 5,
      requestId: "s-1",
      payload: { patternHex: "41414141" },
    });
    await collector.waitFor((frames) => frames.length >= 5);
    if (collector.frames[4]?.type === "debug_search_results") {
      expect(collector.frames[4].payload.hits.length).toBeGreaterThanOrEqual(1);
    }

    // ⑥ 单步暂停(paused 帧 = reason + addressHex,无内存字节载荷)。
    send({
      protocolVersion: 1,
      type: "debug_step",
      sessionId,
      seq: 6,
      requestId: "st-1",
      payload: {},
    });
    await collector.waitFor((frames) => frames.length >= 6);
    expect(collector.frames[5]?.type).toBe("debug_paused");

    // ⑦⑧ 展示帧:协议 v1 无 C→S 拉取帧(WP-41 现状),以编排器回执构造
    // 同等 wire 形态进机检(worker 展示数据原样转发,零本地推导)。
    // 归一化说明:worker 对展示条目的缺席可选项序列化为 null(bytesHex /
    // jumpTargetHex),冻结 Schema 为 optional(缺席而非 null)——此处仅做
    // null → 缺席的线形归一化,零内容推导(worker 侧线形与契约的出入已
    // 单列报告,归 WSS 触发面接线时的规整点)。
    const stripNullOptionals = (entry: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== null));
    const streamReceipt = await rig.debugOrchestrator.instructionStream(
      sessionId,
      TEST_TENANT_ID,
      "0x400000",
      8,
    );
    const streamFrame = DebugFrameSchema.parse({
      protocolVersion: 1,
      type: "debug_instruction_stream",
      sessionId,
      seq: 999,
      payload: {
        instructions: streamReceipt.instructions.map(stripNullOptionals),
        ...(streamReceipt.truncated ? { truncated: true } : {}),
      },
    });
    expect(streamReceipt.instructions.length).toBeGreaterThanOrEqual(1);
    const tableReceipt = await rig.debugOrchestrator.functionTable(sessionId, TEST_TENANT_ID);
    const tableFrame = DebugFrameSchema.parse({
      protocolVersion: 1,
      type: "debug_function_table",
      sessionId,
      seq: 1000,
      payload: {
        functions: tableReceipt.functions.map(stripNullOptionals),
        ...(tableReceipt.truncated ? { truncated: true } : {}),
      },
    });

    // ── ZR-B12:全程录制集逐帧包含性断言,零命中 ──
    const variant = capturedVariants.get(sessionId);
    if (variant === undefined) {
      throw new Error("生产变体未被捕获(provider 未被调用)");
    }
    const regions = variantRegionsOf(variant);
    const scanInputOf = (frameValue: DebugFrameScanView) => ({
      frame: frameValue,
      variantRegions: regions,
      playerInputBytesHex: PLAYER_INPUT_HEX,
    });
    const hits = scanDebugFrameCorpora([
      ...collector.frames.map(scanInputOf),
      scanInputOf(streamFrame),
      scanInputOf(tableFrame),
    ]);
    expect(formatZrB12Violations(hits)).toEqual([]);

    // ── ZR-B13:以实际注入种子复算捕获变体,零命中(本 fixture 无派生槽,
    // draws = 0 的声明面一致性;派生槽非平凡复算与错误种子红灯在单测层)──
    expect(checkDebugVariantDerivation({
      variant: variant as Parameters<typeof checkDebugVariantDerivation>[0]["variant"],
      debugSeedHex: FIXED_DEBUG_SEED_HEX,
      archBits: 64,
      pageSizeBytes: 4096,
    })).toEqual([]);

    // 权威日志零污染(条款 4;与 WP-41 同款锚点)。
    expect(rig.manager.getSessionSummary(sessionId, TEST_TENANT_ID)?.revision).toBe(2);
  });

  it("红灯注入(与零命中同套件):占位秘密语料 / 变体外随机字节 / 越界地址帧 / 文本走私 → 必命中", async () => {
    const { rig, capturedVariants } = await buildProductionRig();
    const { sessionId, cookie } = await createSessionWithActions(rig);

    const client = await rig.connectDebugChannel(cookie);
    const collector = new DebugFrameCollector();
    collector.attach(client);
    client.send(JSON.stringify({
      protocolVersion: 1,
      type: "debug_attach",
      sessionId,
      seq: 1,
      payload: { origin: { kind: "revision", revision: 2 } },
    }));
    await collector.waitFor((frames) => frames.length >= 1);

    const variant = capturedVariants.get(sessionId);
    if (variant === undefined) {
      throw new Error("生产变体未被捕获(provider 未被调用)");
    }
    const regions = variantRegionsOf(variant);
    const scanInjected = (frameValue: DebugFrame) =>
      scanDebugFrameCorpus({
        frame: frameValue,
        variantRegions: regions,
        playerInputBytesHex: PLAYER_INPUT_HEX,
      });

    // 红灯 ①:窗口字节 = SECRET_FLAG_PLACEHOLDER / SEED_HEX_FIXTURE 占位秘密
    // 语料(不在变体语料、不在玩家输入)→ 必命中。
    const flagInjection = DebugFrameSchema.parse({
      protocolVersion: 1,
      type: "debug_window_data",
      sessionId,
      seq: 2,
      payload: {
        addressHex: "0x400000",
        bytesHex: Buffer.from(SECRET_FLAG_PLACEHOLDER, "utf8").toString("hex"),
      },
    });
    expect(scanInjected(flagInjection).map((hit) => hit.id)).toEqual([
      "ZR-B12-bytes-not-in-variant-corpus",
    ]);
    const seedInjection = DebugFrameSchema.parse({
      protocolVersion: 1,
      type: "debug_window_data",
      sessionId,
      seq: 3,
      payload: { addressHex: "0x7ffff000", bytesHex: SEED_HEX_FIXTURE },
    });
    expect(scanInjected(seedInjection).map((hit) => hit.id)).toEqual([
      "ZR-B12-bytes-not-in-variant-corpus",
    ]);

    // 红灯 ②:窗口字节 = 变体中不存在的合成随机字节 → 必命中。
    const foreignInjection = DebugFrameSchema.parse({
      protocolVersion: 1,
      type: "debug_window_data",
      sessionId,
      seq: 4,
      payload: { addressHex: "0x400000", bytesHex: FOREIGN_BYTES_HEX },
    });
    expect(scanInjected(foreignInjection).map((hit) => hit.id)).toEqual([
      "ZR-B12-bytes-not-in-variant-corpus",
    ]);

    // 红灯 ③:窗口地址不落在生产变体任何映射区域 → 必命中。
    const unmappedInjection = DebugFrameSchema.parse({
      protocolVersion: 1,
      type: "debug_window_data",
      sessionId,
      seq: 5,
      payload: { addressHex: "0x999999000", bytesHex: "00000000" },
    });
    expect(scanInjected(unmappedInjection).map((hit) => hit.id)).toEqual([
      "ZR-B12-address-outside-variant",
    ]);

    // 红灯 ④:展示文本走私语料外超长十六进制串(> u64 数值渲染上限)→ 必命中。
    const smuggledTextInjection = DebugFrameSchema.parse({
      protocolVersion: 1,
      type: "debug_instruction_stream",
      sessionId,
      seq: 6,
      payload: {
        instructions: [
          {
            addressHex: "0x400000",
            bytesHex: "55",
            text: `xref 9f8e7d6c5b4a39281705f3e2d1c0b8a79`,
          },
        ],
      },
    });
    expect(scanInjected(smuggledTextInjection).map((hit) => hit.id)).toEqual([
      "ZR-B12-text-smuggled-bytes",
    ]);
  });
});

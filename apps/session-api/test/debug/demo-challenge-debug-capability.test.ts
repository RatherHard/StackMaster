/**
 * 演示 / E2E 拓扑登记题目的**调试变体可产出性**回归锚(中期 WP-76 缺陷 2
 * 的机器拦截面;缺陷原文 = `DebugVariantBuildError` / `XC-DEBUG-MODE-IR`)。
 *
 * # 为什么既有测试全绿却漏掉了它(漏网根因)
 *
 * 既有调试通道测试分两类,恰好各自绕开了本次缺陷:
 *  - `debug-channel.test.ts` / `debug-channel.integration.test.ts` 走 rig 的
 *    **占位变体供给**(`placeholderDebugVariantProvider`)或 rig 自建的字节题
 *    ⇒ 变体永远能产出、`debug_attach` 永远成功;
 *  - `debug-variant-provider.test.ts` 走**生产 Provider**,但题目来自
 *    challenge-compiler **测试语料**(字节模式配对),并把 IR 拒绝当作**期望**
 *    行为断言。
 * 两类都没覆盖「**演示 / E2E 拓扑真实登记的那道题的形态**」⇒ 生产装配路径
 * (`src/runtime/runtime.ts:398` 的 `productionDebugVariantProvider`)拿到的
 * 题目是 IR 模式,`buildDebugVariantBundle` 确定性拒绝、`debug_attach` 在
 * 真机恒失败,而全部 Node 测试全绿。
 *
 * # 本文件锚定什么
 *
 *  - 用例 1~2:演示题经**生产变体供给路径**(双包 → challenge-compiler 装载
 *    管线 → `buildDebugVariantBundle` → 冻结 `DebugVariantBundleSchema` 出口
 *    复验)必须产出变体,且调试实例初始指令指针落在**可执行区域**;
 *  - 用例 3:反例锚(IR 模式不可表达);
 *  - 用例 4:**防漂移机检** —— 生产落地面 `k6/seed-challenge.mjs` 的形态。
 *
 * # 防漂移机检的必要性与形态(为什么是源码面检查)
 *
 * 演示题的**生产落地面**是 `k6/seed-challenge.mjs`(E2E `seedChallenge` 与
 * 手工演示拓扑唯一驱动它)。该 .mjs **不可被测试 import**:顶层即连
 * PostgreSQL / MinIO,且缺 `SESSION_API_POSTGRES_URL` 时直接 `process.exit(1)`
 * (会杀死测试进程);而 TS 侧 `allowJs` 关闭,静态 import `.mjs` 亦不过
 * typecheck。故用例 4 退让为**有界源码面机检**(与仓库既有
 * `test/scan/**`、`assertMetricsTextDiscipline` 同类):断言生产种子**不得**
 * 回到 IR 形态、且入口 / 编码表 / 初始 RIP 三项齐备。它拦住的是**同一个
 * 缺陷的复发**(把演示题改回 IR ⇒ 用例 4 红)。
 *
 * ⚠ 已知退让(待定案):理想形态是「演示题内容单一来源 = 一处定义、seed 与
 * 测试共同消费」。做到它需要新增生产源码模块(seed 经 dist 消费),主控已
 * 裁决「不引入无生产消费者的 src 模块」⇒ 当前为「夹具(test/)+ 生产种子
 * 内联」双份结构,由用例 4 的源码面机检兜住漂移。若后续决定收敛为单一来源,
 * 用例 4 可退场。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";
import { RULE_ID_DEBUG_IR_MODE } from "@stackmaster/challenge-compiler";
import { DebugFrameSchema } from "@stackmaster/protocol";
import { DebugVariantBundleSchema } from "@stackmaster/protocol/server-only";
import { ensureWorkerBinary } from "@stackmaster/session-core";

import { MemoryChallengeBundleStore, sha256Hex } from "../../src/persistence/index.js";
import { productionDebugVariantProvider } from "../../src/debug/debug-variant-provider.js";
import {
  TEST_TENANT_ID,
  buildSessionTestRig,
  sessionCommand,
  sessionCredentialFromSetCookie,
  type SessionTestRig,
} from "../routes/helpers/session-rig.js";
import {
  LIFECYCLE_CHALLENGE_CODE_BASE,
  LIFECYCLE_CHALLENGE_CONTENT_VERSION,
  buildLifecycleChallengePair,
} from "./helpers/lifecycle-challenge.js";

/** 演示题 ID(E2E 每用例覆写为唯一值;此处固定即可)。 */
const DEMO_CHALLENGE_ID = "chal-demo-debug-capability";

/** 固定调试种子(占位;生产缺省 = attach 现场随机 16 字节)。 */
const FIXED_DEBUG_SEED_HEX = "2a4f6b8e0d1c3e5f708192a3b4c5d6e7";

/** 生产落地面(演示 / E2E 拓扑登记用的种子脚本)。 */
const SEED_SCRIPT_PATH = new URL("../../k6/seed-challenge.mjs", import.meta.url);

/** 生产装配路径的供给入口(与 runtime.ts 接线同款:双包存储 + 真 Provider)。 */
function providerFor(bundles: MemoryChallengeBundleStore) {
  return productionDebugVariantProvider({
    bundles,
    generateDebugSeedHex: () => FIXED_DEBUG_SEED_HEX,
  });
}

/** 把演示题双包登记进内存双包存储(与登记路径同字节面)。 */
async function registerDemoChallenge(bundles: MemoryChallengeBundleStore): Promise<void> {
  const pair = buildLifecycleChallengePair(DEMO_CHALLENGE_ID);
  await bundles.putPrivate(
    DEMO_CHALLENGE_ID,
    LIFECYCLE_CHALLENGE_CONTENT_VERSION,
    Buffer.from(JSON.stringify(pair.privateBundle), "utf8"),
  );
  await bundles.putPublic(
    DEMO_CHALLENGE_ID,
    LIFECYCLE_CHALLENGE_CONTENT_VERSION,
    Buffer.from(JSON.stringify(pair.publicDescriptor), "utf8"),
  );
}

/** 取变体(修前此调用抛 DebugVariantBuildError / XC-DEBUG-MODE-IR)。 */
async function buildDemoVariant(bundles: MemoryChallengeBundleStore) {
  return providerFor(bundles).forSession({
    sessionId: "sess-demo-debug",
    tenantId: "tenant-demo",
    challengeId: DEMO_CHALLENGE_ID,
    challengeContentVersion: LIFECYCLE_CHALLENGE_CONTENT_VERSION,
  });
}

/** 读双包(JSON 面;登记与读取同字节面)。 */
async function readPair(bundles: MemoryChallengeBundleStore) {
  const privateBundle = JSON.parse(
    Buffer.from(
      (await bundles.getPrivate(DEMO_CHALLENGE_ID, LIFECYCLE_CHALLENGE_CONTENT_VERSION))!,
    ).toString("utf8"),
  ) as { compiledIr?: unknown; entrypointAddressHex?: string };
  const publicDescriptor = JSON.parse(
    Buffer.from(
      (await bundles.getPublic(DEMO_CHALLENGE_ID, LIFECYCLE_CHALLENGE_CONTENT_VERSION))!,
    ).toString("utf8"),
  ) as { vmProfile: { encodingTable?: unknown[] } };
  return { privateBundle, publicDescriptor };
}

describe("演示 / E2E 拓扑题目的调试变体可产出性(生产装配路径)", () => {
  it("演示题经生产变体供给路径产出调试变体(IR 模式题目在此确定性拒绝)", async () => {
    const bundles = new MemoryChallengeBundleStore();
    await registerDemoChallenge(bundles);

    // 修前:DebugVariantBuildError / XC-DEBUG-MODE-IR(演示题曾为 IR 模式)。
    const variant = await buildDemoVariant(bundles);

    // 出口即过冻结契约(与编排器 #loadVariant 同一复验面)。
    const parsed = DebugVariantBundleSchema.parse(variant);
    expect(parsed.challengeId).toBe(DEMO_CHALLENGE_ID);
    expect(parsed.memoryRegions.length).toBeGreaterThan(0);
  });

  it("调试实例的初始指令指针落在可执行区域(指令流出数的必要条件)", async () => {
    const bundles = new MemoryChallengeBundleStore();
    await registerDemoChallenge(bundles);
    const { privateBundle, publicDescriptor } = await readPair(bundles);
    const variant = DebugVariantBundleSchema.parse(await buildDemoVariant(bundles));

    // 程序形态 = 字节模式(XS-PROG-MODE 判据 = 公开包 encodingTable 在场)。
    expect(publicDescriptor.vmProfile.encodingTable?.length).toBeGreaterThan(0);

    // 变体初始 RIP(调试 worker variant.rs:入口 = 初始 RIP)必须落在可执行
    // 区域内 —— 否则暂停落点无指令覆盖,指令视图恒空。
    const ripHex = variant.registers.find((register) => register.name === "RIP")?.valueHex ?? "0x0";
    const rip = BigInt(ripHex);
    const covering = variant.memoryRegions.filter((region) => {
      const start = BigInt(region.startAddressHex);
      return rip >= start && rip < start + BigInt(region.byteLength);
    });
    expect(covering.map((region) => region.regionId)).not.toHaveLength(0);
    expect(covering.every((region) => region.permissions.includes("x"))).toBe(true);

    // 入口声明与初始 RIP 同址(XS-PROJ-VALUES 镜像义务的运行时面)。
    expect(privateBundle.entrypointAddressHex).toBeDefined();
    expect(BigInt(privateBundle.entrypointAddressHex!)).toBe(BigInt(ripHex));
    expect(BigInt(privateBundle.entrypointAddressHex!)).toBe(
      BigInt(LIFECYCLE_CHALLENGE_CODE_BASE),
    );
  });

  it("演示题不是 IR 模式(IR ⇒ 调试变体契约不可表达)", async () => {
    const bundles = new MemoryChallengeBundleStore();
    await registerDemoChallenge(bundles);
    // 反例锚:演示题一旦回退到 IR 形态,生产路径用例会以本规则 ID 失败,
    // 错误信息直接指向根因。
    expect(RULE_ID_DEBUG_IR_MODE).toBe("XC-DEBUG-MODE-IR");
    const { privateBundle } = await readPair(bundles);
    expect(privateBundle.compiledIr).toBeUndefined();
    expect(privateBundle.entrypointAddressHex).toBe(LIFECYCLE_CHALLENGE_CODE_BASE);
  });

  it("防漂移机检:生产种子 k6/seed-challenge.mjs 不得回到 IR 形态", () => {
    // 该 .mjs 不可 import(顶层连 PG / MinIO 且缺 env 即 process.exit(1)),
    // 故按有界源码面机检锚定形态(理由见文件头)。
    const source = readFileSync(SEED_SCRIPT_PATH, "utf8");

    // ① 不得携带 IR 程序体(XC-DEBUG-MODE-IR 的形态前提;匹配**声明**形态,
    //    注释里提及 compiledIr 不算)。
    expect(source).not.toMatch(/compiledIr\s*:/);
    // ② 必须以入口地址声明程序形态。
    expect(source).toMatch(/entrypointAddressHex\s*:\s*CODE_BASE/);
    // ③ 编码表必须在场且覆盖入口(ret ⇒ 0xc3)。
    expect(source).toMatch(/encodingTable\s*:\s*\[/);
    expect(source).toMatch(/tokenHex:\s*"0xc3"/);
    // ④ 私有初始寄存器与公开可见寄存器的 RIP 均对齐代码区入口。
    expect(source).toMatch(/RIP:\s*CODE_BASE/);
    expect(source).toContain(`{ name: "RIP", valueHex: "${LIFECYCLE_CHALLENGE_CODE_BASE}" }`);
  });
});

/**
 * 把演示题双包登记进 rig 双包存储 + 登记表(与
 * `session-rig.ts:registerByteChallenge` 同款调用序列 = 生产登记路径同形)。
 */
async function registerDemoChallengeIntoRig(rig: SessionTestRig): Promise<void> {
  const pair = buildLifecycleChallengePair(DEMO_CHALLENGE_ID);
  const privateBundleBytes = Buffer.from(JSON.stringify(pair.privateBundle), "utf8");
  const publicDescriptorBytes = Buffer.from(JSON.stringify(pair.publicDescriptor), "utf8");
  await rig.registry.upsertChallenge({ challengeId: DEMO_CHALLENGE_ID, tenantId: TEST_TENANT_ID });
  await rig.registry.insertChallengeVersion({
    challengeId: DEMO_CHALLENGE_ID,
    contentVersion: LIFECYCLE_CHALLENGE_CONTENT_VERSION,
    tenantId: TEST_TENANT_ID,
    vmProfileVersion: "1.0.0",
    privateBundleSha256: sha256Hex(privateBundleBytes),
    publicDescriptorSha256: sha256Hex(publicDescriptorBytes),
    privateBundleObject: `${DEMO_CHALLENGE_ID}/${LIFECYCLE_CHALLENGE_CONTENT_VERSION}/bundle.json`,
    publicDescriptorObject: `${DEMO_CHALLENGE_ID}/${LIFECYCLE_CHALLENGE_CONTENT_VERSION}/descriptor.json`,
    signature: "test-signature",
    signerKeyId: "test-key",
  });
  await rig.bundles.putPrivate(
    DEMO_CHALLENGE_ID,
    LIFECYCLE_CHALLENGE_CONTENT_VERSION,
    privateBundleBytes,
  );
  await rig.bundles.putPublic(
    DEMO_CHALLENGE_ID,
    LIFECYCLE_CHALLENGE_CONTENT_VERSION,
    publicDescriptorBytes,
  );
}

/**
 * 真机面(IT 门控,`SESSION_API_IT=1` + 本机 vm-worker 二进制):**演示题**
 * 经真实 vm-worker 的变体装配 + 生产变体供给完成 attach,并能取得指令覆盖。
 *
 * 这是本缺陷最强的一条锁:上面两个用例只到「TS 契约出口」,真机装配可能另有
 * 拒绝面(`variant.rs` 的程序形态边界 / 入口校验);本用例走真实二进制的
 * `assemble_variant`,并以「暂停落点(初始 RIP)有指令覆盖」证明 RIP 对齐生效
 * —— 这正是真机指令视图恒空的根因。
 */
describe.skipIf(process.env.SESSION_API_IT !== "1")(
  "演示题在真实 vm-worker 上的调试档可达性(真机,IT 门控)",
  () => {
    it("attach 成功,且暂停落点(初始 RIP)有指令覆盖", async () => {
      const rig = await buildSessionTestRig({
        debug: {
          workerCommand: { command: await ensureWorkerBinary() },
          variantProviderFactory: (bundles) =>
            productionDebugVariantProvider({
              bundles,
              generateDebugSeedHex: () => FIXED_DEBUG_SEED_HEX,
            }),
        },
      });
      try {
        await registerDemoChallengeIntoRig(rig);
        // 凭证 claim 必须绑定演示题(缺省绑定 rig 的 IR 测试题 ⇒ 创建会话 401)。
        const issued = await rig.issueEmbedToken({
          claims: {
            challengeId: DEMO_CHALLENGE_ID,
            challengeVersion: LIFECYCLE_CHALLENGE_CONTENT_VERSION,
          },
        });
        const create = await rig.app.inject({
          method: "POST",
          url: "/sessions",
          payload: sessionCommand("create_session", {
            challengeId: DEMO_CHALLENGE_ID,
            challengeVersion: LIFECYCLE_CHALLENGE_CONTENT_VERSION,
            embedSessionId: issued.claims.embedSessionId,
            embedToken: issued.token,
          }),
        });
        expect(create.statusCode).toBe(201);
        const sessionId = (create.json() as { payload: { sessionId: string } }).payload.sessionId;
        const cookie = sessionCredentialFromSetCookie(create);

        const client = await rig.connectDebugChannel(cookie);
        const frames: ReturnType<typeof DebugFrameSchema.parse>[] = [];
        client.on("message", (data: Buffer) => {
          frames.push(DebugFrameSchema.parse(JSON.parse(data.toString("utf8"))));
        });

        // attach:修前此处恒 error/internal_error(变体产出被 XC-DEBUG-MODE-IR 拒绝)。
        client.send(JSON.stringify({
          protocolVersion: 1,
          type: "debug_attach",
          sessionId,
          seq: 1,
          requestId: "attach-1",
          payload: { origin: { kind: "revision", revision: 0 } },
        }));
        await vi.waitFor(
          () => {
            if (!frames.some((frame) => frame.type === "debug_function_table")) {
              throw new Error(`attach 未完成:${JSON.stringify(frames)}`);
            }
          },
          { timeout: 20_000, interval: 20 },
        );
        expect(frames[0]?.type).toBe("debug_attached");
        expect(frames.some((frame) => frame.type === "error")).toBe(false);

        // 首个暂停(推送模型定案 §九:指令流随 debug_paused 下发)。断点取
        // 当前 RIP ⇒ 立即命中,落点即变体初始 RIP。
        client.send(JSON.stringify({
          protocolVersion: 1,
          type: "debug_run_to_breakpoint",
          sessionId,
          seq: 2,
          requestId: "bp-1",
          payload: { breakpoints: [LIFECYCLE_CHALLENGE_CODE_BASE] },
        }));
        await vi.waitFor(
          () => {
            if (!frames.some((frame) => frame.type === "debug_instruction_stream")) {
              throw new Error(`未收到指令流:${JSON.stringify(frames)}`);
            }
          },
          { timeout: 20_000, interval: 20 },
        );

        const paused = frames.find((frame) => frame.type === "debug_paused");
        expect(paused?.type === "debug_paused" && BigInt(paused.payload.addressHex)).toBe(
          BigInt(LIFECYCLE_CHALLENGE_CODE_BASE),
        );
        const stream = frames.find((frame) => frame.type === "debug_instruction_stream");
        // 落点有覆盖 = 初始 RIP 落在可执行区域且编码表覆盖入口(ret)。
        expect(
          stream?.type === "debug_instruction_stream" &&
            BigInt(stream.payload.instructions[0]!.addressHex),
        ).toBe(BigInt(LIFECYCLE_CHALLENGE_CODE_BASE));
        expect(
          stream?.type === "debug_instruction_stream" && stream.payload.instructions[0]!.text,
        ).toBe("ret");
      } finally {
        await rig.debugOrchestrator.dispose();
        await rig.wssRegistry.closeAll();
        await rig.app.close();
      }
    }, 120_000);
  },
);

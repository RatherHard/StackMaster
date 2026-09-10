/**
 * 跨域载荷录制机检(阶段三 WP-7 第 1 条;ZR-B4 / B5 / B9 / B10 通道录制面
 * + ZR-B1 / B6 语料法接线的 rig 级落点)。
 *
 * 录制面:rig 级 OutboundFrameRecorder(服务端出站帧钩子,WSS 全量)+
 * HTTP 响应体录制(生命周期五命令 + 签发端点全链路)。机检:
 * `scanCrossDomainPayloads`(ZR-B9 共现 / ZR-B10 私有事件形态 / ZR-B5 快照
 * 魔数 / ZR-B4 键名语料 / ZR-B1 / B6 语料)对全部录制载荷**零命中**;
 * 红灯反例把违规帧注入录制集,证明扫描器对每一违规类都可检出(零命中
 * 不是静默绿灯)。
 *
 * 机检对象 = 服务端发出的跨域**载荷**(HTTP JSON 响应体 + WSS 出站帧);
 * 凭证交付头(Set-Cookie 的 JWT)是签名载体而非跨域载荷,其卫生面由
 * WP-2 / WP-1 纪律测试承载(D-API-12 / ZR-B7)。客户端 → 服务端方向不设
 * 机检对象(浏览器完全不可信,任何注入都须被服务端确定性拒绝——篡改面
 * 归 ZR-T1~T4 矩阵)。
 *
 * 通道上只有公开投影(硬门槛):录制面只观察已过冻结 Schema 自检的出站帧
 * (wss-channel #emitFrame 先 WssFrameSchema.parse 再 outboundFrameSink),
 * HTTP 响应面同样先过冻结响应 Schema 自检——机检之上还有契约自检双层。
 */

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { WssFrame } from "@stackmaster/protocol";
import { WssFrameSchema } from "@stackmaster/protocol";

import {
  formatCrossDomainHits,
  scanCrossDomainPayloads,
} from "../../src/scan/cross-domain-payload-scanner.js";
import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  TEST_HOST_BACKEND_TOKEN,
  buildSessionTestRig,
  credentialHeaders,
  sessionCommand,
  sessionCredentialFromSetCookie,
  type SessionTestRig,
} from "../routes/helpers/session-rig.js";
import { SESSION_CREDENTIAL_COOKIE_NAME } from "../../src/auth/cookie.js";

/** HTTP 响应体录制器(全链路 inject 的机检采集面)。 */
class HttpBodyRecorder {
  readonly bodies: unknown[] = [];

  async inject(
    app: FastifyInstance,
    options: { url: string; payload?: Record<string, unknown>; cookies?: Record<string, string>; headers?: Record<string, string> },
  ): Promise<{ statusCode: number; body: unknown; headers: Record<string, unknown> }> {
    const response = await app.inject({
      method: "POST",
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      ...(options.cookies === undefined ? {} : { cookies: options.cookies }),
      // 变更方法必携白名单 Origin(CSRF 闸,D-API-17);机检对象是响应体。
      headers: { ...credentialHeaders(), ...options.headers },
    });
    let body: unknown;
    try {
      body = response.json();
    } catch {
      body = response.body; // 非 JSON 形态(理论不可达;按原文收录)
    }
    this.bodies.push(body);
    return { statusCode: response.statusCode, body, headers: response.headers as Record<string, unknown> };
  }
}

const RIGS: SessionTestRig[] = [];

async function buildAuditedRig(): Promise<{ rig: SessionTestRig; http: HttpBodyRecorder }> {
  const rig = await buildSessionTestRig();
  RIGS.push(rig);
  return { rig, http: new HttpBodyRecorder() };
}

afterEach(async () => {
  const rigs = RIGS.splice(0, RIGS.length);
  for (const rig of rigs) {
    await rig.wssRegistry.closeAll();
    await rig.app.close();
  }
});

/** WSS 出站帧收集(客户端视角的线上帧;与服务端录制器双向对账)。 */
function collectClientFrames(client: Awaited<ReturnType<SessionTestRig["connectChannel"]>>): {
  frames: WssFrame[];
  waitFor(predicate: (frames: readonly WssFrame[]) => boolean, timeoutMs?: number): Promise<void>;
} {
  const frames: WssFrame[] = [];
  client.on("message", (data: Buffer) => {
    frames.push(JSON.parse(data.toString("utf8")) as WssFrame);
  });
  return {
    frames,
    async waitFor(predicate, timeoutMs = 5000) {
      const { vi } = await import("vitest");
      await vi.waitFor(
        () => {
          if (!predicate(frames)) {
            throw new Error("等待出站帧超时");
          }
        },
        { timeout: timeoutMs, interval: 10 },
      );
    },
  };
}

describe("跨域载荷录制机检:全链路录制 + 零命中", () => {
  it("签发 → create_session → WSS 动作序列 → sync / checkpoints / submit / close:录制集机检零命中", async () => {
    const { rig, http } = await buildAuditedRig();
    await rig.registerChallenge();

    // 1. embed token 签发端点(完整签发链路的 HTTP 响应面进录制集)。
    const issued = await rig.issueEmbedToken();
    const issuance = await http.inject(rig.app, {
            url: "/auth/embed-tokens",
      payload: {
        tenantId: issued.claims.tenantId,
        userId: issued.claims.userId,
        challengeId: issued.claims.challengeId,
        challengeVersion: issued.claims.challengeVersion,
        embedSessionId: issued.claims.embedSessionId,
      },
      headers: { authorization: `Bearer ${TEST_HOST_BACKEND_TOKEN}` },
    });
    expect(issuance.statusCode).toBe(201);
    // 签发端点走宿主凭证认证(与 issueEmbedToken 直签并存;响应面进机检)。
    const embedToken = (issuance.body as { embedToken: string }).embedToken;

    // 2. create_session(201 + Cookie)。
    const created = await http.inject(rig.app, {
            url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: TEST_CHALLENGE_ID,
        challengeVersion: TEST_CHALLENGE_VERSION,
        embedSessionId: issued.claims.embedSessionId,
        embedToken,
      }),
    });
    expect(created.statusCode).toBe(201);
    const sessionId = (created.body as { payload: { sessionId: string } }).payload.sessionId;
    const cookie = sessionCredentialFromSetCookie(created);

    // 3. WSS 动作序列:覆盖 12 动作中通道承载的代表性面(含确定性拒绝帧)。
    const client = await rig.connectChannel(cookie);
    const collector = collectClientFrames(client);
    const actions: { seq: number; type: string; bytesHex?: string }[] = [
      { seq: 1, type: "write_bytes", bytesHex: "aa" },
      { seq: 2, type: "step" },
      { seq: 3, type: "pause" },
      { seq: 4, type: "undo" },
      { seq: 5, type: "write_bytes", bytesHex: "ff" }, // 确定性拒绝(rejected 响应形态)
      { seq: 6, type: "create_checkpoint" },
      { seq: 7, type: "checkout_checkpoint" },
      { seq: 8, type: "reset" },
    ];
    let clientSeq = 0;
    for (const action of actions) {
      clientSeq += 1;
      client.send(JSON.stringify({
        protocolVersion: 1,
        type: "action",
        sessionId,
        seq: action.seq,
        payload: {
          protocolVersion: 1,
          sessionId,
          clientSeq,
          baseRevision: action.seq - 1,
          idempotencyKey: `audit-${action.seq}`,
          action:
            action.type === "write_bytes"
              ? { type: "write_bytes", args: { addressHex: "0x401000", bytesHex: action.bytesHex } }
              : { type: action.type, args: {} },
        },
      }));
      await collector.waitFor((frames) => frames.length === action.seq);
    }

    // 4. REST 生命周期余下面:projection-sync / checkpoints / submissions / close。
    const cookies = { [SESSION_CREDENTIAL_COOKIE_NAME]: cookie };
    const sync = await http.inject(rig.app, {
            url: "/sessions/projection-sync",
      payload: sessionCommand("sync_projection", { sessionId }),
      cookies,
    });
    expect(sync.statusCode).toBe(200);
    const list = await http.inject(rig.app, {
            url: "/sessions/checkpoints",
      payload: sessionCommand("list_checkpoints", { sessionId }),
      cookies,
    });
    expect(list.statusCode).toBe(200);
    const submit = await http.inject(rig.app, {
            url: "/sessions/submissions",
      payload: sessionCommand("submit", { sessionId }),
      cookies,
    });
    expect(submit.statusCode).toBe(200);
    const close = await http.inject(rig.app, {
            url: "/sessions/close",
      payload: sessionCommand("close_session", { sessionId }),
      cookies,
    });
    expect(close.statusCode).toBe(200);

    // 5. 机检:服务端出站帧(录制器)× HTTP 响应体(录制器)全量零命中。
    const recordedFrames = rig.outboundRecorder.frames();
    expect(recordedFrames.length).toBeGreaterThanOrEqual(actions.length);
    const hits = scanCrossDomainPayloads([
      ...recordedFrames,
      ...http.bodies,
    ]);
    expect(hits, `跨域载荷机检命中:\n${formatCrossDomainHits(hits).join("\n")}`).toEqual([]);

    // 双向对账:客户端视角帧与服务端录制器一致(录制面完整捕获,WP-5 完成标准)。
    expect(collector.frames.length).toBe(recordedFrames.length);
  });

  it("全部录制帧均为封闭帧类型;响应载荷零凭证字段(通道形态复核)", async () => {
    const { rig, http } = await buildAuditedRig();
    await rig.registerChallenge();
    const issued = await rig.issueEmbedToken();
    const created = await http.inject(rig.app, {
            url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: TEST_CHALLENGE_ID,
        challengeVersion: TEST_CHALLENGE_VERSION,
        embedSessionId: issued.claims.embedSessionId,
        embedToken: issued.token,
      }),
    });
    expect(created.statusCode).toBe(201);
    const sessionId = (created.body as { payload: { sessionId: string } }).payload.sessionId;
    const cookie = sessionCredentialFromSetCookie(created);
    const client = await rig.connectChannel(cookie);
    const collector = collectClientFrames(client);
    client.send(JSON.stringify({
      protocolVersion: 1, type: "action", sessionId, seq: 1,
      payload: { protocolVersion: 1, sessionId, clientSeq: 1, baseRevision: 0, idempotencyKey: "audit-shape-1", action: { type: "step", args: {} } },
    }));
    await collector.waitFor((frames) => frames.length === 1);

    const raw = JSON.stringify(rig.outboundRecorder.frames());
    expect(raw).not.toContain("credential");
    expect(raw).not.toContain("embedToken");
    expect(raw).not.toContain("signingKey");
    for (const frame of rig.outboundRecorder.frames()) {
      expect(["action_response", "error"]).toContain(frame.type); // 出站封闭方向
      expect(() => WssFrameSchema.parse(frame)).not.toThrow();
    }
  });
});

describe("红灯反例:违规载荷注入录制集 → 扫描器必检出(每违规类)", () => {
  /** 全链路录制基线(同上最小链;反例在其上注入)。 */
  async function recordBaseline(): Promise<{ rig: SessionTestRig; recorded: unknown[] }> {
    const { rig, http } = await buildAuditedRig();
    await rig.registerChallenge();
    const issued = await rig.issueEmbedToken();
    const created = await http.inject(rig.app, {
            url: "/sessions",
      payload: sessionCommand("create_session", {
        challengeId: TEST_CHALLENGE_ID,
        challengeVersion: TEST_CHALLENGE_VERSION,
        embedSessionId: issued.claims.embedSessionId,
        embedToken: issued.token,
      }),
    });
    const sessionId = (created.body as { payload: { sessionId: string } }).payload.sessionId;
    const cookie = sessionCredentialFromSetCookie(created);
    const client = await rig.connectChannel(cookie);
    const collector = collectClientFrames(client);
    client.send(JSON.stringify({
      protocolVersion: 1, type: "action", sessionId, seq: 1,
      payload: { protocolVersion: 1, sessionId, clientSeq: 1, baseRevision: 0, idempotencyKey: "redlamp-1", action: { type: "step", args: {} } },
    }));
    await collector.waitFor((frames) => frames.length === 1);
    const recorded: unknown[] = [...rig.outboundRecorder.frames(), ...http.bodies];
    // 基线本身必须零命中(否则反例无意义)。
    expect(scanCrossDomainPayloads(recorded)).toEqual([]);
    return { rig, recorded };
  }

  it("ZR-B9:注入携带 VmState 字段共现的违规帧 → 共现命中", async () => {
    const { recorded } = await recordBaseline();
    const violating = {
      protocolVersion: 1, type: "action_response", sessionId: "sess-x", seq: 99,
      payload: { requestId: "req-x", revision: 1, status: "running", registers: {}, memory: {}, seedState: {} },
    };
    const hits = scanCrossDomainPayloads([...recorded, violating]);
    expect(hits.map((hit) => hit.id)).toContain("ZR-B9-cooccurrence");
  });

  it("ZR-B10:注入私有事件形态帧(Internal / privateEventLog)→ 命中", async () => {
    const { recorded } = await recordBaseline();
    const internalEvent = { publicEvents: [{ seq: 0, kind: "Internal" }] };
    const eventLogForm = { privateEventLog: [{ kind: "FileGranted" }] };
    const hits = scanCrossDomainPayloads([...recorded, internalEvent, eventLogForm]);
    // 3 处:Internal kind 值;privateEventLog 键(完整事件日志形态);
    // 其行内 FileGranted kind 值。
    expect(hits.filter((hit) => hit.id === "ZR-B10-private-event-form")).toHaveLength(3);
  });

  it("ZR-B5:注入快照密文魔数 / 明文信封标记 → 命中", async () => {
    const { recorded } = await recordBaseline();
    const cipherMagic = { blob: "SMEN\u0001…" };
    const plainEnvelope = { snapshot: { form: "stackmaster-session-snapshot/1" } };
    const hits = scanCrossDomainPayloads([...recorded, cipherMagic, plainEnvelope]);
    expect(hits.filter((hit) => hit.id === "ZR-B5-snapshot-envelope")).toHaveLength(2);
  });

  it("ZR-B4 / ZR-B1 / ZR-B6:注入键名语料 / flag / seed 语料 → 命中", async () => {
    const { recorded } = await recordBaseline();
    const bundleKeys = { judgingConfig: {}, hiddenTests: [] };
    const flag = { message: "FLAG{synthetic_red_lamp}" };
    const seed = { seed: "00112233445566778899aabbccddeeff" };
    const hits = scanCrossDomainPayloads([...recorded, bundleKeys, flag, seed]);
    expect(hits.map((hit) => hit.id)).toContain("ZR-B4-bundle-key");
    expect(hits.map((hit) => hit.id)).toContain("ZR-B1-flag-corpus");
    expect(hits.map((hit) => hit.id)).toContain("ZR-B6-seed-corpus");
  });
});

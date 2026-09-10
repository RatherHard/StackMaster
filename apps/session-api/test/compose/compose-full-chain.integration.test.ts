/**
 * Compose 全拓扑集成测试(阶段三 WP-7 第 4 / 5 条;质量门禁 7 阶段三子集)。
 *
 * 完整拓扑 = PostgreSQL + Redis + MinIO + session-api + vm-worker(D-API-63:
 * worker 以镜像内二进制 + 会话期子进程形态交付,compose 的 vm-worker 服务为
 * linux 二进制冒烟;D-API-64)。拓扑形态:
 *  - container(CI):compose/app.yaml 全拓扑;本套件经发布端口 13000 访问;
 *  - host(本机 Windows 降级形态):依赖服务(deps.yaml)+ session-api 宿主
 *    进程 + 本机 worker 二进制;链路语义与容器形态一致。
 *
 * 链路(边界声明:verifier 裁决闭环归阶段六——submit 到内部裁决引用 +
 * 动作日志完整可取回为止):
 *   POST /auth/embed-tokens(完整 token 链路)→ create_session → WSS 动作 →
 *   增量下发 → 断线重连 → sync-projection → checkpoint / undo / checkout →
 *   submit(裁决引用与动作日志落库可取回)。
 *
 * 机检:全部 HTTP 响应体 + WSS 入站帧经 scanCrossDomainPayloads 零命中
 * (ZR-B9 / B10 / B5 / B4 / B1 / B6 的通道录制面,与 rig 级审计同源)。
 * 重启恢复:编排器重启 → active 会话自快照恢复(启动期接线,D-API-63)→
 * revision 自快照续算 + 同输入恒同响应(I-4,与未重启孪生会话对齐)。
 */

import { generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { ActionResponse, WssFrame } from "@stackmaster/protocol";
import { canonicalize } from "@stackmaster/protocol";

import {
  LIFECYCLE_STACK_ADDRESS,
  lifecycleBundle,
  lifecycleDescriptor,
} from "./helpers/lifecycle-challenge.js";

import { SESSION_CREDENTIAL_COOKIE_NAME } from "../../src/auth/cookie.js";
import {
  ChallengeRegistrar,
  MinioChallengeBundleStore,
  PostgresActionLogStore,
  PostgresChallengeRegistry,
  PostgresSubmissionStore,
  createMinioClient,
  createPostgresPool,
  registrationSignatureBasis,
  sha256Hex,
} from "../../src/persistence/index.js";
import {
  scanCrossDomainPayloads,
  formatCrossDomainHits,
} from "../../src/scan/cross-domain-payload-scanner.js";
import { WssChannelClient } from "./helpers/ws-client.js";
import {
  BASE_HOST,
  BASE_PORT,
  COMPOSE_ENABLED,
  HOST_BACKEND_TOKEN,
  IT_CONFIG,
  SKIP_REASON,
  TOPOLOGY,
  TrafficRecorder,
  HostProcess,
  credentialFromSetCookie,
  postJson,
  waitForHealth,
} from "./helpers/topology.js";

describe.skipIf(!COMPOSE_ENABLED)(
  `Compose 全拓扑集成(${TOPOLOGY} 形态;${SKIP_REASON})`,
  () => {
    // ── 每次运行唯一的注册身份(版本不可变约束对残留数据免疫)──
    const runSuffix = Math.random().toString(16).slice(2, 10);
    // 嵌入会话标识(128-bit CSPRNG base64url;冻结 Schema 最短 22 字符)。
    const embedSessionId = () => randomBytes(16).toString("base64url");
    const tenantId = `compose-${runSuffix}`;
    const userId = "user-compose";
    const challengeId = `chal-compose-${runSuffix}`;
    const contentVersion = "1.0.0";
    const stackAddressHex = LIFECYCLE_STACK_ADDRESS; // 题目栈区起点(rw;32 位档)

    const recorder = new TrafficRecorder();
    const host = new HostProcess();
    const clients: WssChannelClient[] = [];
    let pool: Pool | null = null;

    let firstSession: { sessionId: string; cookie: string } | null = null;

    async function connectChannel(cookie: string): Promise<WssChannelClient> {
      const client = await WssChannelClient.connect({
        url: `ws://${BASE_HOST}:${BASE_PORT}/sessions/channel`,
        cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookie}`,
      });
      clients.push(client);
      return client;
    }

    function actionFrame(input: {
      sessionId: string;
      seq: number;
      idempotencyKey: string;
      action: Record<string, unknown>;
    }): string {
      return JSON.stringify({
        protocolVersion: 1,
        type: "action",
        sessionId: input.sessionId,
        seq: input.seq,
        payload: {
          protocolVersion: 1,
          sessionId: input.sessionId,
          clientSeq: input.seq,
          baseRevision: input.seq - 1,
          idempotencyKey: input.idempotencyKey,
          action: input.action,
        },
      });
    }

    beforeAll(async () => {
      // 1. 拓扑就绪(host:拉起宿主进程;container:run.mjs 已 up --wait)。
      await host.start();

      // 2. 题目登记(经发布端口的 PG / MinIO;登记路径带真实验签)。
      pool = await createPostgresPool(IT_CONFIG.postgresUrl, 3);
      const registry = new PostgresChallengeRegistry(pool);
      const minio = await createMinioClient({
        endpoint: IT_CONFIG.minioEndpoint,
        port: IT_CONFIG.minioPort,
        accessKey: IT_CONFIG.minioAccessKey,
        secretKey: IT_CONFIG.minioSecretKey,
      });
      const bundles = new MinioChallengeBundleStore(minio, {
        bucketPrivate: IT_CONFIG.minioBucketPrivate,
        bucketPublic: IT_CONFIG.minioBucketPublic,
      });
      await bundles.ensureBuckets();

      // 生命周期教学题目(合成占位内容;引擎侧已验证的合法装载形态——
      // 真实 vm-worker 的装配器会拒绝 helper 最小 IR 对,见 helper 文件头说明)。
      const privateBundle = Buffer.from(JSON.stringify(lifecycleBundle(challengeId)), "utf8");
      const publicDescriptor = Buffer.from(JSON.stringify(lifecycleDescriptor(challengeId)), "utf8");
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const signature = cryptoSign(
        null,
        Buffer.from(
          registrationSignatureBasis({
            challengeId,
            contentVersion,
            vmProfileVersion: "1.0.0",
            privateBundleSha256: sha256Hex(privateBundle),
            publicDescriptorSha256: sha256Hex(publicDescriptor),
          }),
          "utf8",
        ),
        privateKey,
      ).toString("base64");
      await new ChallengeRegistrar({ bundles, registry, signingPublicKey: publicKey }).register({
        tenantId,
        challengeId,
        contentVersion,
        vmProfileVersion: "1.0.0",
        privateBundle,
        publicDescriptor,
        signature,
      });
    }, 120_000);

    afterAll(async () => {
      for (const client of clients.splice(0)) {
        client.close();
      }
      await host.stop();
      if (pool !== null) {
        await pool.end().catch(() => undefined);
      }
    });

    it("拓扑就绪:liveness 与 readiness 探针全绿(PG / Redis / MinIO 可达)", async () => {
      const health = await fetch(`${"http"}://${BASE_HOST}:${BASE_PORT}/healthz`);
      expect(health.status).toBe(200);
      const ready = await fetch(`${"http"}://${BASE_HOST}:${BASE_PORT}/readyz`);
      expect(ready.status).toBe(200);
    });

    it("完整 token 链路:签发 → create_session(201 + Cookie)→ WSS 动作 → 增量下发", async () => {
      // 1. embed token 签发(宿主凭证认证;嵌入协议 §六)。
      const firstEmbedSessionId = embedSessionId();
      const issuance = await postJson(recorder, "/auth/embed-tokens", {
        tenantId,
        userId,
        challengeId,
        challengeVersion: contentVersion,
        embedSessionId: firstEmbedSessionId,
      }, { bearer: HOST_BACKEND_TOKEN });
      expect(issuance.status).toBe(201);
      const embedToken = (issuance.body as { embedToken: string }).embedToken;

      // 2. create_session(消费 embed token;201 + Set-Cookie 会话凭证)。
      const created = await postJson(recorder, "/sessions", {
        command: "create_session",
        protocolVersion: 1,
        payload: { challengeId, challengeVersion: contentVersion, embedSessionId: firstEmbedSessionId, embedToken },
      });
      expect(created.status).toBe(201);
      const createdBody = created.body as { payload: { sessionId: string; revision: number } };
      expect(createdBody.payload.revision).toBe(0);
      const sessionId = createdBody.payload.sessionId;
      const cookie = credentialFromSetCookie(created.setCookie);
      firstSession = { sessionId, cookie };

      // 3. WSS 动作:write_bytes(栈区)→ 增量下发(ProjectionDelta 耦合)。
      const client = await connectChannel(cookie);
      client.sendText(actionFrame({
        sessionId,
        seq: 1,
        idempotencyKey: `compose-a-1-${runSuffix}`,
        action: { type: "write_bytes", args: { addressHex: stackAddressHex, bytesHex: "41" } },
      }));
      await client.waitFor((messages) => messages.length >= 1);
      const frame = JSON.parse(client.messages[0]!) as WssFrame;
      expect(frame.type).toBe("action_response");
      const response = (frame as { payload: ActionResponse }).payload;
      expect(response.revision).toBe(1);
      expect(response.projectionDelta?.revision).toBe(response.revision); // 增量耦合

      // 4. 单步执行 + 幂等重放(缓存字节相同)。
      client.sendText(actionFrame({
        sessionId, seq: 2, idempotencyKey: `compose-a-2-${runSuffix}`,
        action: { type: "step", args: {} },
      }));
      await client.waitFor((messages) => messages.length >= 2);
      const stepFrame = JSON.parse(client.messages[1]!) as WssFrame;
      expect((stepFrame.payload as ActionResponse).revision).toBe(2);
    }, 60_000);

    it("断线重连 → REST sync-projection 对齐 → 新锚继续(断线保持服务端义务)", async () => {
      const { sessionId, cookie } = firstSession!;
      // 重连:升级即凭证重验。
      const reconnected = await connectChannel(cookie);
      const sync = await postJson(recorder, "/sessions/projection-sync", {
        command: "sync_projection",
        protocolVersion: 1,
        payload: { sessionId },
      }, { cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookie}` });
      expect(sync.status).toBe(200);
      expect((sync.body as { payload: { revision: number } }).payload.revision).toBe(2);

      // 新锚继续。
      reconnected.sendText(actionFrame({
        sessionId, seq: 3, idempotencyKey: `compose-a-3-${runSuffix}`,
        action: { type: "write_bytes", args: { addressHex: stackAddressHex, bytesHex: "42" } },
      }));
      await reconnected.waitFor((messages) => messages.length >= 1);
      const last = JSON.parse(reconnected.messages.at(-1)!) as WssFrame;
      expect(last.type).toBe("action_response");
      expect((last.payload as ActionResponse).revision).toBe(3);
    }, 60_000);

    it("checkpoint / undo / checkout:恢复点落库与回退语义", async () => {
      const { sessionId, cookie } = firstSession!;
      const client = await connectChannel(cookie);
      let clientSeq = 3;

      // checkpoint(accepted;恢复点经编排器密文落库)。
      clientSeq += 1;
      client.sendText(actionFrame({
        sessionId, seq: clientSeq, idempotencyKey: `compose-a-cp-${runSuffix}`,
        action: { type: "create_checkpoint", args: { label: "compose-gate" } },
      }));
      await client.waitFor((messages) => messages.length >= 1);
      const checkpointFrame = JSON.parse(client.messages.at(-1)!) as WssFrame;
      expect((checkpointFrame.payload as ActionResponse).status).toBe("running");

      // checkpointId 经 list_checkpoints 取回(服务端签发标识)。
      const list = await postJson(recorder, "/sessions/checkpoints", {
        command: "list_checkpoints",
        protocolVersion: 1,
        payload: { sessionId },
      }, { cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookie}` });
      expect(list.status).toBe(200);
      const checkpoints = (list.body as { payload: { checkpoints: { checkpointId: string }[] } }).payload.checkpoints;
      expect(checkpoints.length).toBeGreaterThanOrEqual(1);
      const checkpointId = checkpoints.at(-1)!.checkpointId;

      // undo(内容回退,revision 前进)→ checkout(恢复到 checkpoint 内容)。
      clientSeq += 1;
      client.sendText(actionFrame({
        sessionId, seq: clientSeq, idempotencyKey: `compose-a-undo-${runSuffix}`,
        action: { type: "undo", args: {} },
      }));
      await client.waitFor((messages) => messages.length >= 2);
      const undoFrame = JSON.parse(client.messages.at(-1)!) as WssFrame;
      expect((undoFrame.payload as ActionResponse).status).toBe("running");

      clientSeq += 1;
      client.sendText(actionFrame({
        sessionId, seq: clientSeq, idempotencyKey: `compose-a-co-${runSuffix}`,
        action: { type: "checkout_checkpoint", args: { checkpointId } },
      }));
      await client.waitFor((messages) => messages.length >= 3);
      const checkoutFrame = JSON.parse(client.messages.at(-1)!) as WssFrame;
      expect((checkoutFrame.payload as ActionResponse).status).toBe("running");
    }, 60_000);

    it("submit:内部裁决引用落库可取回,动作日志增量可重放(裁决闭环归阶段六)", async () => {
      const { sessionId, cookie } = firstSession!;
      const submitted = await postJson(recorder, "/sessions/submissions", {
        command: "submit",
        protocolVersion: 1,
        payload: { sessionId },
      }, { cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookie}` });
      expect(submitted.status).toBe(200);
      const { submissionId, revision } = (submitted.body as { payload: { submissionId: string; revision: number } }).payload;
      expect(revision).toBeGreaterThan(0);

      // 裁决引用与动作日志落库可取回(PG 权威存储;发布端口直查)。
      const store = new PostgresSubmissionStore(pool!);
      const submissions = await store.findBySession(sessionId, tenantId);
      expect(submissions.length).toBeGreaterThanOrEqual(1);
      const found = submissions.find((row) => row.id === submissionId);
      expect(found).toBeDefined();
      const reference = found!.reference as { actionLog?: unknown[] };
      expect(Array.isArray(reference.actionLog)).toBe(true);

      const actionLog = new PostgresActionLogStore(pool!);
      const entries = await actionLog.listBySession(sessionId, tenantId);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      // 仅已接受动作(拒绝不入账);条目带 clientSeq / revisionAfter / action。
      for (const entry of entries) {
        expect(entry.action).toHaveProperty("type");
      }
    }, 60_000);

    it("跨域载荷机检:全捕获(HTTP 响应体 + WSS 帧)扫描零命中", () => {
      const hits = scanCrossDomainPayloads([...recorder.wssFrames, ...recorder.httpBodies]);
      expect(hits, `跨域载荷机检命中:\n${formatCrossDomainHits(hits).join("\n")}`).toEqual([]);
      // ZR-B10 通道级复核:私有事件类别结构性缺席。
      const raw = JSON.stringify(recorder.wssFrames);
      for (const kind of ["Internal", "FileGranted", "FileRead"]) {
        expect(raw).not.toContain(`"kind":"${kind}"`);
      }
    });

    it("编排器重启恢复:active 会话自快照续算 revision;同输入恒同响应(I-4)", async () => {
      // 会话 B:write → checkpoint(rev2)→ 尾动作(rev3;超快照尾部,丢尾语义)。
      const embedSessionIdB = embedSessionId();
      const embedB = await postJson(recorder, "/auth/embed-tokens", {
        tenantId, userId, challengeId, challengeVersion: contentVersion,
        embedSessionId: embedSessionIdB,
      }, { bearer: HOST_BACKEND_TOKEN });
      const tokenB = (embedB.body as { embedToken: string }).embedToken;
      const createdB = await postJson(recorder, "/sessions", {
        command: "create_session",
        protocolVersion: 1,
        payload: { challengeId, challengeVersion: contentVersion, embedSessionId: embedSessionIdB, embedToken: tokenB },
      });
      expect(createdB.status).toBe(201);
      const sessionIdB = (createdB.body as { payload: { sessionId: string } }).payload.sessionId;
      const cookieB = credentialFromSetCookie(createdB.setCookie);
      const clientB = await connectChannel(cookieB);

      clientB.sendText(actionFrame({
        sessionId: sessionIdB, seq: 1, idempotencyKey: `compose-b-1-${runSuffix}`,
        action: { type: "write_bytes", args: { addressHex: stackAddressHex, bytesHex: "41" } },
      }));
      await clientB.waitFor((messages) => messages.length >= 1);
      clientB.sendText(actionFrame({
        sessionId: sessionIdB, seq: 2, idempotencyKey: `compose-b-2-${runSuffix}`,
        action: { type: "create_checkpoint", args: {} },
      }));
      await clientB.waitFor((messages) => messages.length >= 2);
      clientB.sendText(actionFrame({
        sessionId: sessionIdB, seq: 3, idempotencyKey: `compose-b-3-${runSuffix}`,
        action: { type: "write_bytes", args: { addressHex: stackAddressHex, bytesHex: "43" } },
      }));
      await clientB.waitFor((messages) => messages.length >= 3);
      clientB.close();

      // 编排器重启(容器:docker compose restart;host:SIGTERM → 重新拉起;
      // 优雅停机冲刷恢复点)。
      await host.restart();

      // 重启恢复(启动期接线,D-API-62):会话 B 自快照续算,revision = 2。
      await waitForHealth();
      const syncB = await postJson(recorder, "/sessions/projection-sync", {
        command: "sync_projection",
        protocolVersion: 1,
        payload: { sessionId: sessionIdB },
      }, { cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookieB}` });
      expect(syncB.status).toBe(200);
      expect((syncB.body as { payload: { revision: number } }).payload.revision).toBe(2);

      // 恢复后同输入动作(尾部写入,新幂等键)。
      const reconnectB = await connectChannel(cookieB);
      reconnectB.sendText(actionFrame({
        sessionId: sessionIdB, seq: 4, idempotencyKey: `compose-b-4-${runSuffix}`,
        action: { type: "write_bytes", args: { addressHex: stackAddressHex, bytesHex: "43" } },
      }));
      await reconnectB.waitFor((messages) => messages.length >= 1);
      const bTail = JSON.parse(reconnectB.messages[0]!) as WssFrame;
      expect((bTail.payload as ActionResponse).revision).toBe(3);

      // I-4:未重启孪生会话 C 对同序列的同位动作产生同形响应(剥离瞬态标识)。
      const embedSessionIdC = embedSessionId();
      const embedC = await postJson(recorder, "/auth/embed-tokens", {
        tenantId, userId, challengeId, challengeVersion: contentVersion,
        embedSessionId: embedSessionIdC,
      }, { bearer: HOST_BACKEND_TOKEN });
      const tokenC = (embedC.body as { embedToken: string }).embedToken;
      const createdC = await postJson(recorder, "/sessions", {
        command: "create_session",
        protocolVersion: 1,
        payload: { challengeId, challengeVersion: contentVersion, embedSessionId: embedSessionIdC, embedToken: tokenC },
      });
      const sessionIdC = (createdC.body as { payload: { sessionId: string } }).payload.sessionId;
      const cookieC = credentialFromSetCookie(createdC.setCookie);
      const clientC = await connectChannel(cookieC);
      const script = [
        { key: `compose-c-1-${runSuffix}`, action: { type: "write_bytes", args: { addressHex: stackAddressHex, bytesHex: "41" } } },
        { key: `compose-c-2-${runSuffix}`, action: { type: "create_checkpoint", args: {} } },
        { key: `compose-c-3-${runSuffix}`, action: { type: "write_bytes", args: { addressHex: stackAddressHex, bytesHex: "43" } } },
      ];
      for (let index = 0; index < script.length; index += 1) {
        clientC.sendText(actionFrame({ sessionId: sessionIdC, seq: index + 1, idempotencyKey: script[index]!.key, action: script[index]!.action }));
        await clientC.waitFor((messages) => messages.length >= index + 1);
      }
      const cTail = JSON.parse(clientC.messages.at(-1)!) as WssFrame;

      const strip = (frame: unknown) => {
        const clone = structuredClone(frame) as Record<string, unknown> & {
          payload: Record<string, unknown>;
        };
        delete clone["seq"];
        delete clone["sessionId"];
        delete clone.payload["requestId"];
        delete clone.payload["sessionId"];
        return canonicalize(clone);
      };
      expect(strip(bTail)).toBe(strip(cTail));
    }, 180_000);
  },
);

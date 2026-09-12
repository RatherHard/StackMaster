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
 * 链路(阶段三 WP-7:submit 到内部裁决引用 + 动作日志完整可取回;阶段六
 * WP-61 / WP-62:verifier 裁决闭环与汇总落库;阶段六 WP-63:裁决呈现路由
 * `GET /verdicts/:submissionId` 全链路演示 + 404 / 429 红灯矩阵 + ZR-T4
 * verifier 级复锚,D-API-83 / 84 / 97 ~ 100):
 *   POST /auth/embed-tokens(完整 token 链路)→ create_session → WSS 动作 →
 *   增量下发 → 断线重连 → sync-projection → checkpoint / undo / checkout →
 *   submit → GET /verdicts/:submissionId(pending → verdicted 呈现)。
 *
 * 机检:全部 HTTP 响应体 + WSS 入站帧经 scanCrossDomainPayloads 零命中
 * (ZR-B9 / B10 / B5 / B4 / B1 / B6 的通道录制面,与 rig 级审计同源)。
 * 重启恢复:编排器重启 → active 会话自快照恢复(启动期接线,D-API-63)→
 * revision 自快照续算 + 同输入恒同响应(I-4,与未重启孪生会话对齐)。
 */

import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
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
import { DEFAULT_AUDIT_BUCKET } from "../../src/config.js";
import { AUDIT_EVENT_KINDS } from "../../src/auth/ports.js";
import {
  AuditArchiveJob,
  ChallengeRegistrar,
  MinioChallengeBundleStore,
  PgAuditSink,
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
  BASE_URL,
  BASE_PORT,
  COMPOSE_ENABLED,
  HOST_BACKEND_TOKEN,
  IT_CONFIG,
  SKIP_REASON,
  TOPOLOGY,
  TrafficRecorder,
  HostProcess,
  VerifierProcess,
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
    const verifier = new VerifierProcess();
    const clients: WssChannelClient[] = [];
    let pool: Pool | null = null;
    let registeredBundles: MinioChallengeBundleStore | null = null;

    let firstSession: { sessionId: string; cookie: string } | null = null;
    let firstSubmissionId: string | null = null;

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
      registeredBundles = bundles;

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
      firstSubmissionId = submissionId;
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

    // ── 阶段六 WP-61:verifier 裁决闭环(信任域 4;D-API-85 / 87)──────────

    /** 轮询某 submission 的裁决行(verifier 异步落库;返回 11 值字面)。 */
    async function pollVerdict(
      submissionId: string,
      timeoutMs: number,
    ): Promise<string | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const result = await pool!.query<{ verdict: string | null }>(
          `SELECT verdict FROM verdicts WHERE submission_id = $1`,
          [submissionId],
        );
        if (result.rows[0]?.verdict != null) {
          return result.rows[0].verdict;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return null;
    }

    /** 某 submission 的 run 行聚合(status 集合与 pending 计数)。 */
    async function runStates(submissionId: string): Promise<{ statuses: string[]; pending: number }> {
      const result = await pool!.query<{ status: string }>(
        `SELECT status FROM verifier_runs WHERE submission_id = $1 ORDER BY created_at`,
        [submissionId],
      );
      const statuses = result.rows.map((row) => row.status);
      return { statuses, pending: statuses.filter((status) => status === "pending").length };
    }

    /** 直接落一条内部裁决引用(submissions + verifier_runs pending 行)。 */
    async function seedSubmission(input: {
      tenantId: string;
      reference: Record<string, unknown>;
      logDigest: string;
    }): Promise<string> {
      const inserted = await pool!.query<{ id: string }>(
        `INSERT INTO submissions (tenant_id, session_id, revision, public_status, reference)
         VALUES ($1, $2, 1, 'running', $3::jsonb) RETURNING id`,
        [input.tenantId, `sess-seeded-${runSuffix}-${Math.random().toString(16).slice(2, 8)}`,
          JSON.stringify(input.reference)],
      );
      const submissionId = inserted.rows[0]!.id;
      await pool!.query(
        `INSERT INTO verifier_runs (tenant_id, submission_id, status, log_digest)
         VALUES ($1, $2, 'pending', $3)`,
        [input.tenantId, submissionId, input.logDigest],
      );
      return submissionId;
    }

    /** 合法形态的内部裁决引用(含重放材料;challengeId 可注入)。 */
    function fabricatedReference(challengeId: string): Record<string, unknown> {
      const actionLog =
        `{"context":{"archBits":32,"challengeBundleHash":"${sha256Hex(Buffer.from("x"))}","challengeContentVersion":"1.0.0","challengeId":"${challengeId}","engineBuildId":"dev","seedPolicy":{"derivation":null,"strategy":"fixed"},"vmEngineVersion":"0.1.0","vmProfileHash":"${sha256Hex(Buffer.from("y"))}","vmProfileVersion":"1.0.0","verdictRuleVersion":"1.0.0"},"entries":[],"format":"stackmaster-action-log/1"}`;
      return {
        form: "stackmaster-session-submit/1",
        sessionId: "sess-fabricated",
        challenge: { challengeId, challengeContentVersion: "1.0.0", vmProfileVersion: "1.0.0" },
        engine: { vmEngineVersion: "0.1.0", engineBuildId: "dev" },
        seedPolicy: { strategy: "fixed" },
        revision: 1,
        publicStatus: "running",
        actionLog: [],
        replay: {
          replayContext: {
            challengeId,
            challengeContentVersion: "1.0.0",
            vmProfileVersion: "1.0.0",
            vmEngineVersion: "0.1.0",
            engineBuildId: "dev",
            verdictRuleVersion: "1.0.0",
            challengeBundleHash: sha256Hex(Buffer.from("x")),
            vmProfileHash: sha256Hex(Buffer.from("y")),
            archBits: 32,
            seedPolicy: { strategy: "fixed", derivation: null },
          },
          actionLog,
        },
      };
    }

    it("verifier 裁决闭环:submit → 队列 → 独立重放 → verdicts 落库(阶段六退出条件 1)", async () => {
      await verifier.start();
      expect(firstSubmissionId).not.toBeNull();
      const verdict = await pollVerdict(firstSubmissionId!, 90_000);
      // 交互会话保持 running(教学题成功条件未触发);重放非 won ⇒
      // wrong_answer(WP-61 重放面映射,ADR-9 登记)。
      expect(verdict).toBe("wrong_answer");
      const run = await runStates(firstSubmissionId!);
      expect(run.statuses.at(-1)).toBe("completed");
      // 幂等复查:重复轮询不产生第二行(verdicts.submission_id 唯一,005)。
      const count = await pool!.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM verdicts WHERE submission_id = $1`,
        [firstSubmissionId!],
      );
      expect(Number(count.rows[0]!.count)).toBe(1);
    }, 120_000);

    it("裁决队列跨 verifier 重启持久:停机提交 → 重启后裁决落库(裁决可复现前提)", async () => {
      // 停机(verifier 不在服务态)时提交:pending run 行已随 submit 落库。
      await verifier.stop();
      const embedSessionIdD = embedSessionId();
      const embedD = await postJson(recorder, "/auth/embed-tokens", {
        tenantId, userId, challengeId, challengeVersion: contentVersion,
        embedSessionId: embedSessionIdD,
      }, { bearer: HOST_BACKEND_TOKEN });
      const tokenD = (embedD.body as { embedToken: string }).embedToken;
      const createdD = await postJson(recorder, "/sessions", {
        command: "create_session",
        protocolVersion: 1,
        payload: { challengeId, challengeVersion: contentVersion, embedSessionId: embedSessionIdD, embedToken: tokenD },
      });
      const sessionIdD = (createdD.body as { payload: { sessionId: string } }).payload.sessionId;
      const cookieD = credentialFromSetCookie(createdD.setCookie);
      const submittedD = await postJson(recorder, "/sessions/submissions", {
        command: "submit", protocolVersion: 1, payload: { sessionId: sessionIdD },
      }, { cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookieD}` });
      expect(submittedD.status).toBe(200);
      const submissionIdD = (submittedD.body as { payload: { submissionId: string } }).payload.submissionId;

      // verifier 停机窗口内零裁决(pending 持久于 PG,队列本体零新增设施)。
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(await pollVerdict(submissionIdD, 0)).toBeNull();

      // 重启后同一 pending 行被认领,裁决落库(同日志同裁决跨重启)。
      await verifier.restart();
      const verdict = await pollVerdict(submissionIdD, 90_000);
      expect(verdict).toBe("wrong_answer");
    }, 150_000);

    // ── 阶段六 WP-62:隐藏测试裁决汇总、跨重启一致与审计发射(D-API-94 ~ 96)──

    it("同日志跨 verifier 重启汇总一致:同一引用两次独立裁决,verdicts.detail 逐字节一致", async () => {
      // 复制全链路 submission 的引用为第二行(同日志同 log_digest),由独立
      // 的 verify 进程重放——同日志同裁决(含隐藏测试汇总面)是裁决可复现
      // 的实现前提(阶段六退出条件 2)。
      const first = await pool!.query<{ reference: unknown; verdict: string; detail: unknown }>(
        `SELECT s.reference, v.verdict, v.detail
         FROM submissions s JOIN verdicts v ON v.submission_id = s.id
         WHERE s.id = $1`,
        [firstSubmissionId!],
      );
      expect(first.rows[0]).toBeDefined();
      const twin = await pool!.query<{ id: string }>(
        `INSERT INTO submissions (tenant_id, session_id, revision, public_status, reference)
         SELECT tenant_id, session_id || '-wp62-twin', revision, public_status, reference
         FROM submissions WHERE id = $1 RETURNING id`,
        [firstSubmissionId!],
      );
      const twinId = twin.rows[0]!.id;
      await pool!.query(
        `INSERT INTO verifier_runs (tenant_id, submission_id, status, log_digest)
         SELECT tenant_id, $1, 'pending', log_digest FROM verifier_runs
         WHERE submission_id = $2 ORDER BY created_at DESC LIMIT 1`,
        [twinId, firstSubmissionId!],
      );
      const twinVerdict = await pollVerdict(twinId, 90_000);
      expect(twinVerdict).toBe(first.rows[0]!.verdict);
      const twinDetail = await pool!.query<{ detail: unknown }>(
        `SELECT detail FROM verdicts WHERE submission_id = $1`,
        [twinId],
      );
      expect(twinDetail.rows[0]!.detail).toEqual(first.rows[0]!.detail);
    }, 120_000);

    it("裁决完成审计发射:verdict_completed 行落库(detail 携 submissionId 与 11 值字面)", async () => {
      const rows = await pool!.query<{ user_id: string; session_id: string | null; detail: Record<string, unknown> }>(
        `SELECT user_id, session_id, detail FROM audit_log
         WHERE tenant_id = $1 AND kind = 'verdict_completed' AND detail->>'submissionId' = $2`,
        [tenantId, firstSubmissionId!],
      );
      expect(rows.rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.rows[0]!.user_id).toBe("verifier");
      expect(rows.rows[0]!.detail).toMatchObject({
        submissionId: firstSubmissionId,
        verdict: "wrong_answer",
      });
    }, 30_000);

    it("篡改动作日志(log_digest 复算不符)→ run failed 拒裁,零 verdicts(D-API-85 绑定锚)", async () => {
      const tamperTenant = `tamper-digest-${runSuffix}`;
      const reference = fabricatedReference(challengeId);
      const replay = reference["replay"] as { actionLog: string };
      // 登记摘要 = 另一份内容(取回复算不符 = 篡改检测锚)。
      const submissionId = await seedSubmission({
        tenantId: tamperTenant,
        reference,
        logDigest: sha256Hex(Buffer.from(`different-than-${replay.actionLog}`)),
      });
      // 重试链(默认 3 次)逐次失败后恒为 failed,查询面不产生 verdicts。
      const deadline = Date.now() + 120_000;
      let states = await runStates(submissionId);
      while (Date.now() < deadline && states.pending > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        states = await runStates(submissionId);
      }
      expect(states.pending).toBe(0);
      expect(states.statuses.filter((status) => status === "failed").length).toBeGreaterThanOrEqual(1);
      const verdict = await pollVerdict(submissionId, 0);
      expect(verdict).toBeNull();
      // 审计发射(WP-62 / D-API-95):拒裁安全事实 = verdict_rejected,方向码
      // 随 detail 落账(零秘密载荷)。
      const rejected = await pool!.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM audit_log
         WHERE tenant_id = $1 AND kind = 'verdict_rejected' AND detail->>'submissionId' = $2`,
        [tamperTenant, submissionId],
      );
      expect(rejected.rows.length).toBeGreaterThanOrEqual(1);
      expect(rejected.rows[0]!.detail).toMatchObject({ direction: "log_digest_mismatch" });
    }, 150_000);

    it("六记录项缺项(replay 材料缺席的旧形态引用)→ 裁决无效 challenge_invalid", async () => {
      const tamperTenant = `tamper-records-${runSuffix}`;
      const reference = fabricatedReference(challengeId);
      delete reference["replay"];
      const submissionId = await seedSubmission({
        tenantId: tamperTenant,
        reference,
        logDigest: sha256Hex(Buffer.from("no-replay-material")),
      });
      const verdict = await pollVerdict(submissionId, 90_000);
      expect(verdict).toBe("challenge_invalid");
    }, 120_000);

    it("双包哈希与登记值不符(对象被替换)→ run failed 拒裁,零 verdicts", async () => {
      const tamperTenant = `tamper-hash-${runSuffix}`;
      const tamperChallengeId = `chal-tamper-${runSuffix}`;
      // 正常登记(真实验签;对象字节与登记摘要一致)……
      const privateBundle = Buffer.from(JSON.stringify(lifecycleBundle(tamperChallengeId)), "utf8");
      const publicDescriptor = Buffer.from(JSON.stringify(lifecycleDescriptor(tamperChallengeId)), "utf8");
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const signature = cryptoSign(
        null,
        Buffer.from(
          registrationSignatureBasis({
            challengeId: tamperChallengeId,
            contentVersion,
            vmProfileVersion: "1.0.0",
            privateBundleSha256: sha256Hex(privateBundle),
            publicDescriptorSha256: sha256Hex(publicDescriptor),
          }),
          "utf8",
        ),
        privateKey,
      ).toString("base64");
      const registry = new PostgresChallengeRegistry(pool!);
      await new ChallengeRegistrar({ bundles: registeredBundles!, registry, signingPublicKey: publicKey }).register({
        tenantId: tamperTenant,
        challengeId: tamperChallengeId,
        contentVersion,
        vmProfileVersion: "1.0.0",
        privateBundle,
        publicDescriptor,
        signature,
      });
      // ……随后对象被替换(登记摘要不再匹配桶内字节)。
      const tampered = Buffer.from(
        JSON.stringify(lifecycleBundle(tamperChallengeId)).replace('"1.0.0"', '"9.9.9"'),
        "utf8",
      );
      await registeredBundles!.putPrivate(tamperChallengeId, contentVersion, tampered);

      const reference = fabricatedReference(tamperChallengeId);
      const replay = reference["replay"] as { actionLog: string };
      const submissionId = await seedSubmission({
        tenantId: tamperTenant,
        reference,
        logDigest: sha256Hex(Buffer.from(replay.actionLog, "utf8")),
      });
      const deadline = Date.now() + 120_000;
      let states = await runStates(submissionId);
      while (Date.now() < deadline && states.pending > 0) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        states = await runStates(submissionId);
      }
      expect(states.pending).toBe(0);
      expect(states.statuses.filter((status) => status === "failed").length).toBeGreaterThanOrEqual(1);
      expect(await pollVerdict(submissionId, 0)).toBeNull();
    }, 150_000);

    // ── 阶段六 WP-63:裁决呈现路由、全链路演示与 ZR-T4 verifier 级复锚──────
    // (D-API-83 / D-API-84 / D-API-97;呈现链路 = session-api 读裁决域)

    /** GET 请求录制面(与 postJson 同 recorder;响应体进跨域机检语料)。 */
    async function getJson(
      recorder: TrafficRecorder,
      path: string,
      cookie?: string,
    ): Promise<{ status: number; body: unknown; bodyText: string }> {
      const response = await fetch(`${BASE_URL}${path}`, {
        method: "GET",
        headers: cookie === undefined ? {} : { cookie },
      });
      const bodyText = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText) as unknown;
      } catch {
        parsed = bodyText;
      }
      recorder.recordHttp(parsed);
      return { status: response.status, body: parsed, bodyText };
    }

    let verdictSession: { sessionId: string; cookie: string } | null = null;

    it("裁决呈现全链路演示:submit → GET pending(恒定三字段)→ GET verdicted(五字段契约)", async () => {
      // 1. 新会话 + REST submit(浏览器面同形:Cookie 呈递,Path=/ 覆盖两族)。
      const embedSessionIdW = embedSessionId();
      const embedW = await postJson(recorder, "/auth/embed-tokens", {
        tenantId, userId, challengeId, challengeVersion: contentVersion,
        embedSessionId: embedSessionIdW,
      }, { bearer: HOST_BACKEND_TOKEN });
      const tokenW = (embedW.body as { embedToken: string }).embedToken;
      const createdW = await postJson(recorder, "/sessions", {
        command: "create_session",
        protocolVersion: 1,
        payload: { challengeId, challengeVersion: contentVersion, embedSessionId: embedSessionIdW, embedToken: tokenW },
      });
      expect(createdW.status).toBe(201);
      const cookieW = credentialFromSetCookie(createdW.setCookie);
      const sessionIdW = (createdW.body as { payload: { sessionId: string } }).payload.sessionId;
      verdictSession = { sessionId: sessionIdW, cookie: cookieW };

      const submitted = await postJson(recorder, "/sessions/submissions", {
        command: "submit", protocolVersion: 1, payload: { sessionId: sessionIdW },
      }, { cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookieW}` });
      expect(submitted.status).toBe(200);
      const { submissionId, revision } = (submitted.body as { payload: { submissionId: string; revision: number } }).payload;

      // 2. submit 后首次查询 = 恒定三字段 pending(零进度 / 零队列位置)。
      const first = await getJson(recorder, `/verdicts/${submissionId}`, `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookieW}`);
      expect(first.status).toBe(200);
      const pendingBody = { submissionId, revision, status: "pending" };
      expect(first.bodyText).toBe(JSON.stringify(pendingBody));
      // 未决期内重复重询字节确定(I-4)。
      const second = await getJson(recorder, `/verdicts/${submissionId}`, `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookieW}`);
      expect(second.bodyText).toBe(first.bodyText);

      // 3. 轮询至 verdicted(确定性间隔;429 冻结形态按退避等待——客户端
      //    镜像重询节奏,零重试风暴)。
      const deadline = Date.now() + 120_000;
      let final: { status: number; body: unknown; bodyText: string } | null = null;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        const attempt = await getJson(recorder, `/verdicts/${submissionId}`, `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookieW}`);
        if (attempt.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          continue;
        }
        expect(attempt.status).toBe(200);
        const payload = attempt.body as { status: string; verdict?: string };
        if (payload.status === "verdicted") {
          final = attempt;
          break;
        }
        expect(payload).toEqual(pendingBody);
      }
      expect(final).not.toBeNull();
      const verdicted = final!.body as {
        submissionId: string; revision: number; status: string; verdict: string; decidedAt: number;
      };
      // 五字段契约形态(D-API-83):11 值字面 + epoch 秒落库时刻。
      expect(Object.keys(verdicted).sort()).toEqual(["decidedAt", "revision", "status", "submissionId", "verdict"]);
      expect(verdicted.submissionId).toBe(submissionId);
      expect(verdicted.revision).toBe(revision);
      expect(verdicted.verdict).toBe("wrong_answer");
      expect(Number.isInteger(verdicted.decidedAt)).toBe(true);
      expect(verdicted.decidedAt).toBeGreaterThan(0);
      // 载荷机检(ZR-B9 / B2 语料延伸到呈现响应面,D-API-61 录制面;
      // 全捕获扫描的专项复核:裁决载荷零命中)。
      const verdictHits = scanCrossDomainPayloads([final!.body]);
      const hitsText = formatCrossDomainHits(verdictHits).join("\n");
      expect(verdictHits, `裁决载荷机检命中:\n${hitsText}`).toEqual([]);
    }, 150_000);

    it("呈现路由 404 同形矩阵:不存在 / 跨会话 / 参数字符集违规同形(容器拓扑实跑)", async () => {
      const cookieW = `${SESSION_CREDENTIAL_COOKIE_NAME}=${verdictSession!.cookie}`;
      // 不存在。
      const missing = await getJson(recorder, "/verdicts/00000000-0000-4000-8000-000000000000", cookieW);
      expect(missing.status).toBe(404);
      expect(missing.bodyText).toBe(JSON.stringify({ code: "invalid_input_format", message: "resource not found" }));
      // 参数字符集违规(路径穿越形态)与不存在同响应(防枚举)。
      const malformed = await getJson(recorder, "/verdicts/not-a%2Fuuid", cookieW);
      expect(malformed.status).toBe(404);
      expect(malformed.bodyText).toBe(missing.bodyText);

      // 跨会话:同租户另一会话的提交行,用本会话凭证查询 → 404 同形。
      const embedSessionIdX = embedSessionId();
      const embedX = await postJson(recorder, "/auth/embed-tokens", {
        tenantId, userId, challengeId, challengeVersion: contentVersion,
        embedSessionId: embedSessionIdX,
      }, { bearer: HOST_BACKEND_TOKEN });
      const tokenX = (embedX.body as { embedToken: string }).embedToken;
      const createdX = await postJson(recorder, "/sessions", {
        command: "create_session",
        protocolVersion: 1,
        payload: { challengeId, challengeVersion: contentVersion, embedSessionId: embedSessionIdX, embedToken: tokenX },
      });
      const sessionIdX = (createdX.body as { payload: { sessionId: string } }).payload.sessionId;
      const cookieX = credentialFromSetCookie(createdX.setCookie);
      const submittedX = await postJson(recorder, "/sessions/submissions", {
        command: "submit", protocolVersion: 1, payload: { sessionId: sessionIdX },
      }, { cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookieX}` });
      const submissionIdX = (submittedX.body as { payload: { submissionId: string } }).payload.submissionId;

      const cross = await getJson(recorder, `/verdicts/${submissionIdX}`, cookieW);
      expect(cross.status).toBe(404);
      expect(cross.bodyText).toBe(missing.bodyText);
      // 归属凭证查询同一提交行 → 200(定位链正向)。
      const own = await getJson(recorder, `/verdicts/${submissionIdX}`, `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookieX}`);
      expect(own.status).toBe(200);
      expect((own.body as { status: string }).status).toBe("pending");
    }, 60_000);

    it("重询限流:窗口内触顶 → 429 冻结形态逐字节(D-API-84;独立用户计量域)", async () => {
      // 独立 user 维度(rate:{tenant}:{user}:verdict),不挤占其他用例预算。
      const rlUser = "user-compose-rl";
      const embedSessionIdRl = embedSessionId();
      const embedRl = await postJson(recorder, "/auth/embed-tokens", {
        tenantId, userId: rlUser, challengeId, challengeVersion: contentVersion,
        embedSessionId: embedSessionIdRl,
      }, { bearer: HOST_BACKEND_TOKEN });
      const tokenRl = (embedRl.body as { embedToken: string }).embedToken;
      const createdRl = await postJson(recorder, "/sessions", {
        command: "create_session",
        protocolVersion: 1,
        payload: { challengeId, challengeVersion: contentVersion, embedSessionId: embedSessionIdRl, embedToken: tokenRl },
      });
      const cookieRl = credentialFromSetCookie(createdRl.setCookie);

      // 触顶前 30 次放行(查询不存在的 id = 404,同样计量);第 31 次 429。
      let firstReject: { status: number; bodyText: string } | null = null;
      for (let index = 0; index < 31; index += 1) {
        const attempt = await getJson(
          recorder,
          "/verdicts/11111111-1111-4000-8000-111111111111",
          `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookieRl}`,
        );
        if (attempt.status === 429) {
          firstReject = attempt;
          break;
        }
        expect([200, 404]).toContain(attempt.status);
      }
      expect(firstReject).not.toBeNull();
      expect(firstReject!.status).toBe(429);
      expect(firstReject!.bodyText).toBe(JSON.stringify({ code: "budget_exhausted", message: "rate limit exceeded" }));
      // 计数不回退:窗口内继续触顶(确定性同形,I-4)。
      const again = await getJson(
        recorder,
        "/verdicts/11111111-1111-4000-8000-111111111111",
        `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookieRl}`,
      );
      expect(again.status).toBe(429);
      expect(again.bodyText).toBe(firstReject!.bodyText);
    }, 60_000);

    // ── 阶段六 WP-67:裁决边界攻击面(9.2 第四边界;verifier_runs 推进不可达)──

    it("客户端全表面重询风暴不可推进 verifier_runs:verifier 停机窗口内 run 恒 pending、零 verdicts;重启后裁决正常落库", async () => {
      // 攻击面设定:选手唯一的裁决链客户端表面 = GET /verdicts 族(认证 /
      // 限流闸后)。状态机推进(pending → running → completed / failed)是
      // verifier 信任域 4 经 SKIP LOCKED 认领的独占面(D-API-85)——本用例
      // 在 verifier 停机窗口(认领面物理缺席)做客户端风暴,直接断言 PG
      // 侧 run 行零迁移、verdicts 零写入;随后重启证明队列未被风暴腐化。
      await verifier.stop();
      const wp67User = "user-compose-wp67";
      const embedSessionIdS = embedSessionId();
      const embedS = await postJson(recorder, "/auth/embed-tokens", {
        tenantId, userId: wp67User, challengeId, challengeVersion: contentVersion,
        embedSessionId: embedSessionIdS,
      }, { bearer: HOST_BACKEND_TOKEN });
      const tokenS = (embedS.body as { embedToken: string }).embedToken;
      const createdS = await postJson(recorder, "/sessions", {
        command: "create_session",
        protocolVersion: 1,
        payload: { challengeId, challengeVersion: contentVersion, embedSessionId: embedSessionIdS, embedToken: tokenS },
      });
      expect(createdS.status).toBe(201);
      const cookieS = credentialFromSetCookie(createdS.setCookie);
      const sessionIdS = (createdS.body as { payload: { sessionId: string } }).payload.sessionId;
      const submittedS = await postJson(recorder, "/sessions/submissions", {
        command: "submit", protocolVersion: 1, payload: { sessionId: sessionIdS },
      }, { cookie: `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookieS}` });
      expect(submittedS.status).toBe(200);
      const submissionIdS = (submittedS.body as { payload: { submissionId: string } }).payload.submissionId;
      const revisionS = (submittedS.body as { payload: { revision: number } }).payload.revision;

      // 客户端风暴:归属重询(200 pending / 触顶 429)+ 不存在与字符集违规
      // 404 + 无凭证 401,混合 40 次(限流 30/min ⇒ 后段 429 是攻击面的一部分)。
      let pendingBytes: string | null = null;
      const cookieHeader = `${SESSION_CREDENTIAL_COOKIE_NAME}=${cookieS}`;
      for (let index = 0; index < 34; index += 1) {
        const attempt = await getJson(recorder, `/verdicts/${submissionIdS}`, cookieHeader);
        expect([200, 429]).toContain(attempt.status);
        if (attempt.status === 200) {
          const expected = JSON.stringify({ submissionId: submissionIdS, revision: revisionS, status: "pending" });
          expect(attempt.bodyText).toBe(expected);
          pendingBytes = attempt.bodyText;
        } else {
          expect(attempt.bodyText).toBe(JSON.stringify({ code: "budget_exhausted", message: "rate limit exceeded" }));
        }
      }
      expect(pendingBytes).not.toBeNull();
      const missing = await getJson(recorder, "/verdicts/22222222-2222-4000-8000-222222222222", cookieHeader);
      expect([404, 429]).toContain(missing.status);
      if (missing.status === 404) {
        expect(missing.bodyText).toBe(JSON.stringify({ code: "invalid_input_format", message: "resource not found" }));
      }
      const malformed = await fetch(`${BASE_URL}/verdicts/not-a%2Fuuid`, { headers: { cookie: cookieHeader } });
      if (malformed.status !== 429) {
        expect(malformed.status).toBe(404);
      }
      const anonymous = await fetch(`${BASE_URL}/verdicts/${submissionIdS}`);
      expect([401, 429]).toContain(anonymous.status);

      // PG 侧断言:风暴后 run 行状态机零迁移(全部 pending)、裁决零落库。
      const runsAfter = await pool!.query<{ status: string }>(
        `SELECT status FROM verifier_runs WHERE submission_id = $1`,
        [submissionIdS],
      );
      expect(runsAfter.rows.length).toBeGreaterThanOrEqual(1);
      expect(runsAfter.rows.map((row) => row.status)).toEqual(
        runsAfter.rows.map(() => "pending"),
      );
      const verdictsAfter = await pool!.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM verdicts WHERE submission_id = $1`,
        [submissionIdS],
      );
      expect(Number(verdictsAfter.rows[0]!.count)).toBe(0);

      // 重启 verifier:同一 pending 行被认领,裁决正常落库(风暴未腐化队列)。
      await verifier.restart();
      const verdict = await pollVerdict(submissionIdS, 90_000);
      expect(verdict).toBe("wrong_answer");
      const runsFinal = await pool!.query<{ status: string }>(
        `SELECT status FROM verifier_runs WHERE submission_id = $1`,
        [submissionIdS],
      );
      expect(runsFinal.rows.map((row) => row.status).at(-1)).toBe("completed");

      // 收尾:显式 close_session 释放并发会话预算槽位(租户预算 8;不释放
      // 会让本套件后段的审计落库用例撞 concurrent budget 提前闸)。
      const closed = await postJson(recorder, "/sessions/close", {
        command: "close_session", protocolVersion: 1, payload: { sessionId: sessionIdS },
      }, { cookie: cookieHeader });
      expect(closed.status).toBe(200);
    }, 180_000);

    it("ZR-T4 verifier 级复锚:伪造 won 成功标志,verifier 独立重放裁决与未伪造会话一致", async () => {
      // 诚实会话(firstSubmissionId,交互期未伪造)的引用与裁决;伪造 =
      // 提交行 public_status = 'won'(客户端成功标志;D-API-62 篡改矩阵
      // 延伸到裁决面)。verifier 唯一输入 = 规范化动作日志引用,公开状态
      // 零参与——同日志 ⇒ 同裁决,伪造成功标志不改成绩。
      const honest = await pool!.query<{ reference: unknown; verdict: string; log_digest: string | null; public_status: string }>(
        `SELECT s.reference, v.verdict, r.log_digest, s.public_status
         FROM submissions s
         JOIN verdicts v ON v.submission_id = s.id
         LEFT JOIN LATERAL (
           SELECT log_digest FROM verifier_runs
           WHERE submission_id = s.id ORDER BY created_at DESC LIMIT 1
         ) r ON TRUE
         WHERE s.id = $1`,
        [firstSubmissionId!],
      );
      expect(honest.rows[0]).toBeDefined();
      const honestRow = honest.rows[0]!;

      const forged = await pool!.query<{ id: string }>(
        `INSERT INTO submissions (tenant_id, session_id, revision, public_status, reference)
         SELECT tenant_id, session_id || '-zrt4-forged', revision, 'won', reference
         FROM submissions WHERE id = $1 RETURNING id`,
        [firstSubmissionId!],
      );
      const forgedId = forged.rows[0]!.id;
      await pool!.query(
        `INSERT INTO verifier_runs (tenant_id, submission_id, status, log_digest)
         VALUES ($1, $2, 'pending', $3)`,
        [tenantId, forgedId, honestRow.log_digest],
      );
      // 独立 verify 进程对同一日志重放:裁决与未伪造会话一致(ZR-T4)。
      const forgedVerdict = await pollVerdict(forgedId, 90_000);
      expect(forgedVerdict).toBe(honestRow.verdict);
      // 幂等复查:单一 verdicts 行(005 唯一索引)。
      const count = await pool!.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM verdicts WHERE submission_id = $1`,
        [forgedId],
      );
      expect(Number(count.rows[0]!.count)).toBe(1);
    }, 120_000);

    // ── 阶段六 WP-64:审计落库、归档往返与角色治理(D-API-90 ~ 93)──────────

    /** 按角色派生 PG 连接串(替换 userinfo;主机 / 端口 / 库不变)。 */
    function withRole(url: string, user: string, password: string): string {
      const parsed = new URL(url);
      parsed.username = user;
      parsed.password = password;
      return parsed.toString();
    }

    /** 尝试以给定角色连接;失败(角色不存在 / 凭据不符)返回 null。 */
    async function tryConnect(url: string): Promise<Pool | null> {
      try {
        return await createPostgresPool(url, 1);
      } catch {
        return null;
      }
    }

    it("审计 PG 落库(真实进程):create_session 链路的审计事件经 PgAuditSink 入 audit_log", async () => {
      const auditEmbedSessionId = embedSessionId();
      const auditIssuance = await postJson(recorder, "/auth/embed-tokens", {
        tenantId, userId, challengeId, challengeVersion: contentVersion,
        embedSessionId: auditEmbedSessionId,
      }, { bearer: HOST_BACKEND_TOKEN });
      expect(auditIssuance.status).toBe(201);
      const auditToken = (auditIssuance.body as { embedToken: string }).embedToken;
      const auditCreated = await postJson(recorder, "/sessions", {
        command: "create_session",
        protocolVersion: 1,
        payload: { challengeId, challengeVersion: contentVersion, embedSessionId: auditEmbedSessionId, embedToken: auditToken },
      });
      expect(auditCreated.status).toBe(201);
      const auditSessionId = (auditCreated.body as { payload: { sessionId: string } }).payload.sessionId;

      // 审计行在 PG(生产装配 = PgAuditSink,D-API-91;kind ⊆ 十值封闭集合)。
      // embed_token_consumed 在会话存在之前发生(嵌入协议 §六消费序),事件本就
      // 无 sessionId——以 tenant + detail.embedSessionId(每运行唯一)定位。
      const consumed = await pool!.query<{ kind: string }>(
        `SELECT kind FROM audit_log
         WHERE tenant_id = $1 AND kind = 'embed_token_consumed' AND detail->>'embedSessionId' = $2`,
        [tenantId, auditEmbedSessionId],
      );
      expect(consumed.rows.map((row) => row.kind)).toEqual(["embed_token_consumed"]);
      const rows = await pool!.query<{ kind: string }>(
        `SELECT kind FROM audit_log WHERE session_id = $1 ORDER BY id`,
        [auditSessionId],
      );
      const kinds = rows.rows.map((row) => row.kind);
      expect(kinds).toContain("session_credential_issued");
      expect(kinds).toContain("create_session");
      for (const kind of [...kinds, "embed_token_consumed"]) {
        expect(AUDIT_EVENT_KINDS).toContain(kind);
      }
    }, 60_000);

    it("审计归档往返(落库 → 归档 → 校验):SHA-256 清单复算一致;批 ID 幂等零双份(D-API-92)", async () => {
      // 1. 落库:专用租户经 PgAuditSink(与真实进程同一实现)直落 4 行。
      const auditTenant = `audit-${runSuffix}`;
      const auditSink = new PgAuditSink(pool!);
      for (let index = 0; index < 4; index += 1) {
        await auditSink.append({
          kind: index % 2 === 0 ? "create_session" : "submit",
          at: Date.now(),
          actor: { tenantId: auditTenant, userId: "user-audit" },
          sessionId: `sess-audit-${index}`,
          detail: { sequence: index },
        });
      }
      const dbRows = await pool!.query<{ kind: string; session_id: string | null; detail: unknown }>(
        `SELECT kind, session_id, detail FROM audit_log WHERE tenant_id = $1 ORDER BY id`,
        [auditTenant],
      );
      expect(dbRows.rows).toHaveLength(4);

      // 2. 归档:时钟前推 40 天(窗口 = now - 30 天 → 覆盖刚落库行);数据 + 清单双对象。
      const archiveMinio = await createMinioClient({
        endpoint: IT_CONFIG.minioEndpoint,
        port: IT_CONFIG.minioPort,
        accessKey: IT_CONFIG.minioAccessKey,
        secretKey: IT_CONFIG.minioSecretKey,
      });
      const job = new AuditArchiveJob({
        pool: pool!,
        minio: archiveMinio,
        bucket: DEFAULT_AUDIT_BUCKET,
        batchSize: 100000,
        retentionDays: 30,
        now: () => Date.now() + 40 * 86_400_000,
      });
      const first = await job.runOnce();
      expect(first.status).toBe("completed");
      const batch = first as {
        batchId: string;
        rowCount: number;
        dataObjectName: string;
        manifestObjectName: string;
        dataSha256: string;
      };
      expect(batch.rowCount).toBeGreaterThanOrEqual(4);

      // 3. 校验:数据对象字节 SHA-256 复算 = 清单摘要 = 台账摘要;本租户 4 行
      //    全部在归档行内(事件同构投影,落库内容零失真)。
      const dataBytes = Buffer.from(await collectStream(
        await archiveMinio.getObject(DEFAULT_AUDIT_BUCKET, batch.dataObjectName),
      ));
      expect(createHash("sha256").update(dataBytes).digest("hex")).toBe(batch.dataSha256);
      const manifest = JSON.parse(Buffer.from(await collectStream(
        await archiveMinio.getObject(DEFAULT_AUDIT_BUCKET, batch.manifestObjectName),
      )).toString("utf8")) as { dataSha256: string; batchId: string; rowCount: number };
      expect(manifest.dataSha256).toBe(batch.dataSha256);
      expect(manifest.batchId).toBe(batch.batchId);
      const ledgerRow = await pool!.query<{ data_sha256: string }>(
        `SELECT data_sha256 FROM audit_archive_batches WHERE batch_id = $1`,
        [batch.batchId],
      );
      expect(ledgerRow.rows[0]!.data_sha256).toBe(batch.dataSha256);
      const archivedLines = dataBytes.toString("utf8").split("\n")
        .map((line) => JSON.parse(line) as {
          actor: { tenantId: string; userId: string };
          kind: string;
          sessionId: string | null;
          detail: unknown;
        })
        .filter((row) => row.actor.tenantId === auditTenant);
      expect(archivedLines).toHaveLength(4);
      expect(archivedLines.map((row) => row.kind)).toEqual(dbRows.rows.map((row) => row.kind));
      expect(archivedLines.map((row) => row.sessionId)).toEqual(dbRows.rows.map((row) => row.session_id));
      expect(archivedLines.map((row) => row.detail)).toEqual(dbRows.rows.map((row) => row.detail));

      // 4. 批 ID 幂等:游标已推进 → 重跑 idle;本批对象字节与台账行零变化
      //    (重复归档不产生双份)。
      expect(await job.runOnce()).toEqual({ status: "idle" });
      const objectAgain = await archiveMinio.getObject(DEFAULT_AUDIT_BUCKET, batch.dataObjectName);
      expect(
        createHash("sha256").update(Buffer.from(await collectStream(objectAgain))).digest("hex"),
      ).toBe(batch.dataSha256);
      const ledgerCount = await pool!.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_archive_batches WHERE batch_id = $1`,
        [batch.batchId],
      );
      expect(Number(ledgerCount.rows[0]!.count)).toBe(1);
    }, 120_000);

    it("角色治理红灯(D-API-93):session_app 对 audit_log 零 UPDATE/DELETE、禁触发器被拒;verifier 仅 INSERT 预留", async (ctx) => {
      const sessionApp = await tryConnect(withRole(IT_CONFIG.postgresUrl, "session_app", "session-app-dev"));
      const verifierRole = await tryConnect(withRole(IT_CONFIG.postgresUrl, "verifier", "verifier-dev"));
      if (sessionApp === null || verifierRole === null) {
        // host 降级形态:init 服务未运行,角色不存在——如实登记(CI 完整容器拓扑实跑)。
        ctx.skip();
        return;
      }
      try {
        const auditTenant = `roles-${runSuffix}`;
        // 行级租户政策(007 迁移 / D-API-101):应用角色 INSERT 受租户上下文
        // 约束(WITH CHECK)——probe 连接以会话级 set_config 注入(测试形态;
        // 生产为连接层 TenantScope 逐事务 SET LOCAL)。
        await sessionApp.query(`SELECT set_config('app.tenant_id', $1, false)`, [auditTenant]);
        // session_app:INSERT 受理(应用角色的合法写入面,行租户 = 注入租户)。
        await sessionApp.query(
          `INSERT INTO audit_log (kind, at, tenant_id, user_id) VALUES ('create_session', now(), $1, 'role-probe')`,
          [auditTenant],
        );
        // UPDATE / DELETE 被 REVOKE 拒(权限层);即便绕过权限亦被库层触发器拒(双层)。
        await expect(
          sessionApp.query(`UPDATE audit_log SET user_id = 'tampered' WHERE tenant_id = $1`, [auditTenant]),
        ).rejects.toThrow(/permission denied|append-only/);
        await expect(
          sessionApp.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [auditTenant]),
        ).rejects.toThrow(/permission denied|append-only/);
        // 触发器禁用路径被拒(非属主角色不可 DISABLE TRIGGER;第二层治理第三红灯)。
        await expect(
          sessionApp.query(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`),
        ).rejects.toThrow(/must be owner of table|permission denied/);

        // verifier:审计发射面预留(WP-62,D-API-90/93)——INSERT(verdict_completed)
        // 受理;UPDATE / DELETE 拒;DISABLE TRIGGER 拒。
        await verifierRole.query(
          `INSERT INTO audit_log (kind, at, tenant_id, user_id, detail)
           VALUES ('verdict_completed', now(), $1, 'verifier', $2::jsonb)`,
          [`verifier-${auditTenant}`, JSON.stringify({ submissionId: "sub-role-probe", verdict: "success" })],
        );
        await expect(
          verifierRole.query(`UPDATE audit_log SET user_id = 'x' WHERE tenant_id = $1`, [`verifier-${auditTenant}`]),
        ).rejects.toThrow(/permission denied|append-only/);
        await expect(
          verifierRole.query(`DELETE FROM audit_log WHERE tenant_id = $1`, [`verifier-${auditTenant}`]),
        ).rejects.toThrow(/permission denied|append-only/);
      } finally {
        await sessionApp.end().catch(() => undefined);
        await verifierRole.end().catch(() => undefined);
      }
    }, 60_000);

    it("行级租户策略红灯(D-API-101):session_app 跨租户零行 / fail-closed;verifier 跨租户可读、零写越权", async (ctx) => {
      const sessionApp = await tryConnect(withRole(IT_CONFIG.postgresUrl, "session_app", "session-app-dev"));
      const verifierRole = await tryConnect(withRole(IT_CONFIG.postgresUrl, "verifier", "verifier-dev"));
      if (sessionApp === null || verifierRole === null) {
        // host 降级形态:init 服务未运行,角色不存在——如实登记(CI 完整容器拓扑实跑;
        // 行级红灯全矩阵由 test/persistence/row-security.integration.test.ts 双拓扑承载)。
        ctx.skip();
        return;
      }
      try {
        const probeTenant = `rls-${runSuffix}`;
        const otherTenant = `rls-other-${runSuffix}`;
        // 播种双租户提交行(admin 管理面连接;行级断言只经角色连接承载)。
        const seeded = await pool!.query<{ id: string; tenant_id: string }>(
          `INSERT INTO submissions (tenant_id, session_id, revision, public_status, reference)
           SELECT t.tenant, 'sess-rls-' || t.tenant, 1, 'running', '{}'::jsonb
           FROM (VALUES ($1::text), ($2::text)) AS t(tenant)
           RETURNING id, tenant_id`,
          [probeTenant, otherTenant],
        );
        expect(seeded.rows).toHaveLength(2);
        // 行级第一闸:session_app 注入本租户上下文后,跨租户提交行零可见
        // (与不存在同形态);未注入上下文 = 零可见(fail-closed)。
        await sessionApp.query(`SELECT set_config('app.tenant_id', $1, false)`, [probeTenant]);
        const own = await sessionApp.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM submissions WHERE tenant_id = $1`, [probeTenant],
        );
        expect(Number(own.rows[0]!.n)).toBe(1);
        const cross = await sessionApp.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM submissions WHERE tenant_id = $1`, [otherTenant],
        );
        expect(Number(cross.rows[0]!.n)).toBe(0);
        // verifier(信任域 4):跨租户可读(队列消费设计内,政策按角色分立)。
        const verifierView = await verifierRole.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM submissions WHERE tenant_id = ANY($1::text[])`,
          [[probeTenant, otherTenant]],
        );
        expect(Number(verifierView.rows[0]!.n)).toBe(2);
        // verifier 零写越权:政策放行不等于授权(submissions 零 INSERT / 零 UPDATE)。
        await expect(
          verifierRole.query(
            `INSERT INTO submissions (tenant_id, session_id, revision, public_status, reference)
             VALUES ($1, 'sess-probe', 1, 'running', '{}'::jsonb)`,
            [probeTenant],
          ),
        ).rejects.toThrow(/permission denied/i);
        await expect(
          verifierRole.query(`UPDATE submissions SET public_status = 'won' WHERE tenant_id = $1`, [probeTenant]),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await sessionApp.end().catch(() => undefined);
        await verifierRole.end().catch(() => undefined);
      }
    }, 60_000);
  },
);

/** 读取流字节(归档对象校验用)。 */
async function collectStream(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

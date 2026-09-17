/**
 * 宿主成绩同步只读路由红灯矩阵(中期 M3 WP-78;D-API-122 ~ D-API-126):
 * `GET /host/scores` 的实现期红灯语料。
 *
 * 矩阵逐条:
 *  - 认证 = 宿主凭证(D-API-122):缺失 / 畸形 / 错误一律统一 401 冻结形态
 *    (`invalid_input_format` / "authentication failed",沿 D-API-14 零原因
 *    差异);**会话凭证不得通行**(宿主面与会话面凭证域严格分离);
 *  - 租户绑定(O-MP-6 / D-API-124):白名单空 / 缺失 ⇒ 面整体 404;子选
 *    `tenantId` 不在绑定集合内 ⇒ 与"不存在"同形 404(**与白名单空态的
 *    404 逐字节一致**);查询参数**不能**决定租户(集合外租户结构性不可达);
 *  - 查询参数白名单(D-API-124):未登记参数 / 畸形 cursor / 畸形或超限
 *    limit ⇒ 400 冻结形态(超限**不钳制**,确定性拒绝);
 *  - 批量上限(D-API-125):limit ≤ config.hostScoresBatch;上限内分批 +
 *    keyset 游标严格前进 + 末页 `nextCursor = null`;
 *  - 载荷红线(D-API-123):信封恰两键、记录恰七键;`detail` / `reference` /
 *    隐藏测试命中 / 内部堆栈 / `tenantId` 在响应字节中零出现;
 *  - 限流(D-API-125):`rate:{锚租户}:host_scores` 固定窗口触顶 → 429 逐字节
 *    沿 D-API-50 频率类冻结形态;**子选不放大预算**(交替 tenantId 仍触顶);
 *  - 终态(D-API-123):空批 = 合法终态(200 + items 空 + nextCursor null)。
 */

import { describe, expect, it } from "vitest";
import { HostScoresResponseSchema } from "@stackmaster/protocol";

import {
  TEST_HOST_BACKEND_TOKEN,
  TEST_TENANT_BETA_ID,
  TEST_TENANT_ID,
  buildSessionTestRig,
  type SessionTestRig,
} from "./helpers/session-rig.js";

/** 冻结呈现面字节(逐字节断言锚;D-API-32 / 14 / 50)。 */
const AUTH_FAILED_BODY = JSON.stringify({
  code: "invalid_input_format",
  message: "authentication failed",
});
const NOT_FOUND_BODY = JSON.stringify({
  code: "invalid_input_format",
  message: "resource not found",
});
const VALIDATION_BODY = JSON.stringify({
  code: "invalid_input_format",
  message: "invalid request",
});
const RATE_LIMIT_BODY = JSON.stringify({
  code: "budget_exhausted",
  message: "rate limit exceeded",
});

/** 宿主凭证呈递头(服务端间 bearer;非浏览器向量,免 CSRF 闸)。 */
function hostHeaders(token: string = TEST_HOST_BACKEND_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** 确定性 UUID 语料(规范形态、字典序随序号单调;keyset 序即此处顺序)。 */
function scoreId(ordinal: number): string {
  return `00000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`;
}

interface SeedScoreInput {
  readonly ordinal: number;
  readonly tenantId?: string;
  readonly verdict?: string;
  readonly decidedAt?: number;
  readonly challengeId?: string;
  readonly challengeVersion?: string;
}

/** 向内存同构端口 seed 一条成绩(生产形态的记录由 verifier 裁决落库提供)。 */
function seedScore(rig: SessionTestRig, input: SeedScoreInput): string {
  const id = scoreId(input.ordinal);
  rig.hostScores.seed({
    id,
    tenantId: input.tenantId ?? TEST_TENANT_ID,
    submissionId: `10000000-0000-4000-8000-${input.ordinal.toString().padStart(12, "0")}`,
    sessionId: `sess-host-${input.ordinal}`,
    challengeId: input.challengeId ?? "chal-stack-escape",
    challengeVersion: input.challengeVersion ?? "1.2.3",
    verdict: input.verdict ?? "success",
    decidedAtEpochSeconds: input.decidedAt ?? 1789200000 + input.ordinal,
  });
  return id;
}

/** 带宿主成绩白名单的 rig(缺省 rig 的白名单为空 ⇒ 面整体 404)。 */
async function buildHostRig(env: Readonly<Record<string, string>> = {}): Promise<SessionTestRig> {
  return buildSessionTestRig({
    env: {
      SESSION_API_HOST_TENANTS: `${TEST_TENANT_ID},${TEST_TENANT_BETA_ID}`,
      ...env,
    },
  });
}

async function getScores(
  rig: SessionTestRig,
  query: string = "",
  headers: Record<string, string> = hostHeaders(),
) {
  return rig.app.inject({ method: "GET", url: `/host/scores${query}`, headers });
}

describe("宿主凭证门(D-API-122:宿主凭证 ≠ 会话凭证)", () => {
  it("未呈递凭证 → 401 冻结形态(字节级沿 D-API-14)", async () => {
    const rig = await buildHostRig();
    const response = await rig.app.inject({ method: "GET", url: "/host/scores" });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe(AUTH_FAILED_BODY);
  });

  it.each([
    ["错误取值", "Bearer wrong-credential-0123456789abcdef"],
    ["长度不符", "Bearer short"],
    ["缺 Bearer 前缀", TEST_HOST_BACKEND_TOKEN],
    ["非 Bearer 方案", `Basic ${TEST_HOST_BACKEND_TOKEN}`],
    ["空 Bearer 值", "Bearer "],
  ])("畸形 / 错误宿主凭证(%s)→ 401 逐字节同形(零原因差异,防枚举)", async (_label, header) => {
    const rig = await buildHostRig();
    const response = await rig.app.inject({
      method: "GET",
      url: "/host/scores",
      headers: { authorization: header },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe(AUTH_FAILED_BODY);
  });

  it("会话凭证不得通行宿主面(凭证域分离:宿主面只认宿主共享凭证)", async () => {
    const rig = await buildHostRig();
    // 会话凭证(合法签发形态)在宿主面必须与"未呈递"同形拒绝。
    const issued = await rig.issueEmbedToken();
    const response = await rig.app.inject({
      method: "GET",
      url: "/host/scores",
      headers: { authorization: `Bearer ${issued.token}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).toBe(AUTH_FAILED_BODY);
  });

  it("凭证缺失与凭证错误不可区分(同一 (状态, 字节) 三元组)", async () => {
    const rig = await buildHostRig();
    const absent = await rig.app.inject({ method: "GET", url: "/host/scores" });
    const wrong = await rig.app.inject({
      method: "GET",
      url: "/host/scores",
      headers: hostHeaders("Bearer not-the-credential-0123456789"),
    });
    expect([absent.statusCode, absent.body]).toEqual([wrong.statusCode, wrong.body]);
  });
});

describe("租户绑定白名单(O-MP-6 / D-API-124)", () => {
  it("白名单空 / 缺失 ⇒ 面整体 404(fail-closed,防枚举)", async () => {
    const rig = await buildSessionTestRig();
    seedScore(rig, { ordinal: 1 });
    const response = await getScores(rig);
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(NOT_FOUND_BODY);
  });

  it("绑定白名单后正常读取本租户成绩(恰七字段 + nextCursor)", async () => {
    const rig = await buildHostRig();
    const id = seedScore(rig, { ordinal: 1, verdict: "wrong_answer" });
    const response = await getScores(rig);
    expect(response.statusCode).toBe(200);
    const body = HostScoresResponseSchema.parse(response.json());
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
    expect(Object.keys(body.items[0]!).sort()).toEqual([
      "challengeId",
      "challengeVersion",
      "decidedAt",
      "id",
      "sessionId",
      "submissionId",
      "verdict",
    ]);
    expect(body.items[0]!.id).toBe(id);
    expect(body.items[0]!.verdict).toBe("wrong_answer");
  });

  it("集合内子选只返回所选租户(O-MP-6:子选是过滤,不是身份)", async () => {
    const rig = await buildHostRig();
    seedScore(rig, { ordinal: 1, tenantId: TEST_TENANT_ID });
    seedScore(rig, { ordinal: 2, tenantId: TEST_TENANT_BETA_ID });
    const alpha = await getScores(rig, `?tenantId=${TEST_TENANT_ID}`);
    const beta = await getScores(rig, `?tenantId=${TEST_TENANT_BETA_ID}`);
    expect((alpha.json() as { items: unknown[] }).items).toHaveLength(1);
    expect((beta.json() as { items: unknown[] }).items).toHaveLength(1);
    expect((alpha.json() as { items: { sessionId: string }[] }).items[0]!.sessionId).toBe("sess-host-1");
    expect((beta.json() as { items: { sessionId: string }[] }).items[0]!.sessionId).toBe("sess-host-2");
  });

  it("集合外 tenantId ⇒ 404 与白名单空态逐字节同形(零额外信号)", async () => {
    const rig = await buildHostRig();
    seedScore(rig, { ordinal: 1, tenantId: "tenant-gamma" });
    const outside = await getScores(rig, "?tenantId=tenant-gamma");
    const unboundRig = await buildSessionTestRig();
    const unbound = await getScores(unboundRig);
    expect(outside.statusCode).toBe(404);
    expect(outside.body).toBe(NOT_FOUND_BODY);
    expect(outside.body).toBe(unbound.body);
  });

  it.each([
    ["字符集违规", "tenant%20alpha"],
    ["注入尝试", "tenant-alpha'%20OR%201=1"],
    ["空值", ""],
  ])("畸形 tenantId(%s)⇒ 404 同形(不在集合内即不可达)", async (_label, value) => {
    const rig = await buildHostRig();
    const response = await getScores(rig, `?tenantId=${value}`);
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe(NOT_FOUND_BODY);
  });

  it("查询参数不能决定租户:集合外租户即使存在记录也不可达", async () => {
    const rig = await buildHostRig();
    seedScore(rig, { ordinal: 1, tenantId: "tenant-gamma" });
    const all = await getScores(rig);
    expect((all.json() as { items: unknown[] }).items).toHaveLength(0);
    expect(all.body).not.toContain("sess-host-1");
  });
});

describe("查询参数白名单与批量上限(D-API-124 / D-API-125)", () => {
  it.each([
    ["未登记参数", "?since=1789200000"],
    ["第二未登记参数", "?offset=0"],
  ])("%s ⇒ 400 冻结形态(未知面不静默忽略)", async (_label, query) => {
    const rig = await buildHostRig();
    const response = await getScores(rig, query);
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(VALIDATION_BODY);
  });

  it.each([
    ["非数字", "abc"],
    ["零", "0"],
    ["负数", "-1"],
    ["小数", "1.5"],
    ["重复参数", "1&limit=2"],
  ])("畸形 limit(%s)⇒ 400(不静默回退默认值)", async (_label, value) => {
    const rig = await buildHostRig();
    const response = await getScores(rig, `?limit=${value}`);
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(VALIDATION_BODY);
  });

  it("limit 超批量上限 ⇒ 400 确定性拒绝(不钳制)", async () => {
    const rig = await buildHostRig({ SESSION_API_HOST_SCORES_BATCH: "2" });
    seedScore(rig, { ordinal: 1 });
    seedScore(rig, { ordinal: 2 });
    seedScore(rig, { ordinal: 3 });
    const response = await getScores(rig, "?limit=3");
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(VALIDATION_BODY);
  });

  it("limit 越过 config 上限但低于默认值 ⇒ 仍按生效 config 拒绝", async () => {
    const rig = await buildHostRig({ SESSION_API_HOST_SCORES_BATCH: "500" });
    const response = await getScores(rig, "?limit=501");
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(VALIDATION_BODY);
  });

  it.each([
    ["非 UUID 标识符", "not-a-uuid"],
    ["路径穿越字符", "..%2F..%2Fetc"],
    ["非法 UUID 形态", "00000000-0000-4000-8000-00000000000"],
  ])("畸形 cursor(%s)⇒ 400(畸形游标不进库层 cast)", async (_label, value) => {
    const rig = await buildHostRig();
    const response = await getScores(rig, `?cursor=${value}`);
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(VALIDATION_BODY);
  });
});

describe("keyset 分页与终态确定性(D-API-123)", () => {
  it("分批拉取:游标严格前进、页间零重复、末页 nextCursor = null", async () => {
    const rig = await buildHostRig({ SESSION_API_HOST_SCORES_BATCH: "2" });
    const ids = [1, 2, 3, 4, 5].map((ordinal) => seedScore(rig, { ordinal }));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const query = cursor === null ? "" : `?cursor=${cursor}`;
      const response = await getScores(rig, query);
      expect(response.statusCode).toBe(200);
      const body = HostScoresResponseSchema.parse(response.json());
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      if (cursor === null) {
        break;
      }
      // 游标 = 本页末行 id(keyset 严格前进;禁止时刻游标)。
      expect(cursor).toBe(body.items.at(-1)!.id);
    }
    expect(seen).toEqual(ids);
    expect(cursor).toBeNull();
  });

  it("游标回放同一页即字节确定(I-4:同输入同输出)", async () => {
    const rig = await buildHostRig({ SESSION_API_HOST_SCORES_BATCH: "1" });
    [1, 2, 3].forEach((ordinal) => seedScore(rig, { ordinal }));
    const first = await getScores(rig, "?limit=1");
    const cursor = (first.json() as { nextCursor: string }).nextCursor;
    const again = await getScores(rig, `?limit=1&cursor=${cursor}`);
    const twice = await getScores(rig, `?limit=1&cursor=${cursor}`);
    expect(again.body).toBe(twice.body);
    expect((again.json() as { items: { id: string }[] }).items[0]!.id).toBe(scoreId(2));
  });

  it("空批 = 合法终态(200 + items 空 + nextCursor null),非错误", async () => {
    const rig = await buildHostRig();
    const response = await getScores(rig);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], nextCursor: null });
  });

  it("游标指向末行之外 ⇒ 空页终态(不报错、不回到首页)", async () => {
    const rig = await buildHostRig();
    seedScore(rig, { ordinal: 1 });
    seedScore(rig, { ordinal: 2 });
    const response = await getScores(rig, `?cursor=${scoreId(2)}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], nextCursor: null });
  });

  it("多租户合并按 id 全局升序(跨租户 keyset 序确定)", async () => {
    const rig = await buildHostRig();
    seedScore(rig, { ordinal: 1, tenantId: TEST_TENANT_BETA_ID });
    seedScore(rig, { ordinal: 2, tenantId: TEST_TENANT_ID });
    seedScore(rig, { ordinal: 3, tenantId: TEST_TENANT_BETA_ID });
    const response = await getScores(rig);
    const body = HostScoresResponseSchema.parse(response.json());
    expect(body.items.map((item) => item.id)).toEqual([scoreId(1), scoreId(2), scoreId(3)]);
  });
});

describe("载荷公开上限面(D-API-123:零私有字段零租户回显)", () => {
  it("响应字节恰两键信封 + 恰七键记录,零私有面字段名出现", async () => {
    const rig = await buildHostRig();
    seedScore(rig, { ordinal: 1, verdict: "engine_error" });
    const response = await getScores(rig);
    expect(response.statusCode).toBe(200);
    const payload = response.json() as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["items", "nextCursor"]);
    const record = (payload["items"] as Record<string, unknown>[])[0]!;
    expect(Object.keys(record).sort()).toEqual([
      "challengeId",
      "challengeVersion",
      "decidedAt",
      "id",
      "sessionId",
      "submissionId",
      "verdict",
    ]);
    // 注意:challengeId 语料自带 "stack" 子串(chal-stack-escape),故禁用
    // 词表取**字段名粒度**(内部堆栈的字段名是 stackTrace / internalStack)。
    for (const forbidden of [
      "detail",
      "reference",
      "tenantId",
      "verifierRunId",
      "predicate",
      "hiddenTest",
      "internalStack",
      "stackTrace",
    ]) {
      expect(response.body).not.toContain(forbidden);
    }
  });

  it("私有列即使存在于存储侧也不下发(SERVER_ONLY 在读取层即不出现)", async () => {
    const rig = await buildHostRig();
    // 存储侧记录刻意携带额外列(内存实现按端口面字段投影,不整体透传)。
    rig.hostScores.seed({
      id: scoreId(9),
      tenantId: TEST_TENANT_ID,
      submissionId: "10000000-0000-4000-8000-000000000009",
      sessionId: "sess-host-9",
      challengeId: "chal-stack-escape",
      challengeVersion: "1.2.3",
      verdict: "wrong_answer",
      decidedAtEpochSeconds: 1789200009,
    });
    const response = await getScores(rig);
    expect(Object.keys((response.json() as { items: Record<string, unknown>[] }).items[0]!).sort()).toEqual([
      "challengeId",
      "challengeVersion",
      "decidedAt",
      "id",
      "sessionId",
      "submissionId",
      "verdict",
    ]);
  });

  it("非成绩方向与成绩方向同构呈现(同键集,零方向分支)", async () => {
    const rig = await buildHostRig();
    seedScore(rig, { ordinal: 1, verdict: "success" });
    seedScore(rig, { ordinal: 2, verdict: "cancelled" });
    const body = HostScoresResponseSchema.parse((await getScores(rig)).json());
    expect(Object.keys(body.items[0]!).sort()).toEqual(Object.keys(body.items[1]!).sort());
    expect(body.items[1]!.verdict).toBe("cancelled");
  });

  it("decidedAt 为 epoch 秒整数(非 ISO 串、非毫秒)", async () => {
    const rig = await buildHostRig();
    seedScore(rig, { ordinal: 1, decidedAt: 1789200001 });
    const body = HostScoresResponseSchema.parse((await getScores(rig)).json());
    expect(body.items[0]!.decidedAt).toBe(1789200001);
  });
});

describe("限流(D-API-125:rate:{锚租户}:host_scores)", () => {
  it("触顶 → 429 冻结形态(字节级沿 D-API-50 频率类)", async () => {
    const rig = await buildHostRig({ SESSION_API_HOST_SCORES_QUERIES_PER_MINUTE: "2" });
    seedScore(rig, { ordinal: 1 });
    expect((await getScores(rig)).statusCode).toBe(200);
    expect((await getScores(rig)).statusCode).toBe(200);
    const third = await getScores(rig);
    expect(third.statusCode).toBe(429);
    expect(third.body).toBe(RATE_LIMIT_BODY);
  });

  it("子选不放大预算:交替 tenantId 仍触顶(限流键 = 凭证绑定锚,非子选值)", async () => {
    const rig = await buildHostRig({ SESSION_API_HOST_SCORES_QUERIES_PER_MINUTE: "2" });
    expect((await getScores(rig, `?tenantId=${TEST_TENANT_ID}`)).statusCode).toBe(200);
    expect((await getScores(rig, `?tenantId=${TEST_TENANT_BETA_ID}`)).statusCode).toBe(200);
    const third = await getScores(rig, `?tenantId=${TEST_TENANT_ID}`);
    expect(third.statusCode).toBe(429);
    expect(third.body).toBe(RATE_LIMIT_BODY);
  });

  it("限流键与配置书写顺序无关(锚 = 字典序最小绑定租户)", async () => {
    // 两种等价书写产生同一规范化集合 ⇒ 同一限流键 ⇒ 预算共享(不各自计数)。
    const rig = await buildSessionTestRig({
      env: { SESSION_API_HOST_TENANTS: `${TEST_TENANT_BETA_ID}, ${TEST_TENANT_ID}`, SESSION_API_HOST_SCORES_QUERIES_PER_MINUTE: "2" },
    });
    expect(rig.config.hostTenants).toEqual([TEST_TENANT_ID, TEST_TENANT_BETA_ID]);
    expect((await getScores(rig, `?tenantId=${TEST_TENANT_BETA_ID}`)).statusCode).toBe(200);
    expect((await getScores(rig, `?tenantId=${TEST_TENANT_ID}`)).statusCode).toBe(200);
    expect((await getScores(rig)).statusCode).toBe(429);
  });

  it("白名单空态不消费限流预算(面整体 404 在频率闸之前)", async () => {
    const rig = await buildSessionTestRig({
      env: { SESSION_API_HOST_SCORES_QUERIES_PER_MINUTE: "1" },
    });
    expect((await getScores(rig)).statusCode).toBe(404);
    expect((await getScores(rig)).statusCode).toBe(404);
  });
});

describe("配置面闸(D-API-125:三道闸的常量 / 天花板面)", () => {
  it("默认批量上限 = 500,默认频率 = 120(保守默认值)", async () => {
    const rig = await buildHostRig();
    expect(rig.config.hostScoresBatch).toBe(500);
    expect(rig.config.hostScoresQueriesPerMinute).toBe(120);
  });

  it("批量上限超天花板 ⇒ 拒绝启动(envSchema max 闸)", async () => {
    await expect(
      buildHostRig({ SESSION_API_HOST_SCORES_BATCH: "5001" }),
    ).rejects.toThrow(/SESSION_API_HOST_SCORES_BATCH/);
  });

  it("频率超天花板 ⇒ 拒绝启动", async () => {
    await expect(
      buildHostRig({ SESSION_API_HOST_SCORES_QUERIES_PER_MINUTE: "100001" }),
    ).rejects.toThrow(/SESSION_API_HOST_SCORES_QUERIES_PER_MINUTE/);
  });

  it("白名单项字符集违规 ⇒ 拒绝启动(fail-closed 的配置错误保护)", async () => {
    await expect(buildHostRig({ SESSION_API_HOST_TENANTS: "tenant alpha" })).rejects.toThrow(
      /SESSION_API_HOST_TENANTS/,
    );
  });

  it("未登记保留键 ⇒ 拒绝启动(拼写错误保护)", async () => {
    await expect(buildHostRig({ SESSION_API_HOST_SCORE_BATCH: "10" })).rejects.toThrow(
      /未登记的保留键/,
    );
  });
});

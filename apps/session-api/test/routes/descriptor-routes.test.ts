/**
 * 公开描述包下发通道测试(阶段五 WP-50 完成标准;D-API-76;内存同构 rig)。
 *
 * 覆盖面(任务分解 WP-50 完成标准逐项):
 *  - happy path:200 + application/json + ETag = 登记摘要 + 体 = 桶内原始字节
 *    (逐字节确定性,I-4:同请求两次响应体一致);
 *  - 未登记题目 ID / 未登记版本 → 404 冻结 `PublicError`(响应体逐字节一致,
 *    与参数字符集违规同形,防枚举;SSRF 纪律:只接受已登记派生获取路径);
 *  - 摘要篡改红灯(语料齐备):桶内对象被替换为与登记摘要不符的字节 → 422
 *    `internal_error` / "challenge invalid"(逐字节;防题目枚举同形);
 *  - 超限红灯(语料齐备):字节护栏(摘要相符但超 SESSION_API_MAX_DESCRIPTOR_BYTES)
 *    与结构护栏(嵌套深度越界、摘要相符)→ 422 同形;
 *  - 登记行在而桶内对象缺失 → 422 同形(D-API-32 challenge_invalid 行);
 *  - 零秘密面自证:响应体经跨域载荷机检(scanCrossDomainPayload,ZR-B9/B10/B5/B4
 *    规则)零命中 + FLAG 语料零出现;红灯反例注入证明机检可检出(非静默绿灯);
 *  - CORS:白名单 origin 回显 ACAO(D-API-16 既有装配;GET 在方法集内),
 *    非白名单 origin 不回显(fail-closed);
 *  - 认证姿态:无凭证 GET 可达(公开内容),凭证 / Cookie 均非必要。
 *
 * 真实 MinIO / PG 路径的端口行为由既有容器门控集成测试覆盖
 * (test/persistence/descriptor-publish.integration.test.ts,SESSION_API_IT 门控)。
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scanCrossDomainPayload } from "../../src/scan/cross-domain-payload-scanner.js";
import { scanSecretCorpus } from "../../src/persistence/index.js";
import {
  TEST_CHALLENGE_ID,
  TEST_CHALLENGE_VERSION,
  buildSessionTestRig,
  type SessionTestRig,
} from "./helpers/session-rig.js";

const NOT_FOUND_BODY = '{"code":"invalid_input_format","message":"resource not found"}';
const CHALLENGE_INVALID_BODY = '{"code":"internal_error","message":"challenge invalid"}';

function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("公开描述包下发通道(GET /descriptors/:challengeId/:version;WP-50,D-API-76)", () => {
  async function rigWithChallenge(): Promise<SessionTestRig> {
    const rig = await buildSessionTestRig();
    await rig.registerChallenge();
    return rig;
  }

  it("happy path:200 + application/json + ETag = 登记摘要 + 体 = 桶内原始字节", async () => {
    const rig = await rigWithChallenge();
    const stored = await rig.bundles.getPublic(TEST_CHALLENGE_ID, TEST_CHALLENGE_VERSION);
    expect(stored).not.toBeNull();

    const response = await rig.app.inject({
      method: "GET",
      url: `/descriptors/${TEST_CHALLENGE_ID}/${TEST_CHALLENGE_VERSION}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(response.headers["etag"]).toBe(`"${sha256Hex(stored!)}"`);
    // 体 = 桶内原始字节(零重序列化,逐字节一致)。
    expect(Buffer.from(response.rawPayload).equals(Buffer.from(stored!))).toBe(true);

    // 零租户 / 零会话 / 零内部对象名回显(零秘密面自证的静态面)。
    const bodyText = response.body;
    expect(bodyText).not.toContain("tenant");
    expect(bodyText).not.toContain("descriptor.json");
    expect(bodyText).not.toContain("signature");

  });

  it("I-4:同一请求两次响应体逐字节一致(响应面确定性)", async () => {
    const rig = await rigWithChallenge();
    const first = await rig.app.inject({
      method: "GET",
      url: `/descriptors/${TEST_CHALLENGE_ID}/${TEST_CHALLENGE_VERSION}`,
    });
    const second = await rig.app.inject({
      method: "GET",
      url: `/descriptors/${TEST_CHALLENGE_ID}/${TEST_CHALLENGE_VERSION}`,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(Buffer.from(first.rawPayload).equals(Buffer.from(second.rawPayload))).toBe(true);
    expect(first.headers["etag"]).toBe(second.headers["etag"]);
  });

  it("未登记题目 ID / 未登记版本 → 404 冻结形态(逐字节;防枚举同形)", async () => {
    const rig = await rigWithChallenge();
    for (const url of [
      "/descriptors/chal-not-registered/1.2.3",
      `/descriptors/${TEST_CHALLENGE_ID}/9.9.9`,
    ]) {
      const response = await rig.app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe(NOT_FOUND_BODY);
    }
  });

  it("参数字符集违规 → 404 同形(路径穿越 / 非法字符 / 非 semver;红灯语料)", async () => {
    const rig = await rigWithChallenge();
    const cases: readonly [string, string][] = [
      // challengeId:路径分隔符 / 点号(冻结标识符字符集外)。
      ["chal%2Fescape", "1.2.3"],
      ["..", "1.2.3"],
      [`${"a".repeat(129)}`, "1.2.3"],
      // version:非 semver、路径穿越序列、超长。
      [TEST_CHALLENGE_ID, "1.2"],
      [TEST_CHALLENGE_ID, "1.2.3.4"],
      [TEST_CHALLENGE_ID, "%2E%2E%2F1"],
      [TEST_CHALLENGE_ID, "abc"],
    ];
    for (const [challengeId, version] of cases) {
      const response = await rig.app.inject({
        method: "GET",
        url: `/descriptors/${challengeId}/${version}`,
      });
      expect(response.statusCode, `${challengeId} / ${version}`).toBe(404);
      expect(response.body, `${challengeId} / ${version}`).toBe(NOT_FOUND_BODY);
    }
  });

  it("摘要篡改红灯:桶内对象与登记摘要不符 → 422 challenge invalid(逐字节)", async () => {
    const rig = await rigWithChallenge();
    const stored = (await rig.bundles.getPublic(TEST_CHALLENGE_ID, TEST_CHALLENGE_VERSION))!;
    // 篡改语料:合法 JSON、摘要必然不符(单字节翻转语义)。
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(stored).toString("utf8")), tampered: true }));
    await rig.bundles.putPublic(TEST_CHALLENGE_ID, TEST_CHALLENGE_VERSION, tampered);

    const response = await rig.app.inject({
      method: "GET",
      url: `/descriptors/${TEST_CHALLENGE_ID}/${TEST_CHALLENGE_VERSION}`,
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).toBe(CHALLENGE_INVALID_BODY);
  });

  it("字节护栏红灯:摘要相符但超 SESSION_API_MAX_DESCRIPTOR_BYTES → 422 同形", async () => {
    // 护栏独立可证:登记与摘要照常,仅把护栏数值压到描述包字节以下。
    const rig = await buildSessionTestRig({
      env: { SESSION_API_MAX_DESCRIPTOR_BYTES: "64" },
    });
    await rig.registerChallenge();
    const stored = await rig.bundles.getPublic(TEST_CHALLENGE_ID, TEST_CHALLENGE_VERSION);
    expect(stored!.byteLength).toBeGreaterThan(64);

    const response = await rig.app.inject({
      method: "GET",
      url: `/descriptors/${TEST_CHALLENGE_ID}/${TEST_CHALLENGE_VERSION}`,
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).toBe(CHALLENGE_INVALID_BODY);
  });

  it("结构护栏红灯:嵌套深度越界(摘要相符)→ 422 同形(超限载荷语料)", async () => {
    const rig = await rigWithChallenge();
    // 超限语料:32 层嵌套数组(默认深度护栏 16),摘要按该字节登记——
    // 证明结构护栏独立于摘要比对生效。
    let nested: unknown = [];
    for (let i = 0; i < 32; i += 1) {
      nested = [nested];
    }
    const payload = Buffer.from(JSON.stringify(nested), "utf8");
    await rig.registry.insertChallengeVersion({
      challengeId: "chal-deep-guard",
      contentVersion: "1.0.0",
      tenantId: "tenant-alpha",
      vmProfileVersion: "1.0.0",
      privateBundleSha256: "00",
      publicDescriptorSha256: sha256Hex(payload),
      privateBundleObject: "chal-deep-guard/1.0.0/bundle.json",
      publicDescriptorObject: "chal-deep-guard/1.0.0/descriptor.json",
      signature: "test-signature",
      signerKeyId: "test-key",
    });
    await rig.bundles.putPublic("chal-deep-guard", "1.0.0", payload);

    const response = await rig.app.inject({
      method: "GET",
      url: "/descriptors/chal-deep-guard/1.0.0",
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).toBe(CHALLENGE_INVALID_BODY);
  });

  it("登记行在而桶内对象缺失 → 422 challenge invalid 同形(D-API-32 challenge_invalid 行)", async () => {
    const rig = await rigWithChallenge();
    // 版本行登记(手动)但不放桶:服务端数据一致性事故的确定性呈现。
    await rig.registry.insertChallengeVersion({
      challengeId: "chal-no-object",
      contentVersion: "1.0.0",
      tenantId: "tenant-alpha",
      vmProfileVersion: "1.0.0",
      privateBundleSha256: "00",
      publicDescriptorSha256: "00",
      privateBundleObject: "chal-no-object/1.0.0/bundle.json",
      publicDescriptorObject: "chal-no-object/1.0.0/descriptor.json",
      signature: "test-signature",
      signerKeyId: "test-key",
    });

    const response = await rig.app.inject({
      method: "GET",
      url: "/descriptors/chal-no-object/1.0.0",
    });
    expect(response.statusCode).toBe(422);
    expect(response.body).toBe(CHALLENGE_INVALID_BODY);
  });

  it("零秘密面自证:响应体跨域载荷机检零命中 + FLAG 语料零出现(红灯反例证明可检出)", async () => {
    const rig = await rigWithChallenge();
    const response = await rig.app.inject({
      method: "GET",
      url: `/descriptors/${TEST_CHALLENGE_ID}/${TEST_CHALLENGE_VERSION}`,
    });
    expect(response.statusCode).toBe(200);

    // 机检(测试锚点,D-API-60 同源规则):ZR-B9 / B10 / B5 / B4 零命中;
    // FLAG 语料(ZR-B1)零出现。bytesHex 等公开十六进制载荷为 I-10 值来源,
    // seed 语料模式对公开描述包不适用(D-API-60 豁免面同源)。
    const parsedBody = JSON.parse(response.body);
    expect(scanCrossDomainPayload(parsedBody)).toEqual([]);
    expect(scanSecretCorpus(response.body).filter((hit) => hit.id === "ZR-B1-flag-corpus")).toEqual([]);

    // 红灯反例:注入 VmState 共现形态必须检出(证明扫描器未失效,非静默绿灯)。
    const redFlag = { registers: {}, memory: {}, seedState: "x" };
    expect(scanCrossDomainPayload(redFlag).length).toBeGreaterThan(0);
  });

  it("CORS:白名单 origin 回显 ACAO;非白名单 origin 不回显(fail-closed)", async () => {
    const rig = await rigWithChallenge();
    const allowed = await rig.app.inject({
      method: "GET",
      url: `/descriptors/${TEST_CHALLENGE_ID}/${TEST_CHALLENGE_VERSION}`,
      headers: { origin: "https://plugin.example" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://plugin.example");
    // ETag 对跨源浏览器脚本可读(D-API-76 增补):描述包客户端加载器的
    // 完整性校验锚是 ETag=登记摘要,跨源插件 iframe 读不到该头即无法做
    // 客户端侧哈希比对——Access-Control-Expose-Headers 必须含 ETag。
    expect(allowed.headers["access-control-expose-headers"]).toContain("ETag");

    const denied = await rig.app.inject({
      method: "GET",
      url: `/descriptors/${TEST_CHALLENGE_ID}/${TEST_CHALLENGE_VERSION}`,
      headers: { origin: "https://evil.example" },
    });
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("认证姿态:无凭证 GET 可达(公开内容;Cookie / Bearer 均非必要)", async () => {
    const rig = await rigWithChallenge();
    const response = await rig.app.inject({
      method: "GET",
      url: `/descriptors/${TEST_CHALLENGE_ID}/${TEST_CHALLENGE_VERSION}`,
    });
    expect(response.statusCode).toBe(200);
  });
});

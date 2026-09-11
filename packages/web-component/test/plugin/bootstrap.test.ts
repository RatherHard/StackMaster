import { describe, expect, it } from "vitest";

import { fetchEmbedBootstrapConfig } from "../../src/plugin/bootstrap.js";
import { TEST_ESID } from "../helpers.js";

/** 构造 POST 体断言型 fetch 假体。 */
function fakeFetch(status: number, body: unknown, record: { bodies: unknown[]; urls: string[] } = { bodies: [], urls: [] }) {
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    record.urls.push(String(input));
    record.bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, record };
}

const VALID_CONFIG = {
  embedToken: "opaque-token-value",
  sessionApiOrigin: "https://sessionapi.example",
  challengeId: "challenge-0001",
  challengeVersion: "1.0.0",
  embedSessionId: TEST_ESID,
};

describe("引导配置取回(D-API-75 默认通道 a)", () => {
  it("以 POST 体承载 esid 换取引导配置(禁入 URL query——V-13 红灯反例锚)", async () => {
    const { fn, record } = fakeFetch(200, VALID_CONFIG);
    const config = await fetchEmbedBootstrapConfig("https://host.example/host-api/embed-bootstrap", TEST_ESID, {
      fetchImpl: fn,
    });
    expect(config).not.toBeNull();
    expect(config?.embedToken).toBe("opaque-token-value");
    expect(record.urls[0]).toBe("https://host.example/host-api/embed-bootstrap");
    expect(record.urls[0]).not.toContain(TEST_ESID); // esid 不在 URL。
    expect(record.bodies[0]).toEqual({ embedSessionId: TEST_ESID }); // esid 在 POST 体。
  });

  it("非 200 / 网络异常 / 响应非 JSON → null(降级,不抛错)", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    expect(await fetchEmbedBootstrapConfig("https://h.example/b", TEST_ESID, { fetchImpl: failing })).toBeNull();
    expect(
      await fetchEmbedBootstrapConfig("https://h.example/b", TEST_ESID, {
        fetchImpl: fakeFetch(404, { error: "bootstrap_not_found" }).fn,
      }),
    ).toBeNull();
    expect(
      await fetchEmbedBootstrapConfig("https://h.example/b", TEST_ESID, {
        fetchImpl: fakeFetch(200, "not json at all").fn,
      }),
    ).toBeNull();
  });

  it("响应形态不符(缺字段 / esid 不等 / origin 非法)→ null(零反射差异)", async () => {
    expect(
      await fetchEmbedBootstrapConfig("https://h.example/b", TEST_ESID, {
        fetchImpl: fakeFetch(200, { ...VALID_CONFIG, embedToken: undefined }).fn,
      }),
    ).toBeNull();
    expect(
      await fetchEmbedBootstrapConfig("https://h.example/b", TEST_ESID, {
        fetchImpl: fakeFetch(200, { ...VALID_CONFIG, embedSessionId: "OTHER-ESID-VALUE-000000000x" }).fn,
      }),
    ).toBeNull();
    expect(
      await fetchEmbedBootstrapConfig("https://h.example/b", TEST_ESID, {
        fetchImpl: fakeFetch(200, { ...VALID_CONFIG, sessionApiOrigin: "not-a-origin" }).fn,
      }),
    ).toBeNull();
    expect(
      await fetchEmbedBootstrapConfig("https://h.example/b", TEST_ESID, {
        fetchImpl: fakeFetch(200, { ...VALID_CONFIG, challengeVersion: "" }).fn,
      }),
    ).toBeNull();
    expect(
      await fetchEmbedBootstrapConfig("https://h.example/b", TEST_ESID, {
        fetchImpl: fakeFetch(200, [VALID_CONFIG]).fn,
      }),
    ).toBeNull();
  });
});

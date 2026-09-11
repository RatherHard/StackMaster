/**
 * 公开描述包客户端加载器测试(WP-54):
 *  - 红灯矩阵逐项:定位参数 / 网络失败(一次显式重试)/ 404 / 非 200 /
 *    Content-Length 与响应体字节超限 / ETag 缺失 / 摘要篡改 / 非法 JSON /
 *    深度越限 / 结构坏形态 → 确定性拒绝(原因码逐项断言);
 *  - 成功路径:ETag(含弱化 / 大写形态)比对通过、debugMode / aslrEnabled
 *    归一化、静态面投影;
 *  - 护栏数值登记面(DESCRIPTOR_CLIENT_GUARDS 与服务端 D-API-76 / D-API-31
 *    同值)。
 * jsdom 无 crypto.subtle:sha256Hex 注入 Node webcrypto(与浏览器 WebCrypto
 * 同语义,运行时默认实现即 globalThis.crypto.subtle)。
 */
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DESCRIPTOR_CLIENT_GUARDS,
  challengeStaticFace,
  fetchChallengeDescriptor,
  parseDescriptorView,
  type ChallengeDescriptorView,
  type DescriptorFailureReason,
} from "../../src/descriptor/challenge-descriptor.js";

const ORIGIN = "https://sessionapi.example";
const CHALLENGE_ID = "chal-wp54";
const VERSION = "1.0.0";

/** Node webcrypto 摘要(小写 hex;与加载器缺省实现同语义)。 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const exact = new Uint8Array(bytes); // 复制为精确尺寸缓冲(规避 DOM/Node BufferSource 型差)。
  const digest = await webcrypto.subtle.digest("SHA-256", exact.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 合法描述包语料(对齐锚 = challenge-schema 公开 Schema;与
 *  test/fixtures/public-descriptor/basic.json 同形态的独立最小语料)。 */
function makeDescriptor(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    challengeId: CHALLENGE_ID,
    challengeContentVersion: VERSION,
    vmProfileVersion: "1.0.0",
    locale: "zh-CN",
    briefing: {
      title: "WP-54 正式下发语料",
      summary: "加载器测试用公开描述包(占位数据,零秘密)。",
      learningObjectives: ["理解 hintLadder 双分支"],
    },
    vmProfile: {
      registers: [{ name: "RAX" }, { name: "RSP" }],
      flagRegisterNames: ["FLAG0"],
      endianness: "little",
      archBits: 64,
      pageSizeBytes: 4096,
      canary: { enabled: true, sizeBytes: 8 },
      encodingTable: [
        { tokenHex: "0xc3", op: "ret" },
        { tokenHex: "0x50", op: "push", operands: [{ kind: "register", name: "RAX" }] },
      ],
    },
    memoryLayout: {
      regions: [
        {
          regionId: "code",
          kind: "code",
          startAddressHex: "0x400000",
          byteLength: 4096,
          permissions: "rx",
          publicLabel: "代码段",
        },
      ],
    },
    allowedActions: ["write_bytes", "step"],
    resourceLimits: {},
    hintLadder: [
      { order: 1, revealPolicy: "on_request", hintText: "正式通道提示一" },
      { order: 2, revealPolicy: "after_n_failures", failureThreshold: 2, hintText: "正式通道提示二" },
    ],
    publicErrorMapping: [{ errorCode: "inaccessible_address", teachingNote: "正式通道教学注解" }],
    randomizationNotice: "固定布局,无随机化面。",
    initialProjection: {
      visibleRegions: [
        {
          regionId: "code",
          label: "代码段",
          startAddressHex: "0x400000",
          byteLength: 4096,
          permissions: "rx",
          bytesHex: "c390",
          truncated: true,
        },
      ],
      visibleRegisters: [
        { name: "RSP", valueHex: "0x7FFFFFF8" },
        { name: "RAX", valueHex: "0x0" },
      ],
      semanticHighlights: [
        {
          kind: "buffer_start",
          targetRegionId: "code",
          startAddressHex: "0x400000",
          byteLength: 16,
          label: "输入缓冲区(占位)",
        },
      ],
    },
  };
}

/** scripted fetch:按 URL 返回响应工厂(同步或 Promise);记录全部请求 URL。 */
function scriptedFetch(
  handler: (url: string) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { fetchImpl, urls };
}

/** 以语料构建 200 响应(ETag = 体摘要;可篡改体或 ETag)。 */
async function okResponse(body: unknown, etagOverride?: string): Promise<Response> {
  const text = JSON.stringify(body);
  const etag = etagOverride ?? `"${await sha256Hex(new TextEncoder().encode(text))}"`;
  return new Response(text, { status: 200, headers: { etag } });
}

async function load(
  overrides: Partial<Parameters<typeof fetchChallengeDescriptor>[0]> = {},
  handler: (url: string) => Response | Promise<Response> = (url) => {
    // 缺省:仅描述包 URL 返回合法语料(其余 404)。
    void url;
    throw new Error("未提供 handler");
  },
): Promise<{ outcome: Awaited<ReturnType<typeof fetchChallengeDescriptor>>; urls: string[] }> {
  const script = scriptedFetch(handler);
  const outcome = await fetchChallengeDescriptor({
    sessionApiOrigin: ORIGIN,
    challengeId: CHALLENGE_ID,
    challengeVersion: VERSION,
    fetchImpl: script.fetchImpl,
    sha256Hex,
    ...overrides,
  });
  return { outcome, urls: script.urls };
}

function expectReason(outcome: Awaited<ReturnType<typeof fetchChallengeDescriptor>>, reason: DescriptorFailureReason): void {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.reason).toBe(reason);
  }
}

// ── 护栏数值登记面 ───────────────────────────────────────────────────────────

describe("客户端护栏数值(与服务端 §8.3 护栏成对;登记面)", () => {
  it("数值与服务端同值装配:262144 / 16 / 256 / 4096(D-API-76 / D-API-31)", () => {
    expect(DESCRIPTOR_CLIENT_GUARDS.maxBodyBytes).toBe(262144);
    expect(DESCRIPTOR_CLIENT_GUARDS.maxJsonDepth).toBe(16);
    expect(DESCRIPTOR_CLIENT_GUARDS.maxArrayLength).toBe(256);
    expect(DESCRIPTOR_CLIENT_GUARDS.maxStringLength).toBe(4096);
  });
});

// ── 成功路径 ────────────────────────────────────────────────────────────────

describe("成功路径:正式下发描述包加载", () => {
  it("GET 定位 URL → 摘要比对通过 → 强类型视图(ED 教学面直读)", async () => {
    const { outcome, urls } = await load({}, (url) =>
      url === `${ORIGIN}/descriptors/${CHALLENGE_ID}/${VERSION}` ? okResponse(makeDescriptor()) : new Response(null, { status: 404 }),
    );
    expect(outcome.ok).toBe(true);
    expect(urls).toEqual([`${ORIGIN}/descriptors/${CHALLENGE_ID}/${VERSION}`]);
    if (!outcome.ok) throw new Error("预期成功");
    const view: ChallengeDescriptorView = outcome.descriptor;
    expect(view.challengeId).toBe(CHALLENGE_ID);
    expect(view.hintLadder).toHaveLength(2);
    expect(view.publicErrorMapping[0]?.errorCode).toBe("inaccessible_address");
    expect(view.vmProfile.archBits).toBe(64);
    expect(view.initialProjection === undefined).toBe(false);
  });

  it("debugMode / aslrEnabled 归一化:缺席 = true / false(opt-out 语义)", async () => {
    const descriptor = makeDescriptor();
    delete (descriptor as Record<string, unknown>)["randomizationNotice"];
    const { outcome } = await load({}, () => okResponse(descriptor));
    if (!outcome.ok) throw new Error("预期成功");
    expect(outcome.descriptor.debugMode).toBe(true);
    expect(outcome.descriptor.aslrEnabled).toBe(false);
    expect(outcome.descriptor.randomizationNotice).toBeUndefined();
  });

  it("显式 debugMode=false / aslrEnabled=true 原样保留;ETag 弱化 / 大写形态均可比对", async () => {
    const descriptor = makeDescriptor();
    descriptor["debugMode"] = false;
    descriptor["aslrEnabled"] = true;
    const text = JSON.stringify(descriptor);
    const digest = await sha256Hex(new TextEncoder().encode(text));
    const { outcome } = await load({}, () => new Response(text, { status: 200, headers: { etag: `W/"${digest.toUpperCase()}"` } }));
    if (!outcome.ok) throw new Error("预期成功");
    expect(outcome.descriptor.debugMode).toBe(false);
    expect(outcome.descriptor.aslrEnabled).toBe(true);
  });

  it("challengeStaticFace:静态面投影(标题 / 简介 / VM Profile / encodingTable)", async () => {
    const { outcome } = await load({}, () => okResponse(makeDescriptor()));
    if (!outcome.ok) throw new Error("预期成功");
    const face = challengeStaticFace(outcome.descriptor);
    expect(face.title).toBe("WP-54 正式下发语料");
    expect(face.summary).toContain("零秘密");
    expect(face.archBits).toBe(64);
    expect(face.endianness).toBe("little");
    expect(face.pageSizeBytes).toBe(4096);
    expect(face.registerNames).toEqual(["RAX", "RSP"]);
    expect(face.canaryEnabled).toBe(true);
    expect(face.encodingTable).toHaveLength(2);
  });
});

// ── 红灯矩阵 ────────────────────────────────────────────────────────────────

describe("红灯:定位参数闸(invalid-input,零请求)", () => {
  const cases: readonly [string, Partial<Parameters<typeof fetchChallengeDescriptor>[0]>][] = [
    ["origin 非法(非 http(s))", { sessionApiOrigin: "ftp://x.example" }],
    ["origin 带路径(非裸 origin)", { sessionApiOrigin: `${ORIGIN}/api` }],
    ["challengeId 字符集违规(路径穿越)", { challengeId: "../etc" }],
    ["challengeId 超长", { challengeId: "a".repeat(129) }],
    ["version 空", { challengeVersion: "" }],
    ["version 路径穿越(..)", { challengeVersion: "1.0.0..x" }],
    ["version 非法字符(/)", { challengeVersion: "1/0/0" }],
  ];
  for (const [name, overrides] of cases) {
    it(`${name} → invalid-input 且零请求`, async () => {
      const { outcome, urls } = await load(overrides, () => new Response(null, { status: 200 }));
      expectReason(outcome, "invalid-input");
      expect(urls).toEqual([]);
    });
  }
});

describe("红灯:网络与状态面", () => {
  it("网络失败重试恰一次后放弃 → network(共 2 次请求,不重试风暴)", async () => {
    let calls = 0;
    const { outcome, urls } = await load({}, () => {
      calls += 1;
      throw new TypeError("fetch failed");
    });
    expectReason(outcome, "network");
    expect(calls).toBe(2);
    expect(urls).toHaveLength(2);
  });

  it("首次网络失败、重试成功 → 正常加载(至多一次显式重试语义)", async () => {
    let calls = 0;
    const { outcome } = await load({}, () => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError("fetch failed");
      }
      return okResponse(makeDescriptor());
    });
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("404(未登记 / 参数违规服务端同形)→ not-found;500 → http-status", async () => {
    const notFound = await load({}, () => new Response('{"code":"invalid_input_format"}', { status: 404 }));
    expectReason(notFound.outcome, "not-found");
    const serverError = await load({}, () => new Response('{"code":"internal_error"}', { status: 500 }));
    expectReason(serverError.outcome, "http-status");
  });
});

describe("红灯:尺寸护栏双闸(over-limit)", () => {
  it("Content-Length 显式超限 → over-limit(解析前拒绝)", async () => {
    const { outcome } = await load(
      { guards: { ...DESCRIPTOR_CLIENT_GUARDS, maxBodyBytes: 262144 } },
      () =>
        new Response("{}", {
          status: 200,
          headers: { etag: '"0"', "content-length": String(262145) },
        }),
    );
    expectReason(outcome, "over-limit");
  });

  it("响应体字节超限 → over-limit(读体后兜底闸)", async () => {
    const { outcome } = await load(
      { guards: { ...DESCRIPTOR_CLIENT_GUARDS, maxBodyBytes: 16 } },
      () => okResponse(makeDescriptor()),
    );
    expectReason(outcome, "over-limit");
  });

  it("嵌套深度越限(20 层数组,护栏 16)→ over-limit(摘要相符仍拒)", async () => {
    const deep: unknown[] = [];
    let node: unknown[] = deep;
    for (let i = 0; i < 20; i += 1) {
      const next: unknown[] = [];
      node.push(next);
      node = next;
    }
    const { outcome } = await load({}, () => okResponse(deep));
    expectReason(outcome, "over-limit");
  });
});

describe("红灯:完整性闸(ETag / 摘要)", () => {
  it("ETag 缺失 → etag-missing(确定性拒绝,不落到解析)", async () => {
    const { outcome } = await load(
      {},
      () => new Response(JSON.stringify(makeDescriptor()), { status: 200 }),
    );
    expectReason(outcome, "etag-missing");
  });

  it("响应体被篡改(摘要不符)→ digest-mismatch", async () => {
    const digestOfOther = await sha256Hex(new TextEncoder().encode("other-bytes"));
    const { outcome } = await load({}, () => okResponse(makeDescriptor(), `"${digestOfOther}"`));
    expectReason(outcome, "digest-mismatch");
  });

  it("摘要原语不可用(无注入且 WebCrypto 缺席)→ digest-unavailable", async () => {
    // 模拟 subtle 缺席(jsdom 形态;测试后恢复原全局)。
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { getRandomValues: (array: Uint8Array) => array.fill(0) },
    });
    try {
      // sha256Hex 显式置空:走缺省 WebCrypto 路径(此时 subtle 缺席)。
      const { outcome } = await load({ sha256Hex: undefined }, () => okResponse(makeDescriptor()));
      expectReason(outcome, "digest-unavailable");
    } finally {
      if (originalDescriptor !== undefined) {
        Object.defineProperty(globalThis, "crypto", originalDescriptor);
      }
    }
  });
});

describe("红灯:解析与结构(bad-shape / invalid-json)", () => {
  it("响应体非 JSON → invalid-json", async () => {
    const text = "not-json{";
    const { outcome } = await load(
      {},
      async () =>
        new Response(text, { status: 200, headers: { etag: `"${await sha256Hex(new TextEncoder().encode(text))}"` } }),
    );
    expectReason(outcome, "invalid-json");
  });

  it("JSON 数组顶层(对象缺失)→ bad-shape", async () => {
    const { outcome } = await load({}, () => okResponse([]));
    expectReason(outcome, "bad-shape");
  });
});

describe("红灯:结构坏形态(parseDescriptorView 逐项)", () => {
  /** 定向破坏语料后断言拒绝(红 ESLint-免疫的克隆路径)。 */
  function broken(edit: (clone: Record<string, unknown>) => void): unknown {
    const clone = JSON.parse(JSON.stringify(makeDescriptor())) as Record<string, unknown>;
    edit(clone);
    return clone;
  }

  /** 语料子对象取值(测试语料形态受控;缺键即编程错误,快速失败)。 */
  function sub(object: unknown, key: string): Record<string, unknown> {
    const value = (object as Record<string, unknown>)[key];
    if (typeof value !== "object" || value === null) {
      throw new Error(`语料子对象缺失:${key}`);
    }
    return value as Record<string, unknown>;
  }

  /** 语料数组字段取值。 */
  function list(object: unknown, key: string): Record<string, unknown>[] {
    const value = (object as Record<string, unknown>)[key];
    if (!Array.isArray(value)) {
      throw new Error(`语料数组缺失:${key}`);
    }
    return value as Record<string, unknown>[];
  }

  /** 语料数组元素取值。 */
  function item(elements: Record<string, unknown>[], index: number): Record<string, unknown> {
    const value = elements[index];
    if (typeof value !== "object" || value === null) {
      throw new Error(`语料数组元素缺失:${String(index)}`);
    }
    return value;
  }

  const redCases: readonly [string, (clone: Record<string, unknown>) => void][] = [
    ["未知顶层字段(I-1)", (clone) => { clone["secrets"] = { flag: "FLAG{leak}" }; }],
    ["缺失必需字段(briefing)", (clone) => { delete clone["briefing"]; }],
    ["schemaVersion 漂移", (clone) => { clone["schemaVersion"] = 2; }],
    ["challengeId 非字符串", (clone) => { clone["challengeId"] = 42; }],
    ["learningObjectives 空数组(minItems 1)", (clone) => {
      sub(clone, "briefing")["learningObjectives"] = [];
    }],
    ["archBits 非 32/64", (clone) => {
      sub(clone, "vmProfile")["archBits"] = 128;
    }],
    ["endianness 非 little", (clone) => {
      sub(clone, "vmProfile")["endianness"] = "big";
    }],
    ["canary.enabled 非布尔", (clone) => {
      sub(clone, "vmProfile")["canary"] = { enabled: "yes" };
    }],
    ["registers 空数组(minItems 1)", (clone) => {
      sub(clone, "vmProfile")["registers"] = [];
    }],
    ["encodingTable 空数组(存在即 minItems 1)", (clone) => {
      sub(clone, "vmProfile")["encodingTable"] = [];
    }],
    ["编码表操作数 kind 非封闭集", (clone) => {
      const entry = item(list(sub(clone, "vmProfile"), "encodingTable"), 1);
      item(list(entry, "operands"), 0)["kind"] = "magic";
    }],
    ["memoryLayout.regions 空(minItems 1)", (clone) => {
      sub(clone, "memoryLayout")["regions"] = [];
    }],
    ["region kind 非封闭枚举", (clone) => {
      item(list(sub(clone, "memoryLayout"), "regions"), 0)["kind"] = "rom";
    }],
    ["allowedActions 携带未知动作", (clone) => { clone["allowedActions"] = ["teleport"]; }],
    ["hintLadder revealPolicy 非双值枚举", (clone) => {
      item(list(clone, "hintLadder"), 0)["revealPolicy"] = "always";
    }],
    ["after_n_failures 缺 failureThreshold(Schema if/then)", (clone) => {
      delete item(list(clone, "hintLadder"), 1)["failureThreshold"];
    }],
    ["hint order 非 ≥1 数字", (clone) => {
      item(list(clone, "hintLadder"), 0)["order"] = 0;
    }],
    ["errorCode 不在 16 值冻结枚举", (clone) => {
      item(list(clone, "publicErrorMapping"), 0)["errorCode"] = "very_bad";
    }],
    ["teachingNote 空串", (clone) => {
      item(list(clone, "publicErrorMapping"), 0)["teachingNote"] = "";
    }],
    ["initialProjection.visibleRegions 空(minItems 1)", (clone) => {
      sub(clone, "initialProjection")["visibleRegions"] = [];
    }],
    ["visibleRegisters 空(minItems 1)", (clone) => {
      sub(clone, "initialProjection")["visibleRegisters"] = [];
    }],
    ["semanticHighlights kind 非封闭枚举", (clone) => {
      sub(clone, "initialProjection")["semanticHighlights"] = [
        { kind: "magic", targetRegionId: "code", startAddressHex: "0x400000", byteLength: 1, label: "x" },
      ];
    }],
    ["debugMode 非布尔", (clone) => { clone["debugMode"] = "true"; }],
    ["aslrEnabled 非布尔", (clone) => { clone["aslrEnabled"] = 1; }],
    ["randomizationNotice 非字符串", (clone) => { clone["randomizationNotice"] = 3; }],
  ];

  for (const [name, edit] of redCases) {
    it(`${name} → bad-shape`, async () => {
      const { outcome } = await load({}, () => okResponse(broken(edit)));
      expectReason(outcome, "bad-shape");
    });
  }

  it("parseDescriptorView 直接校验:合法语料绿 / 破坏语料红(不经网络)", () => {
    expect(parseDescriptorView(makeDescriptor())).not.toBeNull();
    expect(parseDescriptorView(broken((clone) => { clone["hintLadder"] = "ladder"; }))).toBeNull();
  });
});

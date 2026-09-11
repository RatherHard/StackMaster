/**
 * M2 描述包正式下发通道测试(WP-54;mock 宿主 + mock 引导端点 + mock
 * session-api 全链路):
 *  - 正常下发:GET /descriptors/:challengeId/:version → 摘要校验通过 →
 *    hintLadder / publicErrorMapping / 静态面 / debugMode 门控注入 workspace
 *    (FE-ED-06 / FE-ED-07 正式通道消费;教学面板 DOM 直读);
 *  - 时序:描述包与 create_session 并行,workspace 就绪不被描述包阻塞(晚到
 *    即注入);
 *  - 红灯:404 / 摘要篡改 / ETag 缺失 / 结构坏形态 → 确定性缺席明示(会话
 *    照常建立、debugMode 门控关闭、失败细节零透出;非网络失败零重试)。
 */
import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { PwnMemoryVm } from "../src/index.js";
import { SessionClient, type SmWorkspace, type WebSocketFactory } from "@stackmaster/vm-ui";
import {
  createSessionResponseBody,
  FakeClock,
  FakeFrames,
  FakeParentWindow,
  FakeScheduler,
  FakeWebSocket,
  flushMicrotasks,
  HOST_ORIGIN,
  readyMessage,
  TEST_ESID,
} from "./helpers.js";
import type { RecordedRequest } from "./helpers.js";

const BOOTSTRAP_URL = "https://host.example/host-api/embed-bootstrap";
const SESSION_API_ORIGIN = "https://sessionapi.example";
const CHALLENGE_ID = "challenge-wp54-0001";
const CHALLENGE_VERSION = "1.0.0";
const DESCRIPTOR_URL = `${SESSION_API_ORIGIN}/descriptors/${CHALLENGE_ID}/${CHALLENGE_VERSION}`;

/** Node webcrypto 摘要(jsdom 注入;与浏览器 WebCrypto 同语义)。 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const exact = new Uint8Array(bytes); // 复制为精确尺寸缓冲(规避 DOM/Node BufferSource 型差)。
  const digest = await webcrypto.subtle.digest("SHA-256", exact.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 合法公开描述包语料(对齐锚 = 公开 Schema;占位数据零秘密)。 */
function makeDescriptor(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    challengeId: CHALLENGE_ID,
    challengeContentVersion: CHALLENGE_VERSION,
    vmProfileVersion: "1.0.0",
    locale: "zh-CN",
    briefing: {
      title: "WP-54 正式下发题目",
      summary: "描述包正式通道端到端语料(占位)。",
      learningObjectives: ["理解正式通道数据流"],
    },
    vmProfile: {
      registers: [{ name: "RAX" }, { name: "RSP" }],
      flagRegisterNames: ["FLAG0"],
      endianness: "little",
      archBits: 64,
      pageSizeBytes: 4096,
      canary: { enabled: true, sizeBytes: 8 },
      encodingTable: [{ tokenHex: "c3", op: "ret" }],
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
      { order: 1, revealPolicy: "on_request", hintText: "正式通道提示一:观察 rip。" },
      { order: 2, revealPolicy: "after_n_failures", failureThreshold: 2, hintText: "正式通道提示二:计算偏移。" },
    ],
    publicErrorMapping: [{ errorCode: "inaccessible_address", teachingNote: "正式通道注解:地址不可见。" }],
    debugMode: true,
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
      visibleRegisters: [{ name: "RSP", valueHex: "0x7FFFFFF8" }],
    },
  };
}

interface DescriptorResponse {
  /** 响应形态(null = 抛网络错误)。 */
  body: unknown | null;
  status: number;
  /** ETag(null = 不带头;缺省键 = 按体摘要)。 */
  etag?: string | null;
}

interface ChainOptions {
  readonly descriptorResponse?: DescriptorResponse | ((url: string) => DescriptorResponse);
}

/** 组装全链路元素(mock 全部传输面;返回断言面)。 */
async function mountChain(options: ChainOptions = {}) {
  const clock = new FakeClock();
  const scheduler = new FakeScheduler(clock);
  const frames = new FakeFrames();
  const parent = new FakeParentWindow();
  const requests: RecordedRequest[] = [];
  const element = document.createElement("pwn-memory-vm") as PwnMemoryVm;
  element.locationHash = `#esid=${TEST_ESID}`;
  element.bootstrapEndpoint = BOOTSTRAP_URL;
  element.handshakeTimeoutMs = 30000;
  element.parentWindow = parent;
  element.clock = () => clock.now();
  element.scheduler = scheduler;
  element.frameScheduler = frames;
  element.measureHeight = () => 480;
  element.sha256Hex = sha256Hex;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body ?? "null")) as unknown,
    };
    requests.push(request);
    if (request.url === BOOTSTRAP_URL && request.method === "POST") {
      return new Response(
        JSON.stringify({
          embedToken: "opaque-embed-token-wp54",
          sessionApiOrigin: SESSION_API_ORIGIN,
          challengeId: CHALLENGE_ID,
          challengeVersion: CHALLENGE_VERSION,
          embedSessionId: TEST_ESID,
        }),
        { status: 200 },
      );
    }
    if (request.url === `${SESSION_API_ORIGIN}/sessions` && request.method === "POST") {
      return new Response(JSON.stringify(createSessionResponseBody("session-wp54-0001")), { status: 201 });
    }
    if (request.url.startsWith(`${SESSION_API_ORIGIN}/descriptors/`)) {
      const specified =
        typeof options.descriptorResponse === "function"
          ? await options.descriptorResponse(request.url)
          : (options.descriptorResponse ?? { body: makeDescriptor(), status: 200 });
      // 处理器直接返回构造好的 Response(如手工桥接的挂起响应)时原样放行。
      if (specified instanceof Response) {
        return specified;
      }
      if (specified.body === null) {
        throw new TypeError("network failure");
      }
      const headers: Record<string, string> = {};
      if (specified.etag !== null) {
        const etag =
          specified.etag ??
          `"${await sha256Hex(new TextEncoder().encode(JSON.stringify(specified.body)))}"`;
        headers["etag"] = etag;
      }
      return new Response(JSON.stringify(specified.body), { status: specified.status, headers });
    }
    return new Response(JSON.stringify({ code: "invalid_input_format", message: "resource not found" }), {
      status: 404,
    });
  }) as typeof fetch;
  element.fetchImpl = fetchImpl;
  element.createSessionClient = (sessionOptions) =>
    new SessionClient({
      ...sessionOptions,
      fetch: fetchImpl,
      webSocketFactory: ((url: string) => new FakeWebSocket(url)) as WebSocketFactory,
    });
  document.body.append(element);
  await element.updateComplete;

  const dispatchFromHost = (data: unknown): void => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: HOST_ORIGIN,
        source: parent as unknown as MessageEventSource,
        data,
      }),
    );
  };
  return {
    element,
    requests,
    dispatchFromHost,
    workspace: (): SmWorkspace => {
      const workspace = element.shadowRoot?.querySelector("sm-workspace");
      if (workspace === null || workspace === undefined) throw new Error("workspace 未挂载");
      return workspace as SmWorkspace;
    },
    workspaceProp: <T>(name: string): T => {
      const workspace = element.shadowRoot?.querySelector("sm-workspace");
      if (workspace === null || workspace === undefined) throw new Error("workspace 未挂载");
      return (workspace as unknown as Record<string, unknown>)[name] as T;
    },
    /** 跨双层 shadow:pwn → sm-workspace → 教学面板 DOM 文本。 */
    workspaceDomText: (): string => {
      const workspace = element.shadowRoot?.querySelector("sm-workspace");
      const root = workspace?.shadowRoot;
      if (root === null || root === undefined) throw new Error("workspace shadow 缺失");
      return root.textContent ?? "";
    },
    async settle(): Promise<void> {
      await flushMicrotasks();
      // 摘要注入走 Node webcrypto(线程池真异步):补数个宏任务轮保证落定。
      for (let i = 0; i < 4; i += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await flushMicrotasks(2);
      }
      await element.updateComplete;
    },
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("描述包正式通道:正常下发注入", () => {
  it("GET 描述包 → 摘要校验通过 → loaded;hintLadder / publicErrorMapping / 静态面 / debugMode 注入", async () => {
    const h = await mountChain();
    h.dispatchFromHost(readyMessage(TEST_ESID));
    await h.settle();

    expect(h.element.phase).toBe("session-ready");
    expect(h.element.descriptorStatus).toBe("loaded");
    // GET 描述包请求恰一次(定位来自引导配置的题目上下文)。
    const descriptorCalls = h.requests.filter((r) => r.url === DESCRIPTOR_URL);
    expect(descriptorCalls).toHaveLength(1);
    expect(descriptorCalls[0]?.method).toBe("GET");

    const descriptor = h.workspaceProp<{ hintLadder: unknown[]; publicErrorMapping: unknown[] } | null>(
      "challengeDescriptor",
    );
    expect(descriptor?.hintLadder).toHaveLength(2);
    expect(descriptor?.publicErrorMapping).toEqual([
      { errorCode: "inaccessible_address", teachingNote: "正式通道注解:地址不可见。" },
    ]);
    expect(h.workspaceProp<boolean>("debugModeAvailable")).toBe(true);
    const staticFace = h.workspaceProp<{ title: string } | null>("challengeStatic");
    expect(staticFace?.title).toBe("WP-54 正式下发题目");
  });

  it("教学面板 DOM 由正式下发数据驱动(提示阶梯 + 错误注解挂接)", async () => {
    const h = await mountChain();
    h.dispatchFromHost(readyMessage(TEST_ESID));
    await h.settle();
    const root = h.workspace().shadowRoot;
    const ladder = root?.querySelector("sm-hint-ladder");
    // after_n_failures 锁定文案来自正式下发阈值(revealPolicy 浏览器本地执行;
    // 嵌套 shadow 文本须读 sm-hint-ladder 自身 shadowRoot)。
    expect(ladder?.shadowRoot?.textContent).toContain("再失败 2 次解锁");
    // on_request 首条未揭示;点击「显示下一条提示」→ 正式下发提示文案揭示。
    const revealButton = ladder?.shadowRoot?.querySelector<HTMLButtonElement>(".reveal-button");
    expect(revealButton).not.toBeNull();
    revealButton?.click();
    await h.settle();
    expect(ladder?.shadowRoot?.textContent).toContain("正式通道提示一:观察 rip。");
    // 静态面:标题渲染(briefing.title)。
    expect(root?.textContent).toContain("WP-54 正式下发题目");
  });
});

describe("描述包正式通道:时序(不阻塞 workspace 就绪)", () => {
  it("描述包响应未决 → 会话照常建立(loading);晚到注入 → loaded", async () => {
    // 挂起响应门闸(holder 规避 TS 对闭包回写的 CAF 收窄)。
    const gate: { release: ((response: Response) => void) | null } = { release: null };
    const pending = new Promise<Response>((resolve) => {
      gate.release = resolve;
    });
    let descriptorRequested = false;
    const h = await mountChain({
      descriptorResponse: () => {
        descriptorRequested = true;
        // 借道:把挂起的 Promise 桥接为 fetch 返回(类型面收敛为 Response)。
        return pending as unknown as Response;
      },
    });
    h.dispatchFromHost(readyMessage(TEST_ESID));
    await h.settle();
    // 会话已就绪,描述包仍在途:workspace 不被阻塞。
    expect(h.element.phase).toBe("session-ready");
    expect(descriptorRequested).toBe(true);
    expect(h.element.descriptorStatus).toBe("loading");

    gate.release?.(
      new Response(JSON.stringify(makeDescriptor()), {
        status: 200,
        headers: { etag: `"${await sha256Hex(new TextEncoder().encode(JSON.stringify(makeDescriptor())))}"` },
      }),
    );
    await h.settle();
    expect(h.element.descriptorStatus).toBe("loaded");
    expect(h.workspaceProp<{ title: string } | null>("challengeStatic")?.title).toBe("WP-54 正式下发题目");
  });
});

describe("描述包正式通道:红灯(确定性缺席明示,会话不受影响)", () => {
  /** 断言:缺席明示态 + 会话照常 + debug 门控关闭 + 零内部透出。 */
  async function expectAbsent(
    options: ChainOptions & { readonly descriptorCallsExpected?: number },
  ): Promise<void> {
    const h = await mountChain(options);
    h.dispatchFromHost(readyMessage(TEST_ESID));
    await h.settle();
    expect(h.element.phase).toBe("session-ready");
    expect(h.element.descriptorStatus).toBe("absent");
    expect(h.workspaceProp<boolean>("debugModeAvailable")).toBe(false);
    expect(h.workspaceProp("challengeDescriptor")).toBeNull();
    expect(h.workspaceProp("challengeStatic")).toBeNull();
    // 缺席明示面板:静态文案,零失败细节(URL / 原因码不进 DOM)。
    const text = h.workspaceDomText();
    expect(text).toContain("题目描述未加载");
    expect(text).not.toContain("digest-mismatch");
    expect(text).not.toContain(DESCRIPTOR_URL);
    const calls = h.requests.filter((r) => r.url === DESCRIPTOR_URL).length;
    expect(calls).toBe(options.descriptorCallsExpected ?? 1);
  }

  it("404(未登记)→ absent;非网络失败零重试(恰一次请求)", async () => {
    await expectAbsent({ descriptorResponse: { body: { code: "invalid_input_format" }, status: 404 } });
  });

  it("摘要篡改(ETag 与体不符)→ absent", async () => {
    await expectAbsent({
      descriptorResponse: {
        body: makeDescriptor(),
        status: 200,
        etag: `"${await sha256Hex(new TextEncoder().encode("tampered"))}"`,
      },
    });
  });

  it("ETag 缺失(跨源未暴露响应头的部署形态)→ absent", async () => {
    await expectAbsent({ descriptorResponse: { body: makeDescriptor(), status: 200, etag: null } });
  });

  it("结构坏形态(未知字段)→ absent", async () => {
    const tampered = makeDescriptor();
    tampered["secrets"] = { flag: "FLAG{leak}" };
    await expectAbsent({ descriptorResponse: { body: tampered, status: 200 } });
  });

  it("网络失败(重试一次仍失败)→ absent;共两次请求", async () => {
    await expectAbsent({
      descriptorResponse: { body: null, status: 0 },
      descriptorCallsExpected: 2,
    });
  });
});

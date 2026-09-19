/**
 * 引导序列的行为锁定(分发改版 WP-92;组合根)。
 *
 * 依赖全部注入(路径 / origin / vm-ui 产物替身)⇒ 零网络、零真实产物。断言
 * 覆盖三条纪律:
 *  1. **零授权判断**:`createSession` 的入参**恰两键**(`challengeId` /
 *     `challengeVersion`),不带任何 token;
 *  2. **失败不重试**:`createSession` 抛错后**只调用一次**,呈现「地址已失效」;
 *  3. **描述包缺席不阻塞会话**:取包失败时工作区仍装配(`client` 已注入)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PAGE_NOTICE_SELECTOR,
  bootPage,
  descriptorStaticFace,
  invalidLaunchNotice,
} from "../src/boot.js";
import {
  WORKSPACE_ELEMENT_TAG,
  type DescriptorOutcomeLike,
  type LaunchIdentityLike,
  type VmUiModule,
} from "../src/vm-ui-module.js";

/** 记录调用的会话客户端替身(面与 vm-ui SessionClient 的结构子集一致)。 */
class FakeSessionClient {
  readonly created: LaunchIdentityLike[] = [];
  connected = 0;
  readonly sessionId: string | null = "session-fake-0001";
  readonly #failure: Error | null;

  constructor(failure: Error | null = null) {
    this.#failure = failure;
  }

  async createSession(identity: LaunchIdentityLike): Promise<unknown> {
    this.created.push(identity);
    if (this.#failure !== null) {
      throw this.#failure;
    }
    return { command: "create_session" };
  }

  connect(): void {
    this.connected += 1;
  }
}

/** 构造 vm-ui 产物替身(可指定客户端故障与描述包结果)。 */
function fakeModule(options: {
  readonly failure?: Error;
  readonly descriptor?: DescriptorOutcomeLike;
  readonly onDescriptor?: (input: {
    sessionApiOrigin: string;
    challengeId: string;
    challengeVersion: string;
  }) => void;
}): { module: VmUiModule; client: FakeSessionClient } {
  const client = new FakeSessionClient(options.failure ?? null);
  const module: VmUiModule = {
    SessionClient: function SessionClientStub(this: unknown) {
      return client;
    } as unknown as VmUiModule["SessionClient"],
    fetchChallengeDescriptor: async (input) => {
      options.onDescriptor?.(input);
      return options.descriptor ?? { ok: false, reason: "network" };
    },
  };
  return { module, client };
}

function mountRoot(): HTMLElement {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.querySelector<HTMLElement>("#app");
  if (root === null) {
    throw new Error("测试夹具缺少 #app");
  }
  return root;
}

/** 工作区元素选择器(与 vm-ui-module 的常量同源)。 */
const WORKSPACE_SELECTOR = WORKSPACE_ELEMENT_TAG;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("地址形态不符:呈现 + 零网络请求", () => {
  it("路径不是启动地址 ⇒ invalid-address,且**不加载** vm-ui 产物", async () => {
    const root = mountRoot();
    const loadModule = vi.fn();
    const result = await bootPage({ root, readPath: () => "/", loadModule });
    expect(result.status).toBe("invalid-address");
    expect(loadModule).not.toHaveBeenCalled();
    expect(root.querySelector(WORKSPACE_SELECTOR)).toBeNull();
  });
});

describe("vm-ui 产物不可用:呈现可操作提示,不白屏", () => {
  it("取不回 ⇒ vm-ui-unavailable", async () => {
    const root = mountRoot();
    const result = await bootPage({
      root,
      readPath: () => "/app/c/chal-0001/1.0.0",
      loadModule: async () => ({ ok: false, reason: "module-unreachable" }),
    });
    expect(result.status).toBe("vm-ui-unavailable");
    expect(root.querySelector(PAGE_NOTICE_SELECTOR)?.textContent).toContain("/vm-ui/index.js");
  });
});

describe("正常链:createSession(恰两键)→ connect → 描述包 → 挂工作区", () => {
  it("createSession 入参恰两键,**不带任何 token / 会话标识**", async () => {
    const root = mountRoot();
    const { module, client } = fakeModule({});
    const result = await bootPage({
      root,
      readPath: () => "/app/c/chal-0001/1.0.0",
      readOrigin: () => "https://lab.example.test",
      loadModule: async () => ({ ok: true, module }),
    });

    expect(result.status).toBe("ready");
    expect(client.created).toHaveLength(1);
    const identity = client.created[0];
    expect(identity).toEqual({ challengeId: "chal-0001", challengeVersion: "1.0.0" });
    // 结构性断言:键集恰为这两键(任何新增字段都会让本断言变红)。
    expect(Object.keys(identity ?? {}).sort()).toEqual(["challengeId", "challengeVersion"]);
  });

  it("connect 恰调用一次;工作区注入 client 并挂到挂载根", async () => {
    const root = mountRoot();
    const { module, client } = fakeModule({});
    const result = await bootPage({
      root,
      readPath: () => "/app/c/chal-0001/1.0.0",
      readOrigin: () => "https://lab.example.test",
      loadModule: async () => ({ ok: true, module }),
    });

    expect(client.connected).toBe(1);
    expect(result.workspace).not.toBeNull();
    expect(root.querySelector(WORKSPACE_SELECTOR)).toBe(result.workspace);
    expect((result.workspace as unknown as { client: unknown }).client).toBe(client);
  });

  it("描述包以**同源绝对 origin** 取,且只取当前题目", async () => {
    const root = mountRoot();
    const seen: unknown[] = [];
    const { module } = fakeModule({ onDescriptor: (input) => seen.push(input) });
    await bootPage({
      root,
      readPath: () => "/app/c/chal-0001/1.0.0",
      readOrigin: () => "https://lab.example.test",
      loadModule: async () => ({ ok: true, module }),
    });
    expect(seen).toEqual([
      {
        sessionApiOrigin: "https://lab.example.test",
        challengeId: "chal-0001",
        challengeVersion: "1.0.0",
      },
    ]);
  });
});

describe("描述包缺席:**不阻塞会话**(缺席明示,不是失败)", () => {
  it("取包失败 ⇒ 状态仍是 ready,client 已注入,descriptorStatus = absent,并有明示提示", async () => {
    const root = mountRoot();
    const { module, client } = fakeModule({ descriptor: { ok: false, reason: "network" } });
    const result = await bootPage({
      root,
      readPath: () => "/app/c/chal-0001/1.0.0",
      readOrigin: () => "https://lab.example.test",
      loadModule: async () => ({ ok: true, module }),
    });

    expect(result.status).toBe("ready");
    const workspace = result.workspace as unknown as {
      client: unknown;
      descriptorStatus: string;
      debugModeAvailable: boolean;
    };
    expect(workspace.client).toBe(client);
    expect(workspace.descriptorStatus).toBe("absent");
    expect(workspace.debugModeAvailable).toBe(false);
    expect(result.notes.some((note) => note.text.includes("描述包未加载"))).toBe(true);
  });

  it("取包成功 ⇒ descriptorStatus = loaded + 教学切面注入(debugMode 缺省 = 启用)", async () => {
    const root = mountRoot();
    const { module } = fakeModule({
      descriptor: {
        ok: true,
        descriptor: {
          briefing: { title: "栈帧入门", summary: "改返回地址" },
          vmProfile: { archBits: 64, registers: [{ name: "RAX" }], canary: { enabled: true } },
          hintLadder: [{ id: "h1" }],
          publicErrorMapping: [{ errorCode: "memory_fault" }],
        },
      },
    });
    const result = await bootPage({
      root,
      readPath: () => "/app/c/chal-0001/1.0.0",
      readOrigin: () => "https://lab.example.test",
      loadModule: async () => ({ ok: true, module }),
    });

    const workspace = result.workspace as unknown as {
      descriptorStatus: string;
      debugModeAvailable: boolean;
      challengeDescriptor: unknown;
      challengeStatic: unknown;
    };
    expect(workspace.descriptorStatus).toBe("loaded");
    // 描述包未显式声明 debugMode ⇒ opt-out 语义 = 启用。
    expect(workspace.debugModeAvailable).toBe(true);
    expect(workspace.challengeDescriptor).toEqual({
      hintLadder: [{ id: "h1" }],
      publicErrorMapping: [{ errorCode: "memory_fault" }],
    });
    expect(workspace.challengeStatic).toEqual({
      title: "栈帧入门",
      summary: "改返回地址",
      archBits: 64,
      endianness: "little",
      pageSizeBytes: 0,
      registerNames: ["RAX"],
      canaryEnabled: true,
      encodingTable: [],
    });
  });
});

describe("descriptorStaticFace:briefing / vmProfile 不齐备即 null(不渲染该面)", () => {
  it("null / 非对象 / 缺 briefing / 缺 vmProfile 一律 null", () => {
    expect(descriptorStaticFace(null)).toBeNull();
    expect(descriptorStaticFace("x")).toBeNull();
    expect(descriptorStaticFace({ briefing: { title: "t", summary: "s" } })).toBeNull();
    expect(descriptorStaticFace({ vmProfile: {} })).toBeNull();
  });
});

describe("create_session 失败:**不重试**,呈现地址已失效", () => {
  it("抛错 ⇒ session-failed;createSession 只被调用一次;文案 = 失效提示", async () => {
    const root = mountRoot();
    const failure = Object.assign(new Error("unauthorized"), { status: 401 });
    const { module, client } = fakeModule({ failure });
    const result = await bootPage({
      root,
      readPath: () => "/app/c/chal-0001/1.0.0",
      readOrigin: () => "https://lab.example.test",
      loadModule: async () => ({ ok: true, module }),
    });

    expect(result.status).toBe("session-failed");
    expect(client.created).toHaveLength(1);
    expect(client.connected).toBe(0);
    expect(root.querySelector(WORKSPACE_SELECTOR)).toBeNull();
    const noticeText = root.querySelector(PAGE_NOTICE_SELECTOR)?.textContent ?? "";
    expect(noticeText).toContain(invalidLaunchNotice().text);
  });
});

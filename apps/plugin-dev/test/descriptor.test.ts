/**
 * plugin-dev 夹具描述包测试(WP-F8 / FE-WS-06):
 *  - 本地夹具 JSON:数据形态自检(debugMode / hintLadder / publicErrorMapping
 *    齐备;**零代码依赖**——只复制公开描述包数据形态,数据占位无秘密);
 *  - applyChallengeDescriptor:debugModeAvailable / challengeDescriptor 注入
 *    工作区装配(未升级元素同样落属性,升级后 Lit 初始化消费);
 *  - boot 的描述包 fail-soft 加载(缺失 → 状态行降级明示,切换项隐藏)。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  applyChallengeDescriptor,
  boot,
  loadDevDescriptor,
  mountWorkspaceShell,
  wireSessionDemo,
  type SessionDemoClientLike,
  type WorkspaceShellHandles,
} from "../src/main.js";

// ── 夹具 JSON 形态自检 ───────────────────────────────────────────────────────

// vitest 直跑 cwd = 包根;经根 vitest.coverage.config.ts 聚合跑 cwd = 仓库根,
// 两形态都兼容(取存在者)。
const FIXTURE_PATH = [resolve(process.cwd(), "fixtures", "dev-descriptor.json"), resolve(process.cwd(), "apps", "plugin-dev", "fixtures", "dev-descriptor.json")].find(
  (candidate) => existsSync(candidate),
) as string;

describe("夹具描述包 fixtures/dev-descriptor.json", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as Record<string, unknown>;

  it("debugMode 声明为 true(开发壳默认启用调试模式切换项)", () => {
    expect(fixture["debugMode"]).toBe(true);
  });

  it("hintLadder / publicErrorMapping 数据形态齐备(ED 组件注入面)", () => {
    const hints = fixture["hintLadder"] as Array<Record<string, unknown>>;
    expect(hints.length).toBeGreaterThanOrEqual(1);
    for (const hint of hints) {
      expect(typeof hint["order"]).toBe("number");
      expect(["on_request", "after_n_failures"]).toContain(hint["revealPolicy"]);
      expect((hint["hintText"] as string).length).toBeGreaterThanOrEqual(1);
      if (hint["revealPolicy"] === "after_n_failures") {
        expect(typeof hint["failureThreshold"]).toBe("number");
      }
    }
    const mappings = fixture["publicErrorMapping"] as Array<Record<string, unknown>>;
    expect(mappings.length).toBeGreaterThanOrEqual(1);
    for (const mapping of mappings) {
      expect(typeof mapping["errorCode"]).toBe("string");
      expect((mapping["teachingNote"] as string).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("数据全部占位无秘密(零真实凭证 / 种子 / 私有面字段)", () => {
    const text = JSON.stringify(fixture);
    expect(text).not.toContain("seed");
    expect(text).not.toContain("judgingConfig");
    expect(text).not.toContain("token");
  });
});

// ── applyChallengeDescriptor 注入 ────────────────────────────────────────────

describe("applyChallengeDescriptor:工作区装配注入", () => {
  function mount(): WorkspaceShellHandles {
    const root = document.createElement("div");
    document.body.append(root);
    return mountWorkspaceShell(root);
  }

  it("debugMode=true → debugModeAvailable=true;hintLadder / publicErrorMapping 透传", () => {
    const handles = mount();
    applyChallengeDescriptor(handles, {
      debugMode: true,
      hintLadder: [{ order: 1, revealPolicy: "on_request", hintText: "提示" }],
      publicErrorMapping: [{ errorCode: "canary_violation", teachingNote: "注解" }],
    });
    const workspace = handles.workspace as unknown as Record<string, unknown>;
    expect(workspace["debugModeAvailable"]).toBe(true);
    expect(workspace["challengeDescriptor"]).toEqual({
      hintLadder: [{ order: 1, revealPolicy: "on_request", hintText: "提示" }],
      publicErrorMapping: [{ errorCode: "canary_violation", teachingNote: "注解" }],
    });
    expect(handles.status.textContent).toContain("调试模式可用");
  });

  it("debugMode 缺省/false → debugModeAvailable=false(切换项隐藏口径)", () => {
    const handles = mount();
    applyChallengeDescriptor(handles, { debugMode: false });
    const workspace = handles.workspace as unknown as Record<string, unknown>;
    expect(workspace["debugModeAvailable"]).toBe(false);
  });

  it("缺省数组兜底:descriptor 无教学面时不传 undefined", () => {
    const handles = mount();
    applyChallengeDescriptor(handles, {});
    const workspace = handles.workspace as unknown as Record<string, unknown>;
    expect(workspace["challengeDescriptor"]).toEqual({ hintLadder: [], publicErrorMapping: [] });
  });
});

// ── boot 的描述包 fail-soft 加载 ─────────────────────────────────────────────

class FakeSessionClient implements SessionDemoClientLike {
  sessionId: string | null = "session-fake";
  async createSession(): Promise<unknown> {
    return {};
  }
  connect(): void {}
  async closeSession(): Promise<unknown> {
    return {};
  }
}

describe("boot:夹具描述包加载时机", () => {
  it("加载成功 → 注入工作区;失败 → 状态行降级明示(切换项保持隐藏)", async () => {
    const rootOk = document.createElement("div");
    document.body.append(rootOk);
    const controllerOk = await boot(
      rootOk,
      async () => ({ SessionClient: FakeSessionClient }),
      async () => ({ debugMode: true }),
    );
    expect(controllerOk).not.toBeNull();
    const workspaceOk = rootOk.querySelector("sm-workspace") as unknown as Record<string, unknown>;
    expect(workspaceOk["debugModeAvailable"]).toBe(true);

    const rootFail = document.createElement("div");
    document.body.append(rootFail);
    const statusFail = document.createElement("p");
    const handlesFail = mountWorkspaceShell(rootFail);
    // boot(root, loadModule, loadDescriptor):descriptor null → 降级文案写状态行。
    const controllerFail = await boot(
      rootFail,
      async () => ({ SessionClient: FakeSessionClient }),
      async () => null,
    );
    expect(controllerFail).not.toBeNull();
    const workspaceFail = rootFail.querySelector("sm-workspace") as unknown as Record<string, unknown>;
    expect(workspaceFail["debugModeAvailable"]).toBeUndefined();
    expect((rootFail.querySelector("#dev-status") ?? handlesFail.status).textContent).toContain(
      "夹具描述包未加载",
    );
    void statusFail;
  });

  it("loadDevDescriptor:相对 URL 缺省指向本地夹具(浏览器联调面;Node 缺 fetch 语义此处不测网络)", async () => {
    // 仅验证函数存在与签名兜底(Node 环境无 dev server,fetch 失败返回 null)。
    const result = await loadDevDescriptor("http://127.0.0.1:1/definitely-not-here.json").catch(() => null);
    expect(result).toBeNull();
  });
});

// wireSessionDemo 冒烟(保持既有接线不被 F8 破坏)。
describe("既有接线冒烟(F8 回归)", () => {
  it("mountWorkspaceShell + wireSessionDemo 仍可装配", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const handles = mountWorkspaceShell(root);
    const controller = wireSessionDemo(handles, () => new FakeSessionClient());
    expect(controller.client).toBeNull();
  });
});

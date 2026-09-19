/**
 * page-app 真机冒烟(分发改版 WP-92;真 chromium + 真 vm-ui 产物)。
 *
 * ## 断言面(逐条都对应一条纪律)
 *
 *  1. **工作区渲染出两个可见视图位**,且**无 401**:`POST /sessions` 恰一次
 *     200/201 应答(由本文件按契约形态注入),`sm-workspace` 在**左半侧**渲染
 *     出 ≥ 2 个 `.ws-view` 面板(D-UI-2:固定两个可见视图位);
 *  2. **窄屏(375px)右半侧仍可达**(D-UI-5):`documentElement.scrollWidth >
 *     innerWidth`(页面横向滚动未被 `overflow: hidden` 升格成裁剪),
 *     且把右半侧滚入视口后它在视口内 —— 这是 WP-93/94 实测到的坑的**回归护栏**;
 *  3. **整页不纵向溢出**(遗留 #37 判据):`scrollHeight ≤ innerHeight + 1`;
 *  4. **页面不读票据、不做授权判断**:地址里带一个假票据查询串时,页面发出的
 *     `POST /sessions` 仍然只有题目两键(查询串不参与),且**不发**任何探测请求。
 *
 * ## 未覆盖(如实登记)
 *
 * 真后端链路(签发 → 换票 → Cookie → create_session)本机 **Docker 不可用**、
 * 起不了拓扑 ⇒ 不在本文件断言范围;命令与承接方(WP-95)见 `README.md`。
 */
import { expect, test, type Page, type Route } from "@playwright/test";

import { launchRedeemPath } from "../src/launch-path.js";

const CHALLENGE_ID = "chal-stack-escape";
const CHALLENGE_VERSION = "1.2.3";

/**
 * 契约合法的公开投影(7 字段;最小可行形态)。
 *
 * 形态锚 = 服务端测试假 worker 的 `baseProjection`
 * (`apps/session-api/test/routes/helpers/fake-worker.mjs`):浏览器侧不负责
 * 推导投影,这里只是把一份合法形态喂给真产物。
 */
const PROJECTION = {
  revision: 0,
  visibleRegions: [
    {
      regionId: "code",
      label: "代码区",
      startAddressHex: "0x401000",
      byteLength: 4096,
      permissions: "rx",
      bytesHex: "554889e54883ec2048897dfcb8000000",
      truncated: true,
    },
    {
      regionId: "stack",
      label: "栈区",
      startAddressHex: "0x7FFFF000",
      byteLength: 8192,
      permissions: "rw",
      bytesHex: "000000000000000011111111111111112222222222222222",
      truncated: true,
    },
  ],
  visibleRegisters: [
    { name: "RAX", valueHex: "0x0" },
    { name: "RIP", valueHex: "0x401000" },
  ],
  callStackSummary: [],
  controlFlow: { currentInstruction: { addressHex: "0x401000", text: "push rbp" }, pausedOn: null },
  semanticHighlights: [],
  status: "running",
} as const;

/** 记录页面发出的 `POST /sessions` 请求体(断言"恰一次 + 恰两键")。 */
interface CapturedSessions {
  /** 收到的 create_session 请求体(信封形态)。 */
  readonly bodies: unknown[];
  /** 401 响应计数(`unauthorized()` 读取;**零 401 是本冒烟的红线之一**)。 */
  unauthorized(): number;
}

/**
 * 安装 create_session 应答(契约 `SessionCommandResponse` 的 create_session 分支:
 * `{command, payload:{sessionId, revision, projection}}`)。
 *
 * **只拦截 `POST /sessions`**:其余前缀(`/descriptors` 等)一律放行 —— 描述包
 * 取不回恰好构成"缺席明示、不阻塞会话"的真机证据(vm-ui 加载器会自己重试
 * 一次后返回失败,页面照常装配)。
 */
async function installCreateSessionStub(page: Page): Promise<CapturedSessions> {
  const bodies: unknown[] = [];
  let unauthorized = 0;
  const captured: CapturedSessions = {
    bodies,
    unauthorized: () => unauthorized,
  };
  // glob **不带 `**` 前缀** = 精确路径(`/sessions`),不会顺带吃掉
  // `/sessions/channel` 等子路径。
  await page.route("/sessions", async (route: Route) => {
    const request = route.request();
    if (request.method() !== "POST") {
      await route.fallback();
      return;
    }
    bodies.push(request.postDataJSON());
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        command: "create_session",
        payload: { sessionId: "session-e2e-0001", revision: 0, projection: PROJECTION },
      }),
    });
  });
  page.on("response", (response) => {
    if (response.status() === 401) {
      unauthorized += 1;
    }
  });
  return captured;
}

/** 打开启动地址(可带假票据查询串;页面**不得**读它)。 */
async function openLaunchAddress(page: Page, query = ""): Promise<void> {
  await page.goto(`${launchRedeemPath(CHALLENGE_ID, CHALLENGE_VERSION)}${query}`);
  await expect(page.locator("sm-workspace")).toHaveCount(1);
}

/** 工作区影子根里的查询(Playwright 的 CSS 引擎自动穿透 shadow DOM)。 */
const workspaceHandle = (page: Page) => page.locator("sm-workspace");

test.describe("真机冒烟:真 vm-ui 产物 + 同源 create_session 应答", () => {
  test("工作区渲染出两个可见视图位,且页面只发一次 create_session(无 401)", async ({ page }) => {
    const captured = await installCreateSessionStub(page);
    await openLaunchAddress(page);

    // create_session 恰一次;信封恰三键(command / protocolVersion / payload),
    // 而 **payload 恰两键**(授权不在载荷里,D-LT-5 5c:载荷只提供导航信息)。
    await expect.poll(() => captured.bodies.length).toBe(1);
    const envelope = captured.bodies[0] as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(["command", "payload", "protocolVersion"]);
    expect(envelope["command"]).toBe("create_session");
    const payload = envelope["payload"] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["challengeId", "challengeVersion"]);
    expect(payload).toMatchObject({
      challengeId: CHALLENGE_ID,
      challengeVersion: CHALLENGE_VERSION,
    });

    // 左半侧:**全部常驻视图位**在 DOM 里(登记表 10 类,payload 固定承载于
    // 右半侧 ⇒ 左半侧 9 个),其中**视口内 ≥ 2 个**(D-UI-2:两个可见视图位),
    // 其余由左半侧纵向滚动承载(下一用例断言 stack 是滚动容器)。
    const leftSlots = workspaceHandle(page).locator(".ws-left [data-view-panel]");
    await expect(leftSlots).toHaveCount(9, { timeout: 20_000 });
    await expect(leftSlots.nth(0)).toBeInViewport();
    await expect(leftSlots.nth(1)).toBeInViewport();
    // 最后一个视图位必须在视口之外(证明"可见两个"不是"全部都在视口内")。
    await expect(leftSlots.nth(8)).not.toBeInViewport();
    await expect(workspaceHandle(page).locator(".ws-right")).toBeVisible();

    // 无 401(换票失败由服务端在页面加载前 401,页面侧只处理 create_session 失败)。
    expect(captured.unauthorized()).toBe(0);
  });

  test("整页不纵向溢出:溢出由工作区内部滚动承载(遗留 #37 判据)", async ({ page }) => {
    await installCreateSessionStub(page);
    await openLaunchAddress(page);

    const geometry = await page.evaluate(() => ({
      innerHeight: window.innerHeight,
      scrollHeight: document.documentElement.scrollHeight,
      stackClientHeight: (document.querySelector("sm-workspace")?.shadowRoot?.querySelector(".ws-stack") as HTMLElement | null)?.clientHeight ?? -1,
      stackScrollHeight: (document.querySelector("sm-workspace")?.shadowRoot?.querySelector(".ws-stack") as HTMLElement | null)?.scrollHeight ?? -1,
    }));
    expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.innerHeight + 1);
    // 左半侧是滚动容器(视图位多于可见位时溢出落在这里,而不是压扁)。
    expect(geometry.stackScrollHeight).toBeGreaterThan(geometry.stackClientHeight);
    console.log(`[geometry:1440x900] ${JSON.stringify(geometry)}`);
  });

  test("窄屏 375px:右半侧仍可达(D-UI-5 回归护栏:不得用 overflow:hidden 裁剪)", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await installCreateSessionStub(page);
    await openLaunchAddress(page);
    await expect(workspaceHandle(page).locator(".ws-left [data-view-panel]").first()).toBeVisible();

    const readings = await page.evaluate(() => {
      const shadow = document.querySelector("sm-workspace")?.shadowRoot;
      const rect = (selector: string): { x: number; width: number } => {
        const element = shadow?.querySelector(selector) as HTMLElement | null;
        const box = element?.getBoundingClientRect();
        return { x: box?.x ?? -1, width: box?.width ?? -1 };
      };
      return {
        innerWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        docScrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
        left: rect(".ws-left"),
        right: rect(".ws-right"),
        stackClientHeight: (shadow?.querySelector(".ws-stack") as HTMLElement | null)?.clientHeight ?? -1,
        stackScrollHeight: (shadow?.querySelector(".ws-stack") as HTMLElement | null)?.scrollHeight ?? -1,
      };
    });
    // 真机读数留档(验收证据;不是断言,断言在下面)。
    console.log(`[geometry:375x667] ${JSON.stringify(readings)}`);

    // 两半侧各保底 452.4px ⇒ 网格 ≈ 905px > 375px ⇒ 文档层必须横向可滚。
    expect(readings.docScrollWidth - readings.innerWidth).toBeGreaterThan(0);
    // 纵向仍不溢出(整页定高链)。
    expect(readings.docScrollHeight).toBeLessThanOrEqual(readings.innerHeight + 1);
    // 右半侧在文档坐标里确实被推到视口之外(不是"看起来在右边"而已)。
    expect(readings.right.x).toBeGreaterThanOrEqual(readings.innerWidth);

    const right = workspaceHandle(page).locator(".ws-right");
    await right.scrollIntoViewIfNeeded();
    await expect(right).toBeInViewport();
  });

  test("地址带假票据查询串:页面不发任何探测请求,载荷仍只有题目两键", async ({ page }) => {
    const captured = await installCreateSessionStub(page);
    const requested: string[] = [];
    page.on("request", (request) => requested.push(new URL(request.url()).pathname));
    await openLaunchAddress(page, "?t=AAAAAAAAAAAAAAAAAAAAAA");

    await expect.poll(() => captured.bodies.length).toBe(1);
    expect((captured.bodies[0] as { payload: unknown }).payload).toMatchObject({
      challengeId: CHALLENGE_ID,
      challengeVersion: CHALLENGE_VERSION,
    });
    // 页面从不请求票据之外的授权面(`/auth/**` 零请求:浏览器侧不换票)。
    expect(requested.filter((pathname) => pathname.startsWith("/auth/"))).toEqual([]);
  });

  test("地址形态不符:呈现无效地址提示,零 create_session 请求", async ({ page }) => {
    const captured = await installCreateSessionStub(page);
    await page.goto("/");
    await expect(page.locator("[data-page-notice]")).toBeVisible();
    expect(captured.bodies).toHaveLength(0);
  });
});

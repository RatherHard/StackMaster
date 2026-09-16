/**
 * E2E:断点联动 + 伪汇编延伸(chromium 真机;WP-76 §2.3 #1/#2/#8)。
 *
 * 覆盖面(与 vm-ui 集成测试互补:
 * `packages/vm-ui/test/workspace/sm-workspace-breakpoint-linkage.test.ts` 承担
 * 组件级全链路,本 spec 只证明**真实浏览器 + 真实 compose 拓扑**下可达):
 *  ① 伪汇编延伸 chip(**解题档**):真实动作写入指针 → 字节视图跳转链延伸落到
 *     代码区 → 追加 chip,登记降级形态 = 引导文案「切换调试模式查看指令」;
 *  ② 断点联动(**调试档**):rip 初始视角锚定 / 伪汇编列右侧对齐(计算样式实测)/
 *     行断点 ↔ 调试档数据源联动 / payload 断点积木真实编译后并入断点集合 /
 *     伪汇编 chip 取调试通道已下发指令流(未覆盖则显式降级)。
 *
 * 程序装载用 `<sm-payload-tab>` 的**公共 API**(`loadWorkspaceState` +
 * `compileNow` + `runProgram`)——与宿主恢复程序同一入口;E2E 不做积木拖拽
 * (拖拽稳定性属 Blockly 面,不在本 WP 交付范围)。
 *
 * ⚠ 调试档用例前置:真实拓扑必须注册 `/sessions/debug-channel`。当前
 * `apps/session-api/src/index.ts` **未把 `runtime.debugChannel` 传入
 * `buildServer`**(测试桩 `test/routes/helpers/session-rig.ts:458` 传了,
 * 生产入口漏了 ⇒ 该路由 404)。属越界点(非本 WP 可改文件),已在 WP-76
 * 报告「需主控协调的越界点」登记;修复前调试档用例以显式前置断言失败,
 * 不伪装通过。
 */
import { expect, focusWindowButton, menuButton, test, workspaceWindow } from "./fixtures.js";

/** 栈顶地址(compose 种子题 STACK_BASE;写一个指向代码区的指针)。 */
const STACK_TOP = "0x7ffff000";
/** 代码区起点(compose 种子题 CODE_BASE)。 */
const CODE_BASE = "0x401000";

/** 小端 8 字节 = 0x401000。 */
const CODE_POINTER_HEX = "0010400000000000";

interface PayloadTabFace {
  loadWorkspaceState(state: unknown): void;
  compileNow(): unknown;
  runProgram(): void;
  breakpointAddresses(): string[];
  updateComplete: Promise<unknown>;
}

interface InstructionViewFace {
  anchorAddressHex: string | null;
  initialAnchorApplied: boolean;
}

interface WorkspaceFace {
  debugDataSource: {
    readonly breakpoints: readonly string[];
    readonly connectionStatus: string;
    readonly attached: unknown;
  } | null;
}

/** payload 程序:start → 写字节(addr ← bytes)[→ 断点积木]。 */
function writeProgram(options: { readonly withBreakpoint: boolean }): unknown {
  const write = {
    type: "payload_write_bytes",
    id: "wb",
    fields: { BYTES: CODE_POINTER_HEX },
    inputs: { ADDR: { block: { type: "payload_num", id: "addr", fields: { N: STACK_TOP } } } },
    ...(options.withBreakpoint
      ? { next: { block: { type: "payload_breakpoint", id: "bp" } } }
      : {}),
  };
  return {
    blocks: {
      languageVersion: 0,
      blocks: [{ type: "payload_start", id: "start", next: { block: write } }],
    },
  };
}

/** 进入调试模式并确认**调试实例真实 attach**(前置断言的根因可读性)。 */
async function enterDebugModeReachable(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("sm-workspace-menu button.mode-toggle-button").click();
  await expect(page.locator("sm-workspace-menu .mode-indicator")).toHaveText("调试模式");
  await expect
    .poll(
      async () =>
        page
          .locator("sm-workspace")
          .evaluate((element) => {
            const source = (element as unknown as WorkspaceFace).debugDataSource;
            return source === null
              ? "no-source"
              : `${source.connectionStatus}/${source.attached === null ? "not-attached" : "attached"}`;
          }),
      {
        timeout: 15_000,
        message:
          "调试实例未 attach(真实拓扑两个前置缺陷,均属越界点):" +
          "① session-api 未注册 /sessions/debug-channel —— apps/session-api/src/index.ts " +
          "需传入 debugChannel: runtime.debugChannel(现状 404);" +
          "② 注册后服务端 debug 变体构建失败(session-api 日志 type=DebugVariantBuildError、" +
          "回执 error/internal_error),attach 无法完成。",
      },
    )
    .toBe("connected/attached");
}

test.describe("WP-76 断点联动 + 伪汇编延伸(chromium 真机)", () => {
  test("伪汇编延伸(解题档):真实写入指针 → 链延伸落到代码区 → 降级引导 chip", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });

    // 1) 真实动作链路:payload 写指针到栈顶(执行器 → 会话动作 → 投影增量)。
    const payloadTab = page.locator("sm-payload-tab");
    await payloadTab.evaluate(async (element, state) => {
      const tab = element as unknown as PayloadTabFace;
      tab.loadWorkspaceState(state);
      await tab.updateComplete;
      tab.compileNow();
      tab.runProgram();
    }, writeProgram({ withBreakpoint: false }));
    // 执行器成功反馈(输出区 append-only;executor-status 会被投影刷新触发的
    // 重编译重置为 idle,不能作为完成信号)。
    await expect(payloadTab.locator(".output-log")).toContainText("已执行");

    // 2) 字节视图(栈视图窗口)切到栈区。
    await focusWindowButton(page, "stack").click();
    const stackView = workspaceWindow(page, "stack").locator("sm-byte-view");
    await stackView.locator("select.region-select").selectOption("stack");

    // 行地址大小写以渲染面为准(投影 / 数据源归一化形态不假设)。
    const renderedAddress = await stackView
      .locator(".byte-row[data-row-address]")
      .evaluateAll((rows) =>
        rows
          .map((row) => row.getAttribute("data-row-address") ?? "")
          .find((address) => address.toLowerCase() === "0x7ffff000"),
      );
    expect(renderedAddress).toBeTruthy();
    const stackRow = stackView.locator(`.byte-row[data-row-address="${renderedAddress}"]`);
    await expect(stackRow).toBeVisible();

    // 3) 链延伸落到可执行区域 ⇒ 追加伪汇编 chip:解题档 = 注册降级引导文案
    //    (无指令流数据,不伪造指令;chip 只读展示)。
    const chip = stackRow.locator("sm-jump-chain [data-pseudo-asm]");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("data-pseudo-asm-address", CODE_BASE);
    await expect(chip).toHaveAttribute("data-pseudo-asm-source", "solve");
    await expect(chip).toContainText("切换调试模式查看指令");
    expect(await chip.evaluate((element) => element.tagName)).toBe("SPAN");
  });

  test("断点联动(调试档):rip 初始锚定 / 伪汇编列右对齐 / 行断点联动 / payload 断点并入", async ({
    createdSession,
  }) => {
    const page = createdSession;
    await page.setViewportSize({ width: 1440, height: 900 });

    // 1) 进入调试模式(真实调试通道 attach;前置断言见文件头越界点说明)。
    await focusWindowButton(page, "debug").click();
    await enterDebugModeReachable(page);

    const instructionView = page.locator("sm-instruction-view");
    const rows = instructionView.locator(".instruction-row[data-instruction-address]");
    await expect(rows.first()).toBeVisible();

    // 2) 初始视角锚定(WP-75 #7):进入视图即按 rip 锚定一次,锚点行落在真实视口。
    const anchor = await instructionView.evaluate((element) => {
      const view = element as unknown as InstructionViewFace;
      return { addressHex: view.anchorAddressHex, applied: view.initialAnchorApplied };
    });
    expect(anchor.applied).toBe(true);
    expect(anchor.addressHex).not.toBeNull();
    if (anchor.addressHex !== null) {
      await expect(
        instructionView.locator(
          `.instruction-row[data-instruction-address="${anchor.addressHex}"]`,
        ),
      ).toBeInViewport();
    }

    // 3) 伪汇编列右侧单独对齐(真实计算样式)。
    const textAlign = await instructionView
      .locator(".instruction-row .row-text")
      .first()
      .evaluate((element) => getComputedStyle(element).textAlign);
    expect(["end", "right"]).toContain(textAlign);

    // 4) 行断点 ↔ 调试档数据源联动(FE-IN-08 × FE-WS-04c)。
    const toggle = instructionView
      .locator(`.instruction-row[data-instruction-address="${anchor.addressHex}"]`)
      .locator(".breakpoint-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const runToBreakpoint = menuButton(page, "run-to-breakpoint-button");
    await expect(runToBreakpoint).toBeEnabled();

    // 5) payload 断点积木真实编译 → 断点地址并入调试档集合(非空 + 含编译期地址)。
    const payloadTab = page.locator("sm-payload-tab");
    const addresses = await payloadTab.evaluate(async (element, state) => {
      const tab = element as unknown as PayloadTabFace;
      tab.loadWorkspaceState(state);
      await tab.updateComplete;
      tab.compileNow();
      return tab.breakpointAddresses();
    }, writeProgram({ withBreakpoint: true }));
    test.info().annotations.push({
      type: "payload-breakpoint-addresses",
      description: JSON.stringify(addresses),
    });
    expect(addresses.length).toBe(1);

    const breakpoints = await page.locator("sm-workspace").evaluate(
      (element) => (element as unknown as WorkspaceFace).debugDataSource?.breakpoints ?? [],
    );
    expect(breakpoints).toContain(addresses[0]);

    // 6) 伪汇编延伸 chip 调试档形态:指令流命中 = 真指令;未覆盖 = 显式降级文案
    //    (两档都不伪造指令;绝不回落解题档引导)。
    await focusWindowButton(page, "stack").click();
    const stackView = workspaceWindow(page, "stack").locator("sm-byte-view");
    await stackView.locator("select.region-select").selectOption("stack");
    const jumpInput = stackView.locator(".jump-input");
    await jumpInput.fill(STACK_TOP);
    await jumpInput.press("Enter");

    const chip = stackView.locator("sm-jump-chain [data-pseudo-asm]");
    await expect(chip).toBeVisible();
    const source = await chip.getAttribute("data-pseudo-asm-source");
    test.info().annotations.push({ type: "pseudo-asm-source(debug)", description: String(source) });
    expect(["debug", "no-coverage"]).toContain(source);
    if (source === "debug") {
      await expect(chip).toContainText(CODE_BASE);
    }
  });
});

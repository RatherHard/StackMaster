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
 * ⚠ 调试档用例的前置与**未达成项**(中期 WP-76;缺陷 1 / 2 / 3 已修,遗留 4 未修):
 *  ① 路由 404 —— `apps/session-api/src/index.ts` 生产入口未把
 *    `runtime.debugChannel` 传入 `buildServer`(测试桩传了、生产入口漏了)。
 *    已修:commit a35bb01;
 *  ② `debug_attach` 恒失败(日志 type=DebugVariantBuildError、回执
 *    error/internal_error)—— 演示拓扑登记的题目是 **IR 模式**,
 *    而调试变体契约不携带程序 IR(确定性拒绝 XC-DEBUG-MODE-IR)。已修:
 *    种子题改字节模式 + 初始 RIP 对齐代码区入口(`k6/seed-challenge.mjs`),
 *    机器锚 = `apps/session-api/test/debug/demo-challenge-debug-capability.test.ts`;
 *  ③ **「不步进即见指令行」与冻结推送模型冲突**(本文件第 2 步的原断言)。
 *    冻结面事实(`packages/protocol/docs/调试通道协议语义.md` §九):attach 只推
 *    `debug_attached` + `debug_function_table`,**指令流随 `debug_paused` 才下发**;
 *    真机实测 attach 回执恒 `status:"running"`(无对齐暂停)⇒ 不步进时指令视图
 *    必然为空。而定案 **不得改冻结协议**,故按 UX 口径 (a1) 在产品侧补齐:
 *    attach 未携带对齐暂停时,前端用**公开投影的 RIP** 触发一次
 *    `debug_run_to_breakpoint([rip])`(落地 = `packages/vm-ui/src/datasource/
 *    debug-data-source.ts#pauseAtCurrentRip`)。服务端 `run_to_breakpoint` 起点即
 *    命中(0 步)⇒ 回 `debug_paused {reason:"breakpoint"}` + 该地址的
 *    `debug_instruction_stream`,冻结帧族 / 推送时机 / 错误码零改动。
 *    种子题是单 `ret` 程序,唯一可达断点就是入口自身,「先设断点再运行」在此题
 *    上不可行(断点开关挂在指令行上、指令行需要暂停 = 死循环)⇒ 只能用 (a1)。
 *    本文件据此**新增**「首个暂停落在当前 RIP」断言(原「指令行可见」断言不动)。
 *    (a1) 的用户可见性还依赖两处产品侧布局修复(均为死选择器族缺陷):指令视图
 *    渲染根为 `section.instruction-view` 而 flex 高度链写在无对应节点的 `.layout`
 *    上;<sm-window-list> 结构样式改随模板落到 light DOM(此前 `static styles`
 *    在 light DOM 架构下不可达 ⇒ 列表不是滚动容器、锚点行落在视口外数千像素);
 *  ④ **未达成:第 7 步「调试档伪汇编 chip」不可达(本用例当前唯一红点)**。
 *    成因(已实测取证,非本 WP 前端代码缺陷):调试实例 = attach 时按
 *    `origin.revision` **重放权威动作日志**得到的克隆,而动作日志只在 `submit`
 *    时落库(`apps/session-api/src/sessions/session-manager.ts#persistActionLogDelta`)
 *    ⇒ 未提交会话的克隆恒等于**种子初始态**(栈区全 0)。真机取证:调试档
 *    `prefetchWindow("0x7ffff000",16) = "00…00"` 而权威投影
 *    `head="0010400000000000"`,且 session-api 日志为
 *    `"revision":0,"targetRevision":1,"msg":"debug instance attached (deterministic
 *    replay aligned)"`(请求对齐到 revision 1,实际只对齐到 0)。栈行 8 字节非地址
 *    ⇒ 跳转链不成立 ⇒ `<sm-jump-chain>` 不挂载 ⇒ `[data-pseudo-asm]` 不存在。
 *    最小修法(需产品侧定案,不属本次改动面):调试变体对齐源改用**在途会话的
 *    权威动作日志**(`SubmitReference.actionLog`)或种子题栈上预置一个指向代码区的
 *    返回地址。本断言**未削弱**,原样保留等待修法落地。
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
    readonly paused: { readonly reason: string; readonly addressHex: string } | null;
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
          "调试实例未 attach(WP-76 缺陷 1/2 已修:① 生产入口已传 debugChannel " +
          "a35bb01;② 种子题已改字节模式 + 初始 RIP 对齐)。此处仍未 attach ⇒ " +
          "多半是拓扑跑的是修复前产物(缓存镜像 / 未重建 dist)或登记的仍是旧 " +
          "IR 双包(需 compose:app:down -v 后重新登记),而非服务端实现问题。",
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

    // 2) 首个暂停(契约面事实):attach **不推**指令流(§九,只随 debug_paused 下发)
    //    ⇒ 产品侧进入调试模式即用当前 RIP 触发一次暂停(UX 定案 (a1))。断言
    //    「暂停已发生且落点 = 当前 RIP」(种子题初始 RIP = 代码区入口),而不是
    //    仅断言「有指令行」—— 后者在推送面变化时会假绿。
    await expect
      .poll(
        async () =>
          page.locator("sm-workspace").evaluate((element) => {
            const paused = (element as unknown as WorkspaceFace).debugDataSource?.paused ?? null;
            return paused === null ? "none" : `${paused.reason}@${paused.addressHex}`;
          }),
        {
          timeout: 15_000,
          message:
            "进入调试模式后未观察到首个暂停:attach 未携带对齐暂停时前端应以公开投影 RIP " +
            "触发 debug_run_to_breakpoint(debug-data-source.ts#pauseAtCurrentRip);仍为 none " +
            "⇒ 该触发路径未生效(检查 vm-ui dist 是否重建)。",
        },
      )
      .toBe(`breakpoint@${CODE_BASE}`);

    const instructionView = page.locator("sm-instruction-view");
    const rows = instructionView.locator(".instruction-row[data-instruction-address]");
    await expect(rows.first()).toBeVisible();

    // 3) 初始视角锚定(WP-75 #7):进入视图即按 rip 锚定一次,锚点行落在真实视口。
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

    // 4) 伪汇编列右侧单独对齐(真实计算样式)。
    const textAlign = await instructionView
      .locator(".instruction-row .row-text")
      .first()
      .evaluate((element) => getComputedStyle(element).textAlign);
    expect(["end", "right"]).toContain(textAlign);

    // 5) 行断点 ↔ 调试档数据源联动(FE-IN-08 × FE-WS-04c)。
    const toggle = instructionView
      .locator(`.instruction-row[data-instruction-address="${anchor.addressHex}"]`)
      .locator(".breakpoint-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    const runToBreakpoint = menuButton(page, "run-to-breakpoint-button");
    await expect(runToBreakpoint).toBeEnabled();

    // 6) payload 断点积木真实编译 → 断点地址并入调试档集合(非空 + 含编译期地址)。
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

    // 7) 伪汇编延伸 chip 调试档形态:指令流命中 = 真指令;未覆盖 = 显式降级文案
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

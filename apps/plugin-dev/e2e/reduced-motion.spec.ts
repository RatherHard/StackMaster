/**
 * WP-74 E2E:reduced-motion 门禁与装饰面**终态契约**(§2.1 效果面)。
 *
 * ## 为什么这里断言的是「终态契约」而不是当前实现
 *
 * 扫描线 overlay 与光标闪烁的**实装由 WP-74 效果面波次落在
 * `packages/vm-ui/src/**`**(本 spec 不越界实现任何效果)。为了在实现落地
 * **之前**就让门禁有意义,本 spec 把断言写成对**终态契约**的断言,分两侧:
 *
 *  - **reduce 侧**(`reducedMotion: "reduce"`):装饰不得生效 —— 全局
 *    「零非 `none` 动画」不变式 + 扫描线层不可见 + 装饰不承载信息。该侧当前
 *    恒真(无任何效果实装 ⇒ 无动画、无装饰层),落地后成为真实守护断言;
 *  - **no-preference 侧(正面对照)**:终端预设下装饰**必须按契约在场** ——
 *    扫描线层命中、形态为 `repeating-linear-gradient`、强度 `0 < opacity ≤ 0.06`、
 *    `pointer-events: none`;光标闪烁动画非 `none` 且周期解析自
 *    `--sm-caret-blink`(1.1s)。**该侧在效果面实装前为红灯**(带契约描述与
 *    实测计数的失败信息),即本波次有意承载的红灯:任何「装了但没生效」或
 *    「没装」都会以「契约未满足」的形式落红,而不是静默绿。
 *
 * 契约全文(编号 C1~C9、锚候选、结构性兜底、判定属性与期望值)登记在
 * `e2e/helpers/decoration.ts` 文件头(单一来源);契约描述同时上报主控,便于
 * 交给效果面波次对齐。若实现选了其它锚名,只需满足「结构性兜底」形态即算契约
 * 满足(见 decoration.ts);若实现与契约确有正当偏差,调本 spec 前请先改契约
 * 文档并登记理由。
 *
 * ## 屏幕阅读器口径(登记;自动化不可替代人工抽样)
 *
 * **装饰不承载信息**:扫描线 overlay / 光标闪烁为纯装饰,必须
 * `aria-hidden="true"`、零文本内容、零可聚焦后代;扫描线层还必须
 * `pointer-events: none`(不影响命中测试)。一切状态与语义信息只经语义化 DOM
 * (role / aria-live / region / 表格结构)表达 —— 装饰整体缺席时不丢失任何信息
 * (reduce 侧即该口味的可机检形态:装饰缺席,断言仍全绿)。
 *
 * ## 口径与运行
 *
 * - chromium 口径格(浏览器能力仿真;与 `browser-matrix.spec.ts` 的
 *   reduced-motion / forcedColors 附加维度同款 —— 三引擎不重复同一仿真);
 * - 运行前置与复跑命令同 axe 真机 spec(见 `apps/plugin-dev/README.md`);
 * - reduce 自证:断言前先读插件帧内 `matchMedia("(prefers-reduced-motion:
 *   reduce)").matches` —— 仿真若未穿透 iframe,断言会恒真而门禁失效,必须自证;
 * - terminal 承载 = 插件文档页挂载前预置锚(`/axe-terminal.html` 变体路由;
 *   terminal 不经嵌入协议,见 `e2e/helpers/theme-anchor.ts`)。
 */
import { expect } from "@playwright/test";

import {
  CARET_DECORATION_SELECTORS,
  collectDecorationState,
  DECORATION_SEMANTICS_REGISTRATION,
  decorationInvisible,
  SCANLINE_DECORATION_SELECTORS,
  type DecorationSample,
  type DecorationState,
} from "./helpers/decoration.js";
import {
  closeEmbedSessionBestEffort,
  embedViaHostMock,
  pluginFocusWindowButton,
  pluginMenuButton,
  pluginMenuStatus,
  pluginVm,
} from "./helpers/embed.js";
import { pluginFrameOf } from "./helpers/frames.js";
import {
  expectTerminalTokensActive,
  PLUGIN_TERMINAL_URL,
  THEME_ANCHOR_ATTRIBUTE,
  TERMINAL_THEME_VALUE,
} from "./helpers/theme-anchor.js";
import { test } from "./fixtures.js";

/** 仅 chromium(浏览器能力仿真口径格;矩阵三引擎只跑 browser-matrix.spec)。 */
test.skip(({ browserName }) => browserName !== "chromium", "reduced-motion 仿真口径 = chromium");

/** 装饰样本的可读描述(红灯诊断;契约字段全覆盖)。 */
function describeSample(label: string, sample: DecorationSample): string {
  return (
    `${label}: ${sample.path} [display=${sample.display} visibility=${sample.visibility} ` +
    `opacity=${sample.opacity} pointer-events=${sample.pointerEvents} aria-hidden=${String(sample.ariaHidden)} ` +
    `animation=${sample.animationName}/${sample.animationDuration} hasText=${String(sample.hasText)} ` +
    `focusable=${String(sample.focusableDescendants)}]`
  );
}

/** C7:装饰不承载信息(aria-hidden + 零文本 + 零可聚焦后代)。 */
function expectDecorationSemantics(label: string, sample: DecorationSample): void {
  expect(
    sample.ariaHidden,
    `${describeSample(label, sample)} —— ${DECORATION_SEMANTICS_REGISTRATION}`,
  ).toBe("true");
  expect(
    sample.hasText,
    `${describeSample(label, sample)} —— ${DECORATION_SEMANTICS_REGISTRATION}`,
  ).toBe(false);
  expect(
    sample.focusableDescendants,
    `${describeSample(label, sample)} —— ${DECORATION_SEMANTICS_REGISTRATION}`,
  ).toBe(0);
}

/** 一条在场装饰样本(标签 + 是否光标面;光标面允许静态可见)。 */
interface PresentDecoration {
  readonly label: string;
  readonly sample: DecorationSample;
  readonly isCaret: boolean;
}

/** 装饰探测结果中的在场样本(扫描线优先取契约锚命中,回落结构性兜底)。 */
function presentDecorationSamples(state: DecorationState): readonly PresentDecoration[] {
  const entries: readonly { label: string; sample: DecorationSample | null; isCaret: boolean }[] = [
    { label: "扫描线(契约锚命中)", sample: state.scanline, isCaret: false },
    { label: "扫描线(结构性兜底:装饰性渐变层)", sample: state.gradientDecoration, isCaret: false },
    { label: "光标(契约锚命中)", sample: state.caret, isCaret: true },
  ];
  return entries.filter(
    (entry): entry is PresentDecoration => entry.sample !== null,
  );
}

test.describe("WP-74 reduced-motion 与装饰面终态契约", () => {
  test.describe("reduce 口径(装饰不生效)", () => {
    test.use({ reducedMotion: "reduce" });

    test("终端预设 + reduce:零非 none 动画 / 扫描线不可见 / 装饰不承载信息 / 界面可用", async ({
      page,
    }) => {
      test.setTimeout(150_000);
      const handle = await embedViaHostMock(page, { pluginUrl: PLUGIN_TERMINAL_URL });
      const frame = pluginFrameOf(page);

      // 终端预设必须真的生效(否则本用例在 light 缺省下跑,断言无意义)。
      await expect(pluginVm(handle.plugin)).toHaveAttribute(
        THEME_ANCHOR_ATTRIBUTE,
        TERMINAL_THEME_VALUE,
      );
      await expectTerminalTokensActive(pluginVm(handle.plugin));

      const state = await collectDecorationState(frame);
      // 仿真自证:reduce 必须穿透到插件帧(否则「无动画」可能是仿真没生效)。
      expect(
        state.reduceMatches,
        "reduce 仿真未到达插件帧:matchMedia('(prefers-reduced-motion: reduce)').matches 为 false,断言会恒真",
      ).toBe(true);
      expect(state.elementCount, "composed 树遍历面为空?").toBeGreaterThan(50);

      // ① 扫描线:缺席(=None 的充分形态)或不可见(display:none / visibility:hidden / opacity:0)。
      for (const { label, sample, isCaret } of presentDecorationSamples(state)) {
        expectDecorationSemantics(label, sample);
        if (isCaret) {
          // 光标静态可见是允许的(静态光标不构成动效);其动画面由 ② 全局不变式覆盖。
          continue;
        }
        expect(
          decorationInvisible(sample),
          `${describeSample(label, sample)} —— reduce 下扫描线装饰必须不可见(契约 C8)`,
        ).toBe(true);
        expect(
          sample.pointerEvents,
          `${describeSample(label, sample)} —— 扫描线不得影响命中测试(契约 C4)`,
        ).toBe("none");
      }

      // ② 全局不变式(不依赖任何锚名):reduce 下 composed 树内零非 none 动画。
      expect(
        state.animatedCount,
        `reduce 下存在非 none 动画(契约 C9)${state.animated === null ? "" : `;首个 ${describeSample("动画元素", state.animated)}`}`,
      ).toBe(0);

      // ③ 界面可用:reduce 只关动效,不降功能(投影渲染 + step 动作照常)。
      await pluginFocusWindowButton(handle.plugin, "registers").click();
      await expect(handle.plugin.locator("sm-register-view")).toContainText("RSP");
      const before = Number(
        (await pluginMenuStatus(handle.plugin, "revision").textContent())?.trim() ?? "0",
      );
      await pluginMenuButton(handle.plugin, "step-button").click();
      await expect(pluginMenuStatus(handle.plugin, "revision")).toHaveText(String(before + 1));

      await closeEmbedSessionBestEffort(handle);
    });
  });

  test.describe("no-preference 口径(正面对照;依赖 WP-74 效果面实装)", () => {
    test.use({ reducedMotion: "no-preference" });

    test("终端预设:扫描线 overlay 与光标闪烁按契约在场(C1~C7)", async ({ page }) => {
      test.setTimeout(150_000);
      const handle = await embedViaHostMock(page, { pluginUrl: PLUGIN_TERMINAL_URL });
      const frame = pluginFrameOf(page);

      await expect(pluginVm(handle.plugin)).toHaveAttribute(
        THEME_ANCHOR_ATTRIBUTE,
        TERMINAL_THEME_VALUE,
      );
      await expectTerminalTokensActive(pluginVm(handle.plugin));

      const state = await collectDecorationState(frame);
      expect(state.reduceMatches, "no-preference 口径下 reduce 不应命中").toBe(false);

      const scanline = state.scanline ?? state.gradientDecoration;
      if (scanline === null) {
        throw new Error(
          "扫描线装饰层缺席 —— WP-74 效果面未实装,或锚名不在契约内。" +
            `契约 C1 锚候选: ${SCANLINE_DECORATION_SELECTORS.join(" | ")}` +
            "(或结构性兜底形态「aria-hidden=\"true\" + pointer-events:none + repeating-linear-gradient 背景」)。" +
            `实测: scanlineCount=${String(state.scanlineCount)} gradientDecorationCount=${String(state.gradientDecorationCount)} ` +
            `animatedCount=${String(state.animatedCount)} elementCount=${String(state.elementCount)}`,
        );
      }
      expect(
        scanline.backgroundImage,
        `${describeSample("扫描线", scanline)} —— 形态须为 repeating-linear-gradient(契约 C2)`,
      ).toContain("repeating-linear-gradient");
      const opacity = Number(scanline.opacity);
      expect(
        opacity,
        `${describeSample("扫描线", scanline)} —— 强度须 > 0(no-preference 下装饰应在场;契约 C3)`,
      ).toBeGreaterThan(0);
      expect(
        opacity,
        `${describeSample("扫描线", scanline)} —— 强度上限 ≤ 0.06(§2.1 / 契约 C3)`,
      ).toBeLessThanOrEqual(0.06);
      expect(
        scanline.pointerEvents,
        `${describeSample("扫描线", scanline)} —— 不得影响命中测试(契约 C4)`,
      ).toBe("none");
      expectDecorationSemantics("扫描线", scanline);

      const caret = state.caret !== null && state.caret.animationName !== "none"
        ? state.caret
        : state.animated;
      if (caret === null) {
        throw new Error(
          "光标闪烁装饰缺席 —— WP-74 效果面未实装,或锚名 / 动画不在契约内。" +
            `契约 C5 锚候选: ${CARET_DECORATION_SELECTORS.join(" | ")}` +
            "(或落回结构性兜底「composed 树内存在 animation-name 非 none 的元素」)。" +
            `实测: caretCount=${String(state.caretCount)} animatedCount=${String(state.animatedCount)} ` +
            `elementCount=${String(state.elementCount)}`,
        );
      }
      expect(
        caret.animationName.trim(),
        `${describeSample("光标", caret)} —— 光标闪烁须为 steps 动画(契约 C6)`,
      ).not.toBe("");
      expect(
        caret.animationDuration,
        `${describeSample("光标", caret)} —— 动画周期须解析自 --sm-caret-blink(1.1s;契约 C6)`,
      ).toBe("1.1s");
      expectDecorationSemantics("光标", caret);

      await closeEmbedSessionBestEffort(handle);
    });
  });
});

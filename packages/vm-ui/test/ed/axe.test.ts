/**
 * FE-ED-08 无障碍套件:7 个教学组件逐一挂载(代表性满内容形态)后跑
 * axe.run,断言零 violations(或仅本文件登记内豁免)。
 *
 * ── jsdom 限制豁免清单(逐条理由;不得整体跳过)──────────────────────────
 * 1. `color-contrast`(以 rules 配置禁用):jsdom 无布局引擎与真实 CSS 级联
 *    求值,前景/背景色对比度不可判定——任何结论都是环境伪影而非组件缺陷;
 *    对比度检查留给 WP-45 的真实浏览器 Playwright 报告归档(退出条件 6)。
 * 2. 页面级 harness 修正(非规则豁免):jsdom 测试文档缺 `<html lang>` 与
 *    `<title>`,且组件挂载面需要 landmark 语义——测试统一注入
 *    `lang="zh-CN"`、`document.title` 与唯一 `<main>` + `<h1>`。这是宿主
 *    (工作区/插件壳)职责的模拟,不构成对组件面的让步。
 * ────────────────────────────────────────────────────────────────────────
 * 其余全部规则(含 shadow DOM 穿透)保持启用:violations 非空即红灯。
 */
import axe from "axe-core";
import type { LitElement } from "lit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PublicError } from "@stackmaster/protocol";

import type { PublicHint } from "../../src/ed/ed-types.js";
import type { TimelineEntry } from "../../src/ed/timeline.js";

import "../../src/views/ed/sm-call-stack.js";
import "../../src/views/ed/sm-checkpoints.js";
import "../../src/views/ed/sm-error-explainer.js";
import "../../src/views/ed/sm-hint-ladder.js";
import "../../src/views/ed/sm-memory-diff.js";
import "../../src/views/ed/sm-structure-view.js";
import "../../src/views/ed/sm-timeline.js";
import type { SmCallStack } from "../../src/views/ed/sm-call-stack.js";
import type { SmCheckpoints } from "../../src/views/ed/sm-checkpoints.js";
import type { SmErrorExplainer } from "../../src/views/ed/sm-error-explainer.js";
import type { SmHintLadder } from "../../src/views/ed/sm-hint-ladder.js";
import type { SmMemoryDiff } from "../../src/views/ed/sm-memory-diff.js";
import type { SmStructureView } from "../../src/views/ed/sm-structure-view.js";
import type { SmTimeline } from "../../src/views/ed/sm-timeline.js";

let main: HTMLElement | null = null;

beforeAll(() => {
  // 页面级 harness 修正(见头部豁免清单第 2 条)。
  document.documentElement.lang = "zh-CN";
  document.title = "教学组件无障碍检查";
  main = document.createElement("main");
  main.id = "ed-axe-main";
  main.append(Object.assign(document.createElement("h1"), { textContent: "教学组件无障碍检查" }));
  document.body.append(main);
});

afterAll(() => {
  main?.remove();
  main = null;
});

/** 挂载组件进 <main> 并跑 axe(只收集 violations;豁免见头部清单)。 */
async function mountAndRun<T extends LitElement>(
  tag: string,
  configure: (element: T) => void | Promise<void>,
): Promise<axe.AxeResults> {
  const element = document.createElement(tag) as T;
  main!.append(element);
  await configure(element);
  await element.updateComplete;
  const results = await axe.run(document, {
    resultTypes: ["violations"],
    rules: {
      // 豁免清单第 1 条:jsdom 无布局,对比度不可判定(逐条理由见文件头)。
      "color-contrast": { enabled: false },
    },
  });
  element.remove();
  return results;
}

/** 断言零 violations(非空时打印完整清单辅助定位)。 */
function expectNoViolations(results: axe.AxeResults): void {
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => node.target),
  }));
  expect(summary).toEqual([]);
}

describe("FE-ED-08 axe-core 全组件套件", () => {
  it("sm-structure-view:分组列表 + 条目按钮零 violations", async () => {
    const results = await mountAndRun<SmStructureView>("sm-structure-view", (element) => {
      element.highlights = [
        { kind: "buffer_start", targetRegionId: "region-stack", startAddressHex: "0x1010", byteLength: 64, label: "buffer 起点" },
        { kind: "return_address_slot", targetRegionId: "region-stack", startAddressHex: "0x1008", byteLength: 8, label: "返回地址槽" },
        { kind: "canary_slot", targetRegionId: "region-stack", startAddressHex: "0x1000", byteLength: 8, label: "canary 槽" },
        { kind: "custom", targetRegionId: "region-data", startAddressHex: "0x9000", byteLength: 4, label: "自定义" },
      ];
    });
    expectNoViolations(results);
  });

  it("sm-call-stack:帧表(含截断与最内帧标注)零 violations", async () => {
    const results = await mountAndRun<SmCallStack>("sm-call-stack", (element) => {
      element.frames = [
        { index: 0, functionLabel: "0x40A0(vulnerable)", returnAddressHex: "0x40100" },
        { index: 1, functionLabel: "func_1", returnAddressHex: "0x40200", truncated: true },
      ];
    });
    expectNoViolations(results);
  });

  it("sm-memory-diff:diff 表(含前值不可知与截断注)零 violations", async () => {
    const results = await mountAndRun<SmMemoryDiff>("sm-memory-diff", (element) => {
      element.beforeRegions = [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          bytesHex: "00010203",
          truncated: false,
        },
      ];
      element.delta = {
        revision: 1,
        dirtyRanges: [
          { regionId: "region-stack", startAddressHex: "0x1000", bytesHex: "ff0102", truncated: true },
          { regionId: "region-heap", startAddressHex: "0x9000", bytesHex: "aa" },
        ],
        changedRegisters: [],
      };
    });
    expectNoViolations(results);
  });

  it("sm-timeline:条目列表(含状态与当前标记)零 violations", async () => {
    const entries: readonly TimelineEntry[] = [
      { seq: 1, kind: "action", label: "step", revision: 1, status: "running" },
      { seq: 2, kind: "checkpoint", label: 'checkpoint "存档"', revision: 2, checkpointId: "cp-a" },
      { seq: 3, kind: "action", label: "undo", revision: 3, status: "rejected" },
      { seq: 4, kind: "submit", label: "submit(sub-1)", revision: 4, submissionId: "sub-1" },
    ];
    const results = await mountAndRun<SmTimeline>("sm-timeline", (element) => {
      element.entries = entries;
      element.currentRevision = 3;
    });
    expectNoViolations(results);
  });

  it("sm-checkpoints:创建行 + 列表 + 两步确认态零 violations", async () => {
    const results = await mountAndRun<SmCheckpoints>("sm-checkpoints", async (element) => {
      element.checkpoints = [
        { checkpointId: "cp-a", label: "存档一", revision: 2 },
        { checkpointId: "cp-b", revision: 5 },
      ];
      element.sendAction = () => {};
      await element.updateComplete;
      // 进入两步确认态再检查(确认行的 status 文本与双按钮也在可达面内)。
      element.shadowRoot?.querySelector<HTMLButtonElement>(".checkout-button")?.click();
    });
    expectNoViolations(results);
  });

  it("sm-hint-ladder:on_request 按钮 + after_n_failures 锁定/解锁三态零 violations", async () => {
    const hints: readonly PublicHint[] = [
      { order: 1, revealPolicy: "on_request", hintText: "检查返回地址的写位置" },
      { order: 2, revealPolicy: "after_n_failures", failureThreshold: 3, hintText: "尝试 padding" },
    ];
    const locked = await mountAndRun<SmHintLadder>("sm-hint-ladder", (element) => {
      element.hints = hints;
      element.failures = 1;
    });
    expectNoViolations(locked);

    const revealed = await mountAndRun<SmHintLadder>("sm-hint-ladder", async (element) => {
      element.hints = hints;
      element.failures = 3;
      await element.updateComplete;
      // 揭示 on_request 条目后再检查(揭示后的完整文案形态)。
      element.shadowRoot?.querySelector<HTMLButtonElement>(".reveal-button")?.click();
    });
    expectNoViolations(revealed);
  });

  it("sm-error-explainer:满解释形态 + 默认教学注解形态零 violations", async () => {
    const error: PublicError = {
      code: "invalid_rip",
      message: "非法 RIP",
      addressHex: null,
      explanation: {
        regionId: "region-code",
        permissions: "rx",
        valueHex: "0xdead",
        interpretedAs: "little_endian_qword",
        alignmentBytes: 4,
        expectedBytesLength: 8,
        actualBytesLength: 2,
        hints: ["小端解释", "检查 RSP 对齐"],
      },
    };
    const full = await mountAndRun<SmErrorExplainer>("sm-error-explainer", (element) => {
      element.error = error;
      element.mappings = [{ errorCode: "invalid_rip", teachingNote: "返回地址要落在代码区" }];
    });
    expectNoViolations(full);

    const defaultNote = await mountAndRun<SmErrorExplainer>("sm-error-explainer", (element) => {
      element.error = { code: "objective_not_met", message: "目标未达成" };
      element.mappings = [];
    });
    expectNoViolations(defaultNote);
  });

  it("红灯反例:axe 在 jsdom 下真实可红灯(light DOM 与 shadow DOM 各一)", async () => {
    // 机检有效性证明(纪律:无红灯反例的检查不可信):无名称按钮必须被检出
    // ——含 Lit 组件所处的 open shadow树,证明穿透检查真实生效。
    const lightHost = document.createElement("div");
    lightHost.innerHTML = `<button></button>`;
    main!.append(lightHost);
    const shadowHost = document.createElement("div");
    shadowHost.attachShadow({ mode: "open" }).innerHTML = `<ul><li><button></button></li></ul>`;
    main!.append(shadowHost);
    const results = await axe.run(document, {
      resultTypes: ["violations"],
      rules: { "color-contrast": { enabled: false } },
    });
    const ids = results.violations.map((violation) => violation.id);
    expect(ids).toContain("button-name");
    lightHost.remove();
    shadowHost.remove();
  });
});

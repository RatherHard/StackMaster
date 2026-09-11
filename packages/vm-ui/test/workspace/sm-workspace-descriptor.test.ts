/**
 * <sm-workspace> 描述包接入面测试(WP-54):
 *  - 静态面渲染(`descriptorStatus = "loaded"` + `challengeStatic`):标题 /
 *    简介 / VM Profile 事实表 / encodingTable(存在才渲染);
 *  - 缺席明示(`descriptorStatus = "absent"`):与「题目没有配置提示」区分的
 *    静态缺席呈现(不含任何失败细节);
 *  - 缺省 / loading / unknown:零渲染面(既有装配零影响);
 *  - 晚到注入:状态与静态面更新即重渲染(hintLadder / publicErrorMapping
 *    注入由既有 ED 面承载,此处锚定描述包状态面)。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { SmWorkspace } from "../../src/workspace/sm-workspace.js";
import type { ChallengeStaticFace } from "../../src/descriptor/challenge-descriptor.js";

async function mountWorkspace(): Promise<SmWorkspace> {
  const element = new SmWorkspace();
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function shadowOf(element: SmWorkspace): ShadowRoot {
  return element.shadowRoot as ShadowRoot;
}

function makeStaticFace(overrides: Partial<ChallengeStaticFace> = {}): ChallengeStaticFace {
  return {
    title: "返回地址覆写入门",
    summary: "通过覆写栈帧中的返回地址观察控制流劫持(占位简介)。",
    archBits: 64,
    endianness: "little",
    pageSizeBytes: 4096,
    registerNames: ["RAX", "RSP", "RIP"],
    canaryEnabled: true,
    encodingTable: [{ tokenHex: "c3", op: "ret" }],
    ...overrides,
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("描述包接入状态:缺省与进行中(零渲染面)", () => {
  it("缺省 unknown → 无题目面板(既有装配零影响)", async () => {
    const element = await mountWorkspace();
    expect(shadowOf(element).querySelector(".challenge-panel")).toBeNull();
    expect(element.descriptorStatus).toBe("unknown");
  });

  it("loading → 不渲染占位(晚到即注入,不闪占位)", async () => {
    const element = await mountWorkspace();
    element.descriptorStatus = "loading";
    await element.updateComplete;
    expect(shadowOf(element).querySelector(".challenge-panel")).toBeNull();
  });
});

describe("描述包缺席明示(absent)", () => {
  it("absent → 缺席面板呈现(静态明示,零失败细节)", async () => {
    const element = await mountWorkspace();
    element.descriptorStatus = "absent";
    await element.updateComplete;
    const panel = shadowOf(element).querySelector(".challenge-panel");
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("data-descriptor-status")).toBe("absent");
    expect(panel?.textContent).toContain("题目描述未加载");
    expect(panel?.textContent).toContain("暂不可用");
    // 零内部透出:呈现面不携带任何原因码 / 响应细节。
    expect(panel?.textContent).not.toContain("digest");
    expect(panel?.textContent).not.toContain("etag");
  });

  it("absent 但无静态面数据 → 仍只呈现缺席面板(不渲染 briefing)", async () => {
    const element = await mountWorkspace();
    element.descriptorStatus = "absent";
    await element.updateComplete;
    expect(shadowOf(element).querySelector(".challenge-title")).toBeNull();
  });
});

describe("静态面渲染(loaded)", () => {
  it("loaded + challengeStatic → 标题 / 简介 / VM Profile 事实表齐备", async () => {
    const element = await mountWorkspace();
    element.descriptorStatus = "loaded";
    element.challengeStatic = makeStaticFace();
    await element.updateComplete;
    const panel = shadowOf(element).querySelector(".challenge-panel");
    expect(panel?.getAttribute("data-descriptor-status")).toBe("loaded");
    expect(shadowOf(element).querySelector(".challenge-title")?.textContent).toBe("返回地址覆写入门");
    expect(shadowOf(element).querySelector(".challenge-summary")?.textContent).toContain("控制流劫持");
    const facts = shadowOf(element).querySelector(".challenge-facts");
    expect(facts?.textContent).toContain("64");
    expect(facts?.textContent).toContain("little");
    expect(facts?.textContent).toContain("RAX, RSP, RIP");
    expect(facts?.textContent).toContain("4096 字节"); // ed.bytesSuffix {count:4096}
    expect(facts?.textContent).toContain("已启用"); // canary
  });

  it("encodingTable 存在 → 表格行渲染(tokenHex / op / operands)", async () => {
    const element = await mountWorkspace();
    element.descriptorStatus = "loaded";
    element.challengeStatic = makeStaticFace();
    await element.updateComplete;
    const rows = shadowOf(element).querySelectorAll(".encoding-table tbody tr");
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain("c3");
    expect(rows[0]?.textContent).toContain("ret");
  });

  it("encodingTable 空 → 编码表行缺席(存在才渲染,不渲染空表)", async () => {
    const element = await mountWorkspace();
    element.descriptorStatus = "loaded";
    element.challengeStatic = makeStaticFace({ encodingTable: [] });
    await element.updateComplete;
    expect(shadowOf(element).querySelector(".encoding-table")).toBeNull();
  });

  it("canary 未启用 → 未启用文案", async () => {
    const element = await mountWorkspace();
    element.descriptorStatus = "loaded";
    element.challengeStatic = makeStaticFace({ canaryEnabled: false });
    await element.updateComplete;
    expect(shadowOf(element).querySelector(".challenge-facts")?.textContent).toContain("未启用");
  });

  it("晚到注入:状态 unknown → loaded 即重渲染(装配管线晚到注入语义)", async () => {
    const element = await mountWorkspace();
    expect(shadowOf(element).querySelector(".challenge-panel")).toBeNull();
    element.descriptorStatus = "loaded";
    element.challengeStatic = makeStaticFace();
    await element.updateComplete;
    expect(shadowOf(element).querySelector(".challenge-title")?.textContent).toBe("返回地址覆写入门");
  });
});

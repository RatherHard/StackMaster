/**
 * <sm-workspace> 常驻窗口集的地标唯一性(WP-74 前置修复:WP-71 让 10 个窗口
 * 同时常驻 DOM,此前互不同时在场的内部视图进入同一次扫描)。
 *
 * 违规事实(WP-71 / 5b1b7f4 后 `e2e/axe-contrast.spec.ts` 真机复跑两次一致):
 *  - `landmark-unique`(moderate,4 节点):窗口面板 section[aria-label] 与其
 *    内部视图自身的 region 名重复(栈视图 / 自由视图 / 指令视图),以及两个
 *    常驻字节窗口各带一个同名 `[aria-label="VMA 列表"]`。
 *
 * 本文件独立成篇(不复用 sm-workspace.test.ts 的共享文档):axe 在 jsdom 下
 * 生成深层选择器时会被同文档残留夹具影响,独立文档让本规则的判定面确定;
 * 真机门禁口径仍以 `apps/plugin-dev/e2e/axe-contrast.spec.ts`(chromium)为准。
 */
import axe from "axe-core";
import { describe, expect, it } from "vitest";

import { SmWorkspace } from "../../src/workspace/sm-workspace.js";

async function mountWorkspace(): Promise<SmWorkspace> {
  const element = new SmWorkspace();
  document.body.append(element);
  await element.updateComplete;
  return element;
}

/** 递归穿透 open shadow root 收集元素(sm-workspace → sm-byte-tab → sm-byte-view 多层)。 */
function deepElements(root: ParentNode): HTMLElement[] {
  const collected: HTMLElement[] = [];
  const visit = (scope: ParentNode): void => {
    for (const element of scope.querySelectorAll<HTMLElement>("*")) {
      collected.push(element);
      if (element.shadowRoot !== null) {
        visit(element.shadowRoot);
      }
    }
  };
  visit(root);
  return collected;
}

/** 有可达名称的 region 地标(section 携带名称即暴露 region 角色;role=region 显式同论)。 */
function namedRegions(workspace: SmWorkspace): HTMLElement[] {
  return deepElements(workspace.shadowRoot as ShadowRoot).filter(
    (node) =>
      node.getAttribute("aria-label") !== null &&
      (node.tagName === "SECTION" || node.getAttribute("role") === "region"),
  );
}

describe("<sm-workspace> 地标唯一性(常驻窗口集:面板名称 × 内部视图名称)", () => {
  it("面板与其内部视图的地标名称互不重复(含两个常驻字节窗口的 VMA 列表)", async () => {
    const workspace = await mountWorkspace();

    const labelled = namedRegions(workspace).map((node) => ({
      label: node.getAttribute("aria-label") ?? "",
      owner: node.closest("[data-tab-id]")?.getAttribute("data-tab-id") ?? "—",
      target: `${node.tagName.toLowerCase()}[${node.getAttribute("class") ?? ""}]`,
    }));
    // 常驻面必须真实具备地标(空断言会掩盖「一个都没渲染」的假绿)。
    expect(labelled.length).toBeGreaterThanOrEqual(4);

    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const entry of labelled) {
      const first = seen.get(entry.label);
      if (first === undefined) {
        seen.set(entry.label, `${entry.owner}/${entry.target}`);
      } else {
        duplicates.push(`地标名「${entry.label}」重复:${first} 与 ${entry.owner}/${entry.target}`);
      }
    }
    expect(duplicates).toEqual([]);
    workspace.remove();
  });

  it("axe:常驻窗口集零 landmark-unique 违规", async () => {
    const workspace = await mountWorkspace();

    const results = await axe.run(document, {
      runOnly: { type: "rule", values: ["landmark-unique"] },
    });
    expect(
      results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
    workspace.remove();
  });});

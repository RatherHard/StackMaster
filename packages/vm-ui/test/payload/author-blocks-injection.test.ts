/**
 * M10/WP-80 出题者积木声明面的**注入链**测试(工作区组合根 → 惰性宿主 →
 * payload 真组件 → 工具箱 / 编译面)。
 *
 * 为什么本文件替代 E2E:`apps/plugin-dev/e2e` 由并行包(WP-83 波次)独占,
 * 本包不得改动其 spec 面 ⇒ 以「包内注入测试」承载 WP-80 要求的
 * 「声明集注入后插件的积木工具箱可用」证据链(等价断言面:同一 duck-typing
 * 注入路径 + 同一工具箱构建函数 + 同一编译入口)。
 *
 * 断言链(逐环):
 *  1. `challengeDescriptor.authorBlocks` 经工作区 `#syncEdContents` 的
 *     duck-typing 注入落到惰性宿主(`SmPayloadTabHost.authorBlocks`);
 *  2. 惰性宿主把声明集转发给真组件(`whenReady()` 后 `SmPayloadTab.authorBlocks`);
 *  3. 真组件声明集 → 工具箱含「题目积木」分类与动态块类型(工具箱可用);
 *  4. 真组件用同一声明集编译含动态块的状态 → 展开为公开动作序列(端到端闭环);
 *  5. 缺声明(空描述包)⇒ 注入空声明集、工具箱零动态类型(零行为变化)。
 */
import { describe, expect, it } from "vitest";
import type { ActionObject } from "@stackmaster/protocol";

import { PAYLOAD_START_BLOCK_TYPE, buildPayloadToolbox, isAuthorBlockType } from "../../src/payload/compiler/blocks.js";
import type { PayloadAuthorBlockDecl, PayloadToolboxCategory } from "../../src/payload/compiler/blocks.js";
import type { BlocklySerializedBlockState, BlocklySerializedState, PayloadStep } from "../../src/payload/compiler/types.js";
import { SmPayloadTabHost } from "../../src/payload/lazy-payload-tab.js";
import type { SmPayloadTab } from "../../src/payload/sm-payload-tab.js";
import { SmWorkspace } from "../../src/workspace/sm-workspace.js";

// ── 声明面夹具(与 challenge-schema 公开 Schema 黄金样例同形)──────────────

const DECLARATIONS: readonly PayloadAuthorBlockDecl[] = [
  {
    id: "overwrite-return",
    displayText: "覆写返回地址",
    interfaceId: 512,
    slots: [
      { key: "target", label: "目标地址", kind: "address" },
      { key: "padding", label: "填充长度", kind: "length" },
    ],
    actions: [
      { type: "write_bytes", args: { addressHex: { slot: "target" }, bytesHex: "4141414141414141" } },
      { type: "push", args: { valueHex: { slot: "padding" } } },
      { type: "call", args: { targetHex: { slot: "target" } } },
    ],
  },
];

let nextBlockId = 0;

function block(
  type: string,
  inputs: Record<string, unknown> = {},
): BlocklySerializedBlockState {
  nextBlockId += 1;
  return { type, id: `wp80-inject-${nextBlockId}`, inputs };
}

function num(text: string): BlocklySerializedBlockState {
  return { type: "payload_num", fields: { N: text } };
}

/** 起始积木 + 一个动态块(槽位填满)的序列化状态。 */
function authorBlockProgram(): BlocklySerializedState {
  const authorBlock = block("payload_author_overwrite-return", {
    SLOT_TARGET: { block: num("0x7fff0000") },
    SLOT_PADDING: { block: num("64") },
  });
  return {
    blocks: {
      languageVersion: 0,
      blocks: [
        {
          type: PAYLOAD_START_BLOCK_TYPE,
          id: `wp80-inject-start-${String((nextBlockId += 1))}`,
          next: { block: authorBlock },
        },
      ],
    },
  };
}

function actionOf(step: PayloadStep | undefined): ActionObject {
  if (step === undefined || step.kind !== "action") {
    throw new Error(`期望动作步骤,实际:${JSON.stringify(step)}`);
  }
  return step.action;
}

function toolboxTypes(categories: readonly PayloadToolboxCategory[]): string[] {
  return categories.flatMap((category) => category.contents.map((entry) => entry.type));
}

/** 装配「工作区 + payload 惰性宿主」并返回宿主内的真组件。 */
async function mountWorkspacePayloadTab(
  authorBlocks: readonly PayloadAuthorBlockDecl[] | undefined,
): Promise<{ workspace: SmWorkspace; host: SmPayloadTabHost; tab: SmPayloadTab }> {
  const workspace = new SmWorkspace();
  document.body.append(workspace);
  await workspace.updateComplete;

  // 声明集注入(工作区 `#syncEdContents` 的 duck-typing 通道)。
  workspace.challengeDescriptor = authorBlocks === undefined ? {} : { authorBlocks };
  await workspace.updateComplete;

  const shadow = workspace.shadowRoot as ShadowRoot;
  const host = shadow.querySelector("sm-payload-tab-host");
  if (!(host instanceof SmPayloadTabHost)) {
    throw new Error("工作区未产出 payload 惰性宿主(固定窗口集不变量破裂)");
  }
  const tab = await host.whenReady();
  return { workspace, host, tab };
}

describe("M10/WP-80 声明集注入链(工作区 → 惰性宿主 → payload 组件)", () => {
  it("声明集经 duck-typing 注入落到工作区持有的内容元素(宿主)", async () => {
    const { workspace, host } = await mountWorkspacePayloadTab(DECLARATIONS);

    expect(host.authorBlocks).toEqual(DECLARATIONS);
    workspace.remove();
  });

  it("真组件就绪后拿到声明集,且工具箱出现「题目积木」分类与动态块类型", async () => {
    const { workspace, host, tab } = await mountWorkspacePayloadTab(DECLARATIONS);

    expect(tab.authorBlocks).toEqual(DECLARATIONS);
    const toolbox = buildPayloadToolbox(tab.authorBlocks ?? []);
    const names = toolbox.contents.map((category) => category.name);
    expect(names).toContain("题目积木");
    expect(toolboxTypes(toolbox.contents)).toContain("payload_author_overwrite-return");
    host.remove();
    workspace.remove();
  });

  it("注入后真组件可编译含动态块的画布状态:展开为公开动作序列", async () => {
    const { workspace, host, tab } = await mountWorkspacePayloadTab(DECLARATIONS);

    tab.loadWorkspaceState(authorBlockProgram());
    const result = tab.compileNow();

    expect(result?.ok).toBe(true);
    if (result === null || !result.ok) {
      return;
    }
    expect(result.program.steps.map((step) => actionOf(step))).toEqual([
      { type: "write_bytes", args: { addressHex: "0x7fff0000", bytesHex: "4141414141414141" } },
      { type: "push", args: { valueHex: "0x40" } },
      { type: "call", args: { targetHex: "0x7fff0000" } },
    ]);
    host.remove();
    workspace.remove();
  });

  it("未声明 authorBlocks:注入空声明集,真组件工具箱零动态块类型(零行为变化)", async () => {
    const { workspace, host, tab } = await mountWorkspacePayloadTab(undefined);

    expect(host.authorBlocks).toEqual([]);
    expect(tab.authorBlocks).toEqual([]);
    expect(toolboxTypes(buildPayloadToolbox(tab.authorBlocks ?? []).contents).some((type) => isAuthorBlockType(type))).toBe(false);
    host.remove();
    workspace.remove();
  });
});

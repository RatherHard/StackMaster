/**
 * Blockly 生成的 DOM id 与 jsdom 选择器引擎的相容性(jsdom 测试环境确定性化)。
 *
 * ── 根因(逐条可复核)────────────────────────────────────────────────────
 * 1. Blockly 13.2.1 `genUid()` 从 88 字符汤
 *    `!#$%()*+,-./:;=?@[]^_`{|}~` + 大小写字母 + 数字 里随机取 20 位;实现见
 *    `blockly/blockly_compressed.js`:`Mb={genUid:()=>{…charAt(Math.random()*88)}}`,
 *    公开入口 `Nb=function(){return Mb.genUid()}`(⇒ `TEST_ONLY` 是活接缝,
 *    见 `core/utils/idgenerator.d.ts`)。
 * 2. 该 id 落在 `<g class="blocklyWorkspace" role="region">` 上(实测祖先链:
 *    `g#<genUid>[role=region] < svg[role=none] < div[role=application] <
 *    div < sm-payload-tab < … < (shadow) < sm-workspace`)。`role="region"` 是
 *    地标,故 `landmark-unique` 会为它生成选择器。
 * 3. axe-core 4.13.0 `getElmId()`(axe.js:11047)拼出 `#` + `CSS.escape(id)`,
 *    随即 `doc.querySelectorAll(id)`(axe.js:11048)探测唯一性。
 * 4. jsdom 30.0.1 的选择器引擎 `@asamuzakjp/dom-selector@8.3.2` 在
 *    `parseSelector()`(`src/js/parser.js:191`)用 `/^$|^\s*>|,\s*$/` 判
 *    「尾部带逗号的选择器列表」——**以逗号结尾的 id** 转义后仍是 `#…\,`,
 *    被该正则误判为非法,抛 `SyntaxError: Invalid selector #…\,`,
 *    整个 `axe.run()` 崩掉(抖动时看到的正是这条栈)。
 * 5. 该上游缺陷在 dom-selector **9.1.4(最新)仍在**(同一行正则),而
 *    jsdom 30.0.1 声明 `^8.3.0`(8.3.2 即 8.x 末版)⇒ 版本覆盖无法解决。
 * 6. P(20 位随机 id 以 `,` 结尾) = 1/88 ≈ **1.14%**;Monte Carlo 4000 次里
 *    61 次抛错,**全部**以 `,` 结尾(`badByLastChar` 只有 `","` 一项)。
 *
 * ── 处置 ────────────────────────────────────────────────────────────────
 * 在测试环境经 Blockly 自己的测试接缝注入**确定性且 CSS 安全**的 id 生成器
 * (见 `test/setup.ts`)。本文件锁定该处置:
 *   ① 注入必须真的生效(接缝消失 ⇒ 立即红,不许悄悄退回抖动);
 *   ② 常驻窗口集内每个 id 都必须能被选择器引擎安全选择(性质断言,非抽样);
 *   ③ 上游缺陷 canary:确定性复现「逗号结尾 id ⇒ axe.run 崩」。
 */
import * as Blockly from "blockly";
import axe from "axe-core";
import { describe, expect, it } from "vitest";

import { SmWorkspace } from "../../src/workspace/sm-workspace.js";

/** 注入生成器的 id 形态(与 test/setup.ts 保持同一口径)。 */
const INJECTED_UID_PATTERN = /^sm-blockly-uid-[0-9a-z]+$/;

/** 会进 DOM 的 id 的字符口径(Blockly `getNextUniqueId()` 的公开承诺)。 */
const DOM_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

type IdGeneratorSeam = {
  genUid: () => string;
  TEST_ONLY: { genUid: () => string };
};

function seam(): IdGeneratorSeam {
  return Blockly.utils.idGenerator as unknown as IdGeneratorSeam;
}

/** 递归穿透 open shadow root 收集元素(sm-workspace → sm-payload-tab 多层)。 */
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

async function mountWorkspace(): Promise<SmWorkspace> {
  const element = new SmWorkspace();
  document.body.append(element);
  await element.updateComplete;
  // Blockly 画布在首帧后异步注入(SVG 树晚于 updateComplete 出现)。
  await new Promise((resolve) => setTimeout(resolve, 120));
  await element.updateComplete;
  return element;
}

describe("Blockly id × jsdom 选择器引擎(测试环境确定性化)", () => {
  it("测试环境注入的确定性 id 生成器已生效", () => {
    const idGenerator = seam();
    // ① 接缝在场且被替换:公开 genUid 必须直接读到注入值(Blockly 公开
    //    genUid 的实现就是 `return TEST_ONLY.genUid()`,故写 TEST_ONLY 即生效)。
    expect(
      idGenerator.TEST_ONLY.genUid,
      "Blockly 测试接缝 utils.idGenerator.TEST_ONLY 不存在或被冻结 —— 见测试文件头与 test/setup.ts",
    ).toBeTypeOf("function");
    expect(idGenerator.genUid()).toMatch(INJECTED_UID_PATTERN);
    // ② 唯一性仍是生成器的契约(Blockly 用它做 block/field/connection id)。
    const first = idGenerator.genUid();
    const second = idGenerator.genUid();
    expect(first).not.toBe(second);
  });

  it("常驻窗口集内每个 id 都满足 DOM id 字符口径且选择器不抛错", async () => {
    const workspace = await mountWorkspace();
    const withId = deepElements(document.body).filter((node) => node.id !== "");
    // 非空护栏:一个 id 都没有说明 Blockly 没渲染,断言会退化成假绿。
    expect(withId.length).toBeGreaterThan(0);
    expect(
      withId.some((node) => node.getAttribute("class") === "blocklyWorkspace"),
      "未找到 Blockly 画布根 <g class=\"blocklyWorkspace\">,断言面不成立",
    ).toBe(true);

    const failures: string[] = [];
    for (const node of withId) {
      const id = node.id;
      // ① 字符口径:Blockly 对「会进 DOM 的 id」的公开承诺是
      //    getNextUniqueId() 注释里的「ASCII 字母 / 数字 / _ / - / .」
      //    (core/utils/idgenerator.d.ts:17-21)。genUid 的 88 字符汤违反它。
      if (!DOM_ID_PATTERN.test(id)) {
        failures.push(`${JSON.stringify(id)} 含 DOM id 口径外的字符`);
      }
      // ② 与 axe `getElmId()` 同路径:在本元素的 root(shadow root / document)内
      //    用「转义后的 id 选择器」探测;抛错即真实崩溃路径。
      const root: ParentNode = node.getRootNode() as ParentNode;
      const selector = `#${CSS.escape(id)}`;
      try {
        const found = root.querySelectorAll(selector).length;
        // 0 命中说明该 id 根本无法被选中(≥2 命中是 Blockly 工具箱既有的重复
        // id 现象,与本抖动无关,不在此断言)。
        if (found === 0) {
          failures.push(`${JSON.stringify(id)} → ${selector} 命中 0 个`);
        }
      } catch (error) {
        failures.push(
          `${JSON.stringify(id)} → ${selector} 抛错:${(error as Error).message}`,
        );
      }
    }
    expect(failures).toEqual([]);
    workspace.remove();
  });

  it("canary:以逗号结尾的 id 确定性地击穿 jsdom 选择器引擎(上游缺陷复现)", async () => {
    const idGenerator = seam();
    const original = idGenerator.TEST_ONLY.genUid;
    let counter = 0;
    // 注入「唯一但一律以逗号结尾」的 id ⇒ 把 1.14% 的抖动变成 100% 的确定性复现。
    idGenerator.TEST_ONLY.genUid = (): string => {
      counter += 1;
      return `uid${String(counter)}A%)l2J,v2zjj0dyDPiq,`;
    };

    let element: SmWorkspace | null = null;
    let caught: unknown = null;
    try {
      element = await mountWorkspace();
      await axe.run(document, { runOnly: { type: "rule", values: ["landmark-unique"] } });
    } catch (error) {
      caught = error;
    } finally {
      idGenerator.TEST_ONLY.genUid = original;
      element?.remove();
    }

    // 若此断言变红:说明 jsdom / dom-selector 修好了该缺陷 —— 请删除本用例,
    // 并评估是否还 test/setup.ts 里的注入(注入本身仍是测试确定性收益)。
    expect(
      (caught as Error | null)?.message,
      "预期 jsdom 选择器引擎拒绝 `#…\\,`:上游若已修复请按注释处置",
    ).toMatch(/Invalid selector #.*\\,$/);
  });
});

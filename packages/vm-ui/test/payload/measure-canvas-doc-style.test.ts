/**
 * Blockly 文本测量画布的**文档级**离屏规则(13.4 矩阵 320px 格真根因的回归锁)。
 *
 * ── 缺陷与本文件锁定的处置 ─────────────────────────────────────────────
 * Blockly 13.2.1 为文本测量建一枚画布并**直接挂到文档 body**:
 * `blockly.min.js` 内 `Xa||(f=document.createElement("canvas"),
 * f.className="blocklyComputeCanvas",document.body.appendChild(f),…)`。
 * `<canvas>` 无 CSS 时取默认 **300×150** 且**参与文档流**,而上游**不带**该类
 * 的任何样式规则 ⇒ 窄视口下把文档撑宽(矩阵 320px 格:布局视口 288px、
 * 画布 `left=8 + 宽 300 = 308` ⇒ `innerWidth − scrollWidth = −20`,三引擎同值)。
 *
 * 修法 = 注入**文档级**离屏规则。本文件锁定三件事:
 *   ① **落点必须是文档**:画布在宿主的 shadow 树**之外**,故规则**不得**只落
 *      shadow 根 —— 否则树内样式表匹配不到树外 canvas(M1「深底光栅精灵」
 *      已实测同机理的死规则);
 *   ② **两个分支都要注入**(shadow 形态与文档形态),且幂等;
 *   ③ 规则只做**离屏定位、不改 `display`** ⇒ canvas 2D `measureText` 语义不变
 *      (零回归风险);真机终验见矩阵 320px 格。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  PAYLOAD_CANVAS_STYLE_ID,
  PAYLOAD_MEASURE_CANVAS_CSS,
  PAYLOAD_MEASURE_CANVAS_STYLE_ID,
  ensurePayloadCanvasStyles,
  ensurePayloadMeasureCanvasStyles,
} from "../../src/payload/blockly-theme.js";

/** 造一个 shadow 形态的画布宿主(shadow root 内嵌 = 生产实际形态)。 */
function shadowCanvasHost(): { host: HTMLElement; root: ShadowRoot } {
  const root = document.createElement("div").attachShadow({ mode: "open" });
  document.body.append(root.host);
  const host = document.createElement("div");
  host.className = "payload-canvas-host";
  root.append(host);
  return { host, root };
}

/** 造一个文档形态的画布宿主(宿主直接落在 light DOM)。 */
function documentCanvasHost(): HTMLElement {
  const host = document.createElement("div");
  host.className = "payload-canvas-host";
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.getElementById(PAYLOAD_CANVAS_STYLE_ID)?.remove();
  document.getElementById(PAYLOAD_MEASURE_CANVAS_STYLE_ID)?.remove();
  for (const host of Array.from(document.body.children)) {
    host.remove();
  }
});

describe("Blockly 测量画布的文档级离屏规则", () => {
  it("shadow 形态:测量规则落文档、不落 shadow 根(旧实现的漏注入点)", () => {
    const { host, root } = shadowCanvasHost();

    ensurePayloadCanvasStyles(host);

    // 画布样式表按设计落宿主所在根。
    expect(root.querySelector(`#${PAYLOAD_CANVAS_STYLE_ID}`)).not.toBeNull();
    // 测量规则必须落文档 —— 画布挂在 document.body(宿主所在根之外)。
    const measureStyle = document.getElementById(PAYLOAD_MEASURE_CANVAS_STYLE_ID);
    expect(measureStyle).not.toBeNull();
    expect(measureStyle?.textContent).toBe(PAYLOAD_MEASURE_CANVAS_CSS);
    // 反向锁定:测量规则**不得**只在 shadow 根内(树内匹配不到树外 canvas)。
    expect(root.querySelector(`#${PAYLOAD_MEASURE_CANVAS_STYLE_ID}`)).toBeNull();
  });

  it("文档形态:画布样式表与测量规则都落文档 head", () => {
    const host = documentCanvasHost();

    ensurePayloadCanvasStyles(host);

    expect(document.getElementById(PAYLOAD_CANVAS_STYLE_ID)?.parentElement).toBe(document.head);
    expect(document.getElementById(PAYLOAD_MEASURE_CANVAS_STYLE_ID)?.parentElement).toBe(
      document.head,
    );
  });

  it("幂等:重复调用(含跨分支)各只注入一份", () => {
    const first = shadowCanvasHost();
    const second = documentCanvasHost();

    ensurePayloadCanvasStyles(first.host);
    ensurePayloadCanvasStyles(second);
    ensurePayloadCanvasStyles(first.host);
    ensurePayloadMeasureCanvasStyles(document);

    expect(document.querySelectorAll(`#${PAYLOAD_MEASURE_CANVAS_STYLE_ID}`)).toHaveLength(1);
    // 画布样式表在文档形态下仍为单例(第二宿主复用已注入的那份)。
    expect(document.querySelectorAll(`#${PAYLOAD_CANVAS_STYLE_ID}`)).toHaveLength(1);
  });

  it("规则内容:离屏定位、不改 display、只命中测量画布类", () => {
    expect(PAYLOAD_MEASURE_CANVAS_CSS).toContain("canvas.blocklyComputeCanvas");
    expect(PAYLOAD_MEASURE_CANVAS_CSS).toContain("position:absolute");
    expect(PAYLOAD_MEASURE_CANVAS_CSS).toContain("top:-1000px");
    expect(PAYLOAD_MEASURE_CANVAS_CSS).toContain("left:-1000px");
    // 零回归风险的关键:`display` 未被改动 ⇒ 画布仍被渲染,measureText 语义不变。
    expect(PAYLOAD_MEASURE_CANVAS_CSS).not.toContain("display");
  });

  it("注入目标 = 传入的 doc(可作用于顶层 document 之外的文档对象)", () => {
    const doc = document.implementation.createHTMLDocument("other");
    ensurePayloadMeasureCanvasStyles(doc);
    expect(doc.getElementById(PAYLOAD_MEASURE_CANVAS_STYLE_ID)).not.toBeNull();
    // 未污染顶层文档。
    expect(document.getElementById(PAYLOAD_MEASURE_CANVAS_STYLE_ID)).toBeNull();
  });
});

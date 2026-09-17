/**
 * 机检(静态):「`white-space` 保留换行的单元格 ⇒ Lit 模板零模板排版换行」。
 *
 * ## 它防的是什么(缺陷家族)
 *
 * `white-space: pre / pre-wrap / pre-line / break-spaces` 会**逐字保留换行与缩进**;
 * 而 Lit 模板里写在**标签内部**的排版换行(开标签 `>` 之后紧跟换行 + 缩进)是
 * **非语义产物**,在 pre 语义下会被渲染成**额外行盒**,把行高撑成 N 倍:
 *
 *  - 字节视图「特殊显示」列(`render/special-display.ts` 的 `.cell-special`,
 *    样式声明在 `views/byte/byte-view.ts`):每 cell 2 个行盒 ⇒ 数据行实测
 *    **187.17px**(免折行宽)/ 236.8~259.6px(真实列宽),应然值 = 行单位
 *    **20.8px**(13px × line-height 1.6);工作区窗高下限 `MIN_ROW_HEIGHT_PX`
 *    (= 面板 chrome 182.1px + 4 × 20.8px)随之失效(可用内容区连一行都放不下)。
 *  - 指令视图地址列 / 伪机器码列(`views/instruction/sm-instruction-view.ts`
 *    的 `.row-address` / `.row-bytes`,M3 遗留-5 ①):修复前每行 **113px**、
 *    一屏仅 ≈1.5 行(M3 修复后 20.8px)。
 *  - 指令视图伪汇编列(`.row-text`,`white-space: pre-wrap`)内的跳转目标按钮:
 *    按钮**继承** pre-wrap ⇒ 模板换行同样计进行高(同族实例,真机 3 行盒,本机检覆盖)。
 *  - 跨 shadow 边界继承的同类:`workspace/sm-register-annotation.ts` 的标注容器
 *    落在 `.row-address`(pre)内(修复前 4 个行盒;M3 已修,由运行护栏与
 *    `双向一跳` 的类名并集共同看护 —— 见下文「覆盖边界」)。
 *
 * ## 机检口径
 *
 * 递归扫描 `src` 下全部 `.ts` 源码**文本**(不经 DOM、不经 jsdom,**零级联依赖**):
 *  1. 从 CSS 文本里取全部「声明了保留换行的 `white-space`」的**主体复合选择器**
 *     (`.` 类名 / 裸元素名),得到跨文件的「pre 作用域 token」表;
 *  2. 解析每个文件的 ES import 边 ⇒ 某文件的作用域 = 自身 ∪ 直接 import 的模块
 *     ∪ 直接 import 它的模块(**双向一跳**;helper 与宿主组件互为邻居的两种
 *     真实写法都被覆盖)。这条边界的意义:组件 `static styles` 是 shadow 作用域,
 *     声明文件里的规则只作用于**渲染进它 shadow 根**的模板;helper 模块
 *     (`render/special-display.ts` 之于 `views/byte/byte-view.ts`)正是这种形态,
 *     而无关组件之间不会互相污染(零误报面)。
 *  3. 提取全部模板字面量(屏蔽 `${…}` 插值以消除 `=>` 之类属性内 `>` 的干扰),
 *     建标签树;按 **CSS `white-space` 继承语义**逐元素算「有效值」(自身显式声明
 *     优先,否则继承父元素;缺省 `normal`)— 显式声明非 pre 值的元素天然成为
 *     继承**重置边界**(故 `display: flex` 容器、`.reg-values { nowrap }` 这类
 *     合法重置不会被误报;
 *  4. 断言:有效值 ∈ pre 家族的元素的**直接文本节点**(已剔除嵌套元素标记与
 *     HTML 注释 —— 子元素**属性区**里的换行是标记排版,不产生任何行盒)中
 *     不得出现换行。之所以是「任意换行」而非「首尾换行」:pre 下 `a\nb` 与
 *     `\na` 同样多一个行盒;而嵌套元素自己的文本由它自己那条判定负责
 *     (它继承 pre 时同样在扫描范围内,插值内 `html\`` 片段按宿主元素的
 *     有效值递归判定)。
 *
 * 只校验「有效值 ∈ pre 家族」的元素,故 `white-space: normal / nowrap` 处的
 * 多行排版(例如工作区大量「标签之间换行」的排版风格 —— HTML 折叠空白,无害)
 * **一律不报**:机检针对的是有害处,不是排版风格。
 *
 * ## 覆盖边界(诚实登记,不得视为已覆盖)
 *
 *  - **跨组件 shadow 继承不建模**:`<sm-register-annotation>` 渲染进宿主
 *    `.row-address`(pre)内,但两者是不同 shadow 根、无 import 边 ⇒ 机检不会
 *    给该子组件的**模板根**套上 pre 上下文;只有「它自己的元素带了可归因的
 *    pre 类名」时才会被判。该面由运行护栏
 *    (`test/views/instruction/sm-instruction-view.test.ts` 的「pre 单元格零
 *    保留换行」组,jsdom 实测 `textContent` 换行数)兜底,双保险不同源。
 *  - **`display: flex` 的空白折叠不在模型内**(flex 容器丢弃纯空白子项):
 *    机检按「pre 保留」从严判定,故 flex 容器内的换行**只会误报、不会漏报**
 *    (现状零误报:`.chain` 等 flex 容器处的换行都发生在非 pre 上下文)。
 *  - **动态类名**(`class=${expr}`)无法静态归因,不参与判定。
 *
 * ## 自校验(防「扫描器坏了 ⇒ 静默全绿」)
 *
 * `语料自校验` 组用合成语料证明三件事:①缺陷形态(标签内部换行 + pre)必红;
 * ②等价修复形态(插值紧贴尖括号)必绿;③非 pre 声明同一形态必绿(证明机检有
 * 判定力而非「见换行就报」)。另断言真实源码里**确实读到了**已知的 pre 作用域
 * token(`cell-special` / `row-address` / `row-bytes` / `row-text` / `cell-hex` /
 * `hex-grouped`)——若 CSS 提取逻辑失效导致作用域表为空,本组同样变红。
 *
 * **红/绿双向取证(2026-09-18)**:把两处产品修复临时回退到缺陷形态后跑本文件,
 * 实测 4 条违规中 3 条来自真实源码(`render/special-display.ts:65` 与 `:69` 的
 * `<span>`、`views/instruction/sm-instruction-view.ts:681` 的 `<button>`)⇒
 * **修复前必红**已实证,非「写完就是绿」。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";

import { describe, expect, it } from "vitest";

/* ── 语料类型 ──────────────────────────────────────────────────────────────── */

/** 一个源码文件(路径为仓库相对 POSIX 风格,便于断言消息稳定)。 */
interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** 单条违规。 */
interface Violation {
  readonly file: string;
  readonly line: number;
  readonly tag: string;
  readonly detail: string;
  readonly declaredIn: string;
}

/** 保留换行的 `white-space` 取值(pre 家族;`nowrap` / `normal` 不在此列)。 */
const NEWLINE_PRESERVING = new Set(["pre", "pre-wrap", "pre-line", "break-spaces"]);

/** 声明形态:必须带 `;` / `}` 终止,避免把注释里的散文(如「…是 white-space: pre 单元格」)当成声明。 */
const WHITE_SPACE_DECLARATION = /white-space\s*:\s*([a-z-]+)\s*(?:;|\})/gu;

/** 不受继承影响的空元素(不构成可嵌套的父级)。 */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

/* ── 模板字面量提取(屏蔽插值)────────────────────────────────────────────── */

/** 跳过字符串字面量,返回收尾引号之后的下标。 */
function skipString(text: string, start: number): number {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === quote) {
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

/** 跳过模板字面量(含嵌套 `${…}` 内的模板),返回收尾反引号之后的下标。 */
function skipTemplate(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`") {
      return index + 1;
    }
    if (char === "$" && text[index + 1] === "{") {
      index = skipInterpolation(text, index + 1);
      continue;
    }
    index += 1;
  }
  return text.length;
}

/** 跳过 `${…}`(花括号配对;内部字符串 / 嵌套模板正确跨越),返回 `}` 之后的下标。 */
function skipInterpolation(text: string, braceIndex: number): number {
  let depth = 0;
  let index = braceIndex;
  while (index < text.length) {
    const char = text[index];
    if (char === "`") {
      index = skipTemplate(text, index);
      continue;
    }
    if (char === '"' || char === "'") {
      index = skipString(text, index);
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index);
      index = close === -1 ? text.length : close + 2;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
    index += 1;
  }
  return text.length;
}

/** 模板字面量片段(绝对下标;`masked` 与原文等长,便于回推行号)。 */
interface TemplateSpan {
  readonly contentStart: number;
  readonly contentEnd: number;
  /** `${…}` 已替换为等长占位符的模板正文(标签扫描用)。 */
  readonly masked: string;
  /**
   * 插值内**嵌套的模板字面量**(绝对偏移)。Lit 里 `html\`<span>${cond ? html\`<b>…\` : nothing}</span>\``
   * 是常态(跳转目标按钮即此形态)⇒ 嵌套模板必须**在宿主元素的继承上下文里**
   * 继续判定,否则继承 pre 的子元素(本族最容易漏的一类)会整批漏网。
   */
  readonly children: readonly { readonly offset: number; readonly span: TemplateSpan }[];
}

/** 提取文件内全部模板字面量(注释 / 普通字符串内的反引号不误判;含插值内嵌套模板)。 */
function extractTemplates(text: string): TemplateSpan[] {
  const spans: TemplateSpan[] = [];
  scanCode(text, 0, text.length, spans, 0);
  return spans;
}

/** 扫描代码区间,登记其中全部模板字面量(`base` = 区间起点在文件内的绝对偏移)。 */
function scanCode(
  text: string,
  start: number,
  end: number,
  out: TemplateSpan[],
  base: number,
): void {
  let index = start;
  while (index < end) {
    const char = text[index];
    if (char === "`") {
      const close = skipTemplate(text, index);
      const children: { offset: number; span: TemplateSpan }[] = [];
      const masked = maskTemplateBody(
        text.slice(index + 1, Math.max(index + 1, close - 1)),
        base + index + 1,
        children,
      );
      out.push({
        contentStart: base + index + 1,
        contentEnd: base + Math.max(index + 1, close - 1),
        masked,
        children,
      });
      index = Math.max(close, index + 1);
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 || newline > end ? end : newline;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index);
      index = close === -1 || close + 2 > end ? end : close + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      index = Math.min(skipString(text, index), end);
      continue;
    }
    index += 1;
  }
}

/** 模板正文掩码:`${…}` 整体替换为等长 NUL,并递归登记插值内的嵌套模板。 */
function maskTemplateBody(
  raw: string,
  base: number,
  children: { offset: number; span: TemplateSpan }[],
): string {
  let masked = "";
  let index = 0;
  while (index < raw.length) {
    if (raw[index] === "\\") {
      masked += raw[index] + (raw[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (raw[index] === "$" && raw[index + 1] === "{") {
      const close = skipInterpolation(raw, index + 1);
      const nested: TemplateSpan[] = [];
      scanCode(raw, index + 2, Math.max(index + 2, close - 1), nested, base);
      for (const span of nested) {
        children.push({ offset: span.contentStart, span });
      }
      masked += "\u0000".repeat(Math.max(0, close - index));
      index = Math.max(close, index + 1);
      continue;
    }
    masked += raw[index];
    index += 1;
  }
  return masked;
}

/* ── CSS 作用域提取 ───────────────────────────────────────────────────────── */

/** 一个文件声明的 `white-space` 作用域面。 */
interface WhiteSpaceScopes {
  /** 声明了保留换行取值的类名 → 声明出处(`文件:行`) */
  readonly preClasses: Map<string, string>;
  /** 声明了保留换行取值的裸元素名 → 声明出处 */
  readonly preTypes: Map<string, string>;
  /** 显式声明过 `white-space`(任意取值)的类名 → 取值(继承重置边界识别) */
  readonly declaredClasses: Map<string, string>;
  /** 显式声明过 `white-space`(任意取值)的裸元素名 → 取值 */
  readonly declaredTypes: Map<string, string>;
}

function emptyScopes(): WhiteSpaceScopes {
  return {
    preClasses: new Map(),
    preTypes: new Map(),
    declaredClasses: new Map(),
    declaredTypes: new Map(),
  };
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** 取声明所在规则块的**主体复合选择器**(逗号分列,各取最后一个跳级组合子之后的部分)。 */
function subjectCompounds(selectorText: string): string[] {
  return selectorText
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => part.split(/[\s>+~]+/u).filter((token) => token !== "").at(-1) ?? "");
}

/** 收集一个文件的 `white-space` 作用域。 */
function collectScopes(file: SourceFile): WhiteSpaceScopes {
  const scopes = emptyScopes();
  for (const match of file.text.matchAll(WHITE_SPACE_DECLARATION)) {
    const value = match[1] ?? "";
    const index = match.index ?? 0;
    const brace = file.text.lastIndexOf("{", index);
    if (brace === -1) {
      continue;
    }
    // `{` 之后到本声明之间不得出现 `}`(否则该 `{` 属于别的块;同块内更早的
    // 声明以 `;` 结尾是正常形态,不构成排除条件)。
    const between = file.text.slice(brace + 1, index);
    if (between.includes("}")) {
      continue;
    }
    const previous = Math.max(
      file.text.lastIndexOf("}", brace - 1),
      file.text.lastIndexOf(";", brace - 1),
      file.text.lastIndexOf("{", brace - 1),
    );
    const selectorText = file.text.slice(previous + 1, brace);
    const origin = `${file.path}:${String(lineOf(file.text, index))}`;
    for (const compound of subjectCompounds(selectorText)) {
      for (const classMatch of compound.matchAll(/\.([A-Za-z_][\w-]*)/gu)) {
        const className = classMatch[1] ?? "";
        scopes.declaredClasses.set(className, value);
        if (NEWLINE_PRESERVING.has(value)) {
          scopes.preClasses.set(className, origin);
        }
      }
      const typeMatch = /^([a-zA-Z][\w-]*)/u.exec(compound);
      if (typeMatch !== null) {
        const typeName = (typeMatch[1] ?? "").toLowerCase();
        scopes.declaredTypes.set(typeName, value);
        if (NEWLINE_PRESERVING.has(value)) {
          scopes.preTypes.set(typeName, origin);
        }
      }
    }
  }
  return scopes;
}

/** 合并多份作用域(邻居并集)。 */
function mergeScopes(all: readonly WhiteSpaceScopes[]): WhiteSpaceScopes {
  const merged = emptyScopes();
  for (const scopes of all) {
    for (const [key, value] of scopes.preClasses) {
      if (!merged.preClasses.has(key)) {
        merged.preClasses.set(key, value);
      }
    }
    for (const [key, value] of scopes.preTypes) {
      if (!merged.preTypes.has(key)) {
        merged.preTypes.set(key, value);
      }
    }
    for (const [key, value] of scopes.declaredClasses) {
      merged.declaredClasses.set(key, value);
    }
    for (const [key, value] of scopes.declaredTypes) {
      merged.declaredTypes.set(key, value);
    }
  }
  return merged;
}

/* ── import 边(双向一跳)──────────────────────────────────────────────────── */

const IMPORT_SPECIFIER = /(?:from\s*|import\s*)\(?\s*["'](\.[^"']+)["']/gu;

/** 相对说明符 → 语料内的文件键(允许 `.js` 书写对 `.ts` 源文件)。
 *  语料路径是 POSIX 风格 ⇒ 一律走 `path.posix`(Windows 上 `path.resolve("/", …)`
 *  会落到当前盘根,导致边解析全部失效 —— 那样机检会静默退化为「作用域为空」)。 */
function resolveSpecifier(fromPath: string, specifier: string): string | null {
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const candidates = [base, base.replace(/\.js$/u, ".ts"), `${base}/index.ts`, `${base}.ts`];
  return candidates.find((candidate) => candidate.endsWith(".ts")) ?? null;
}

/* ── 标签扫描与继承语义判定 ───────────────────────────────────────────────── */

/** 模板内的一个元素(含直接内容区间)。 */
interface ElementNode {
  readonly name: string;
  readonly openStart: number;
  readonly contentStart: number;
  contentEnd: number;
  parent: ElementNode | null;
  /** 该元素自身 class 属性内出现的静态类名 token。 */
  readonly classes: readonly string[];
  /** 自身显式声明的 `white-space` 取值(无声明 = null)。 */
  ownWhiteSpace: string | null;
  /** 有效取值(自身显式优先,否则继承父元素 / 外层模板上下文;根缺省 `normal`)。 */
  effectiveWhiteSpace: string;
  /** 直接文本节点(插值已掩码、嵌套元素标记与其子树、HTML 注释均已剔除)。 */
  contentText: string;
  /** 文本片段累积(扫描期内部用;结束时 join 成 `contentText`)。 */
  readonly textRuns: string[];
}

function readTag(masked: string, start: number): { name: string; end: number; attributeText: string } | null {
  // start 指向 `<`;调用方已排除注释 / 闭标签。
  let index = start + 1;
  while (index < masked.length && /\s/u.test(masked[index] ?? "")) {
    index += 1;
  }
  const nameMatch = /^([a-zA-Z][\w-]*)/u.exec(masked.slice(index));
  if (nameMatch === null) {
    return null;
  }
  const name = (nameMatch[1] ?? "").toLowerCase();
  index += name.length;
  const attributeStart = index;
  while (index < masked.length) {
    const char = masked[index];
    if (char === '"' || char === "'") {
      index = skipString(masked, index);
      continue;
    }
    if (char === ">") {
      return { name, end: index + 1, attributeText: masked.slice(attributeStart, index) };
    }
    index += 1;
  }
  return null;
}

/** 建树:返回模板内全部元素(含有效 `white-space` 与直接文本节点判定结果)。 */
function collectElements(
  template: TemplateSpan,
  scopes: WhiteSpaceScopes,
  inherited: string,
): ElementNode[] {
  const masked = template.masked;
  const nodes: ElementNode[] = [];
  const stack: ElementNode[] = [];
  const appendRun = (run: string): void => {
    // 只有**最内层**打开的元素收文本:嵌套元素的文本归它自己那条判定。
    stack.at(-1)?.textRuns.push(run);
  };
  let index = 0;
  while (index < masked.length) {
    const char = masked[index];
    if (char !== "<") {
      let runEnd = index;
      while (runEnd < masked.length && masked[runEnd] !== "<") {
        runEnd += 1;
      }
      appendRun(masked.slice(index, runEnd));
      index = runEnd;
      continue;
    }
    if (masked.startsWith("<!--", index)) {
      const close = masked.indexOf("-->", index);
      index = close === -1 ? masked.length : close + 3;
      continue;
    }
    if (masked[index + 1] === "/") {
      const closeMatch = /^<\/([a-zA-Z][\w-]*)\s*>/u.exec(masked.slice(index));
      const name = (closeMatch?.[1] ?? "").toLowerCase();
      // 配对收尾:从栈顶向下找同名元素(其文本片段就此定稿,并记下内容区间)。
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (stack[depth]?.name === name) {
          const node = stack[depth];
          if (node !== undefined) {
            node.contentEnd = index;
          }
          stack.length = depth;
          break;
        }
      }
      index += closeMatch === null ? 1 : closeMatch[0].length;
      continue;
    }
    const tag = readTag(masked, index);
    if (tag === null) {
      appendRun("<");
      index += 1;
      continue;
    }
    const selfClosing = masked.slice(index, tag.end).trimEnd().endsWith("/>");
    const classMatch = /class\s*=\s*("([^"]*)"|'([^']*)')/u.exec(tag.attributeText);
    const classText = classMatch?.[2] ?? classMatch?.[3] ?? "";
    const classes = classText
      .split(/\s+/u)
      .filter((token) => token !== "" && !token.includes("\u0000"));
    const parent = stack.at(-1) ?? null;
    const own = ownWhiteSpace(classes, tag.name, scopes);
    const node: ElementNode = {
      name: tag.name,
      openStart: index,
      contentStart: tag.end,
      contentEnd: masked.length,
      parent,
      classes,
      ownWhiteSpace: own,
      effectiveWhiteSpace: own ?? parent?.effectiveWhiteSpace ?? inherited,
      contentText: "",
      textRuns: [],
    };
    nodes.push(node);
    if (!selfClosing && !VOID_ELEMENTS.has(tag.name)) {
      stack.push(node);
    }
    index = tag.end;
  }
  for (const node of nodes) {
    node.contentText = node.textRuns.join("");
  }
  return nodes;
}

/** 元素自身的显式 `white-space` 声明(类名 / 元素名任一命中即为显式;类名优先)。 */
function ownWhiteSpace(
  classes: readonly string[],
  tagName: string,
  scopes: WhiteSpaceScopes,
): string | null {
  for (const className of classes) {
    const value = scopes.declaredClasses.get(className);
    if (value !== undefined) {
      return value;
    }
  }
  return scopes.declaredTypes.get(tagName) ?? null;
}

/* ── 主检查 ───────────────────────────────────────────────────────────────── */

/** 声明出处(用于违规消息):沿自身 / 祖先链找第一条**显式** pre 声明。 */
function declaredIn(element: ElementNode, scopes: WhiteSpaceScopes): string {
  let node: ElementNode | null = element;
  while (node !== null) {
    if (node.ownWhiteSpace !== null && NEWLINE_PRESERVING.has(node.ownWhiteSpace)) {
      for (const className of node.classes) {
        const origin = scopes.preClasses.get(className);
        if (origin !== undefined) {
          return `${origin}(${node.name}.${className})`;
        }
      }
      const typeOrigin = scopes.preTypes.get(node.name);
      if (typeOrigin !== undefined) {
        return `${typeOrigin}(${node.name})`;
      }
      return `自身内联声明(${node.name})`;
    }
    node = node.parent;
  }
  return "继承自外层模板上下文的 pre 单元格";
}

/** 全量检查:返回违规列表(空 = 通过)。 */
function findViolations(files: readonly SourceFile[]): Violation[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const ownScopes = new Map(files.map((file) => [file.path, collectScopes(file)]));
  const importedBy = new Map<string, string[]>();
  const importsOf = new Map<string, string[]>();
  for (const file of files) {
    const targets: string[] = [];
    for (const match of file.text.matchAll(IMPORT_SPECIFIER)) {
      const resolved = resolveSpecifier(file.path, match[1] ?? "");
      if (resolved === null || !byPath.has(resolved) || resolved === file.path) {
        continue;
      }
      targets.push(resolved);
    }
    importsOf.set(file.path, targets);
    for (const target of targets) {
      importedBy.set(target, [...(importedBy.get(target) ?? []), file.path]);
    }
  }

  const violations: Violation[] = [];
  for (const file of files) {
    const neighbours = [
      ...(importsOf.get(file.path) ?? []),
      ...(importedBy.get(file.path) ?? []),
      file.path,
    ].map((path) => ownScopes.get(path) ?? emptyScopes());
    const scopes = mergeScopes(neighbours);

    /**
     * 逐模板判定;嵌套模板(插值内的 `html\`` 片段)**在宿主元素的继承上下文里**
     * 继续判定(`inherited` = 该插值所在元素的有效 `white-space`)。
     */
    const scan = (template: TemplateSpan, inherited: string): void => {
      const elements = collectElements(template, scopes, inherited);
      for (const element of elements) {
        if (!NEWLINE_PRESERVING.has(element.effectiveWhiteSpace)) {
          continue;
        }
        if (!element.contentText.includes("\n")) {
          continue;
        }
        const leading = /^[ \t\r]*\n/u.test(element.contentText);
        const trailing = /\n[ \t\r]*$/u.test(element.contentText);
        const position = leading ? "开标签后" : trailing ? "收标签前" : "内容中间";
        violations.push({
          file: file.path,
          line: lineOf(file.text, template.contentStart + element.openStart),
          tag: element.name,
          detail: `${position}存在被 ${element.effectiveWhiteSpace} 逐字保留的换行 ⇒ 额外行盒`,
          declaredIn: declaredIn(element, scopes),
        });
      }
      for (const child of template.children) {
        const host =
          elements
            .filter(
              (element) =>
                child.offset >= template.contentStart + element.contentStart &&
                child.offset <= template.contentStart + element.contentEnd,
            )
            .at(-1) ?? null;
        scan(child.span, host?.effectiveWhiteSpace ?? inherited);
      }
    };

    for (const template of extractTemplates(file.text)) {
      scan(template, "normal");
    }
  }
  return violations;
}

/* ── 语料装配 ─────────────────────────────────────────────────────────────── */

/** 定位 vm-ui 的 `src/`(包内 / 仓库根两种 cwd 形态均可)。 */
function resolveSrcDir(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    for (const candidate of [join(dir, "src"), join(dir, "packages", "vm-ui", "src")]) {
      if (existsSync(join(candidate, "render", "special-display.ts"))) {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("未定位到 vm-ui 的 src/ 目录(pre 单元格机检失败)");
}

/** 递归收集 `src` 下全部 `.ts` 语料。 */
function collectSourceFiles(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts")) {
        files.push({
          path: full.slice(root.length + 1).split(sep).join("/"),
          text: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(root);
  return files;
}

/* ── 自校验 + 真实源码机检 ────────────────────────────────────────────────── */

/**
 * 合成语料:声明方(宿主组件 `views/demo-view.ts`)与渲染方(render helper
 * `render/demo-cell.ts`)分处两文件 —— 复刻 `.cell-special`(声明在
 * `views/byte/byte-view.ts`、渲染在 `render/special-display.ts`)的真实形态。
 * `cssBody` = 宿主样式表正文(相对 `css` 模板的缩进自行书写)。
 */
function syntheticFiles(helperTemplate: string, cssBody: string): SourceFile[] {
  return [
    {
      path: "views/demo-view.ts",
      text: [
        "import { renderDemoCell } from '../render/demo-cell.js';",
        "export const styles = css`",
        ...cssBody.split("\n").map((line) => `  ${line}`),
        "`;",
        "export function renderRow(): unknown {",
        "  return html`<span class=\"row-demo\">${renderDemoCell(1)}</span>`;",
        "}",
      ].join("\n"),
    },
    {
      path: "render/demo-cell.ts",
      text: `export function renderDemoCell(byte: number): unknown {\n  return html${helperTemplate};\n}\n`,
    },
  ];
}

/** 单条声明形态(自校验最常用):一类一格,`white-space: <取值>`。 */
function cssFor(whiteSpace: string, className = "cell-demo"): string {
  return `.${className} {\n  white-space: ${whiteSpace};\n}`;
}

describe("机检:pre 单元格零模板排版换行(全包静态扫描 src 下全部 .ts)", () => {
  describe("语料自校验(证明机检有判定力且非空转)", () => {
    it("缺陷形态(标签内部换行 + 缩进 + pre)必红", () => {
      const violations = findViolations(
        syntheticFiles('`<span class="cell-demo">\n      ${byte}</span>`', cssFor("pre")),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.file).toBe("render/demo-cell.ts");
      expect(violations[0]?.tag).toBe("span");
      expect(violations[0]?.detail).toContain("pre");
      // 声明出处必须指回宿主组件的样式表(跨文件作用域解析生效)。
      expect(violations[0]?.declaredIn).toBe("views/demo-view.ts:4(span.cell-demo)");
    });

    it("等价修复形态(插值紧贴尖括号)必绿", () => {
      const violations = findViolations(
        syntheticFiles('`<span class="cell-demo">${byte}</span>`', cssFor("pre")),
      );
      expect(violations).toEqual([]);
    });

    it("非保留换行的 white-space 同一形态必绿(机检只打有害处,不是见换行就报)", () => {
      for (const value of ["normal", "nowrap"]) {
        expect(
          findViolations(syntheticFiles('`<span class="cell-demo">\n      ${byte}</span>`', cssFor(value))),
        ).toEqual([]);
      }
    });

    it("同类取值的其余成员(pre-wrap / pre-line / break-spaces)同样必红", () => {
      for (const value of ["pre-wrap", "pre-line", "break-spaces"]) {
        expect(
          findViolations(syntheticFiles('`<span class="cell-demo">\n      ${byte}</span>`', cssFor(value))),
        ).toHaveLength(1);
      }
    });

    it("属性区的换行无害(只有内容区换行才计进行盒)", () => {
      const violations = findViolations(
        syntheticFiles(
          '`<span\n    class="cell-demo"\n    data-byte="41"\n  >${byte}</span>`',
          cssFor("pre"),
        ),
      );
      expect(violations).toEqual([]);
    });

    it("M3 遗留-5 ① 的原始形态(指令视图地址列 / 伪机器码列,逐字复刻)必红", () => {
      // 修复前形态:插值单独成行、按钮内部文本单独成行(两个 pre 单元格各 6 个行盒)。
      const originalInstructionRow =
        "`\n" +
        "        <div class=\"instruction-row\" role=\"row\">\n" +
        "          <span class=\"row-address\" role=\"cell\">\n" +
        "            <button class=\"breakpoint-toggle\">○</button> 0x00401000\n" +
        "          </span>\n" +
        "          <span class=\"row-bytes\" role=\"cell\">\n" +
        "            4889e5\n" +
        "          </span>\n" +
        "        </div>\n" +
        "      `";
      const violations = findViolations(
        syntheticFiles(
          originalInstructionRow,
          ".row-address {\n  white-space: pre;\n}\n.row-bytes {\n  white-space: pre;\n}",
        ),
      );
      // `row-address` / `row-bytes` 两个 pre 单元格各 1 条(+ 其内嵌断点按钮继承 pre)。
      expect(violations.length).toBeGreaterThanOrEqual(2);
      expect(violations.map((item) => item.declaredIn)).toContain(
        "views/demo-view.ts:4(span.row-address)",
      );
      expect(violations.some((item) => item.tag === "span" && item.detail.includes("开标签后"))).toBe(
        true,
      );
    });

    it("继承重置边界:祖先 pre、自身显式 nowrap 的嵌套元素不报", () => {
      const files = syntheticFiles('`<span class="cell-demo">${byte}</span>`', cssFor("pre"));
      const withNested: SourceFile[] = [
        files[0] as SourceFile,
        {
          path: "render/demo-cell.ts",
          text:
            'export function renderDemoCell(byte: number): unknown {\n  return html`<span class="cell-demo">${byte}<span class="cell-demo-inner">\n      ${byte}</span></span>`;\n}\n',
        },
        {
          path: "views/inner.ts",
          text: "export const styles = css`\n  .cell-demo-inner {\n    white-space: nowrap;\n  }\n`;\n",
        },
      ];
      // `.cell-demo-inner` 在 render/demo-cell.ts 的邻居集内(helper 与宿主双向一跳);
      // 此处直接把它挂在声明文件上,验证「显式非 pre ⇒ 重置继承 ⇒ 不报」。
      const withInnerNeighbour = withNested.map((file) =>
        file.path === "views/demo-view.ts"
          ? {
              path: file.path,
              text: `${file.text}\nimport './inner.js';\nexport const inner = css\`\n  .cell-demo-inner {\n    white-space: nowrap;\n  }\n\`;\n`,
            }
          : file,
      );
      expect(findViolations(withInnerNeighbour)).toEqual([]);
    });
  });

  it("真实源码:已知 pre 作用域 token 必须被读到(防扫描器失效导致静默全绿)", () => {
    const files = collectSourceFiles(resolveSrcDir());
    const scopes = mergeScopes(files.map((file) => collectScopes(file)));
    for (const token of [
      "cell-special",
      "cell-hex",
      "hex-grouped",
      "row-address",
      "row-bytes",
      "row-text",
    ]) {
      expect(scopes.preClasses.has(token), `未读到 pre 类:${token}`).toBe(true);
    }
    // `nowrap` 不得被当成保留换行(取值判定力)。
    expect(scopes.declaredClasses.get("reg-values")).toBe("nowrap");
    expect(scopes.preClasses.has("reg-values")).toBe(false);
  });

  it("真实源码零违规:声明 pre 的单元格模板内不得出现标签内部换行", () => {
    const violations = findViolations(collectSourceFiles(resolveSrcDir()));
    expect(
      violations,
      `pre 单元格模板排版换行(幻影空行 ⇒ 行高暴涨):\n${violations
        .map((item) => `  ${item.file}:${String(item.line)} <${item.tag}> ${item.detail}(声明于 ${item.declaredIn})`)
        .join("\n")}`,
    ).toEqual([]);
  });
});

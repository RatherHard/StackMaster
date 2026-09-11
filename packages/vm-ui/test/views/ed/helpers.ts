/**
 * 教学组件测试小工具(FE-ED 组件面统一形态;镜像 test/views/register 的用法)。
 */
import type { LitElement } from "lit";

/** 取 shadow DOM 内元素的健壮查询。 */
export function queryShadow<T extends Element = Element>(
  element: LitElement,
  selector: string,
): T | null {
  return (element.shadowRoot?.querySelector(selector) ?? null) as T | null;
}

/** 取 shadow DOM 内全部匹配元素。 */
export function queryAllShadow<T extends Element = Element>(
  element: LitElement,
  selector: string,
): T[] {
  return Array.from(element.shadowRoot?.querySelectorAll(selector) ?? []) as T[];
}

/** 挂载组件(append 到 body + 等待首帧渲染)。 */
export async function mount<T extends LitElement>(tag: string): Promise<T> {
  const element = document.createElement(tag) as T;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

/** 向 shadow 内 input 设置值并派发 input 事件(Lit 受控输入同步)。 */
export function setInputValue(element: LitElement, selector: string, value: string): void {
  const input = queryShadow<HTMLInputElement>(element, selector);
  if (input === null) {
    throw new Error(`input 不存在:${selector}`);
  }
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

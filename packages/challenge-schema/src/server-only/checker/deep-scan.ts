/**
 * 公开包实例字符串深扫描(ZR-B8-CAP-SCAN / XS-ID-NO-PRIVATE 共用):
 * 递归对象与数组,对每个字符串值回调(附 JSON 指针风格路径)。
 * 只扫值不扫键——键名是 Schema 冻结的,值才是作者可控面。
 */

export type StringValueVisitor = (text: string, path: string) => void;

/** 深度优先扫描全部字符串值。 */
export function scanStringValues(value: unknown, visit: StringValueVisitor, path = ""): void {
  if (typeof value === "string") {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanStringValues(item, visit, `${path}/${index}`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      scanStringValues(child, visit, `${path}/${key}`);
    }
  }
}

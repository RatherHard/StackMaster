/**
 * 重复引用 ID 检测(XS-ID-UNIQUE 公开 / 私有两侧共用)。
 */

import type { CheckerViolation } from "./types.js";

/**
 * 顺序扫描值列表,对每个与更早项重复的值记一条 XS-ID-UNIQUE 违规
 * (路径锚在重复项自身,消息里给出首次出现位置)。
 */
export function pushDuplicateViolations(
  violations: CheckerViolation[],
  values: readonly string[],
  buildPath: (index: number) => string,
  describe: (value: string) => string,
): void {
  const seen = new Map<string, number>();
  values.forEach((value, index) => {
    const firstIndex = seen.get(value);
    if (firstIndex === undefined) {
      seen.set(value, index);
      return;
    }
    violations.push({
      ruleId: "XS-ID-UNIQUE",
      message: `${describe(value)}与第 ${firstIndex} 项重复`,
      path: buildPath(index),
    });
  });
}

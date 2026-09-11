/**
 * validateCheckpointLabel 测试(FE-ED-05 标签校验):与 protocol
 * CreateCheckpointArgsSchema 同则——≤ 128 字符、禁 C0/C1 控制字符。
 */
import { describe, expect, it } from "vitest";

import { validateCheckpointLabel } from "../../src/ed/ed-types.js";

describe("validateCheckpointLabel", () => {
  it("合法标签(含 128 字符边界)→ null", () => {
    expect(validateCheckpointLabel("buffer 覆盖前存档")).toBeNull();
    expect(validateCheckpointLabel("a".repeat(128))).toBeNull();
  });

  it("超过 128 字符 → 拒绝并给原因", () => {
    const violation = validateCheckpointLabel("a".repeat(129));
    expect(violation).toContain("128");
  });

  it("C0/C1 控制字符(含 DEL)→ 拒绝并给原因", () => {
    expect(validateCheckpointLabel("bad\u0007bell")).toContain("控制字符");
    expect(validateCheckpointLabel("bad\u009F")).toContain("控制字符");
    expect(validateCheckpointLabel("bad\u007F")).toContain("控制字符");
  });

  it("空串与空白 → 合法(组件层 trim 后按无标签处理)", () => {
    expect(validateCheckpointLabel("")).toBeNull();
    expect(validateCheckpointLabel("   ")).toBeNull();
  });
});

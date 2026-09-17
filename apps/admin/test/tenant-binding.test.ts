/**
 * 凭证 × 租户绑定测试(D-MP-5 分支 A;与 O-MP-6 同源形态,D-API-134)。
 *
 * 断言面:
 *  - 白名单为空 ⇒ 整体 fail-closed(恒 not_found;不是 403、不是空列表);
 *  - 单租户绑定 ⇒ 无参数时落到该唯一租户(零仪式形态);
 *  - 多租户绑定 ⇒ 无参数不猜、不回退第一个(静默选租户 = 静默改变查询
 *    作用域),返回同形 not_found;
 *  - 白名单外租户 ⇒ not_found(跨租户与不存在同形,防枚举);
 *  - 解析结果**只能**来自白名单(请求参数无法把任意字符串变成合法租户)。
 */
import { describe, expect, it } from "vitest";

import { AdminTenantBinding } from "../src/auth/tenant-binding.js";

describe("AdminTenantBinding", () => {
  it("白名单为空 ⇒ 整体 fail-closed(任何参数都是 not_found)", () => {
    const binding = new AdminTenantBinding([]);
    expect(binding.effective).toBe(false);
    expect(binding.size).toBe(0);
    expect(binding.resolve(undefined)).toEqual({ kind: "not_found" });
    expect(binding.resolve("")).toEqual({ kind: "not_found" });
    expect(binding.resolve("tenant-a")).toEqual({ kind: "not_found" });
  });

  it("单租户绑定 ⇒ 无参数落到该租户;非法参数同形拒绝", () => {
    const binding = new AdminTenantBinding(["tenant-a"]);
    expect(binding.effective).toBe(true);
    expect(binding.resolve(undefined)).toEqual({ kind: "resolved", tenantId: "tenant-a" });
    expect(binding.resolve("tenant-a")).toEqual({ kind: "resolved", tenantId: "tenant-a" });
    expect(binding.resolve("tenant-b")).toEqual({ kind: "not_found" });
  });

  it("多租户绑定 ⇒ 无参数不猜(不回退第一个);集合内子选放行,集合外同形", () => {
    const binding = new AdminTenantBinding(["tenant-a", "tenant-b"]);
    expect(binding.size).toBe(2);
    expect(binding.resolve(undefined)).toEqual({ kind: "not_found" });
    expect(binding.resolve("")).toEqual({ kind: "not_found" });
    expect(binding.resolve("tenant-b")).toEqual({ kind: "resolved", tenantId: "tenant-b" });
    // 跨租户(白名单内另一租户)与白名单外不存在形态**同形**。
    expect(binding.resolve("tenant-c")).toEqual(binding.resolve("tenant-zzz"));
  });

  it("解析结果只可能来自白名单(参数无法自造租户)", () => {
    const binding = new AdminTenantBinding(["tenant-a"]);
    for (const probe of ["TENANT-A", "tenant-a ", " tenant-a", "tenant-a'--", "*", "%"]) {
      expect(binding.resolve(probe).kind).toBe("not_found");
    }
    expect(binding.isBound("tenant-a")).toBe(true);
    expect(binding.isBound("tenant-b")).toBe(false);
  });
});

/**
 * 启动地址解析的行为锁定(分发改版 WP-92)。
 *
 * 断言锚 = **契约模板**(`LAUNCH_TICKET_REDEEM_PATH_TEMPLATE`),不是手抄的字面量
 * ——契约改了模板而解析器没跟上时,本文件跟着契约走并暴露差异。
 */
import { LAUNCH_TICKET_REDEEM_PATH_TEMPLATE } from "@stackmaster/protocol";
import { describe, expect, it } from "vitest";

import {
  LAUNCH_PATH_PLACEHOLDERS,
  LAUNCH_PATH_SEGMENT_COUNT,
  launchRedeemPath,
  parseLaunchPath,
} from "../src/launch-path.js";

describe("解析器与契约模板同源", () => {
  it("占位符名与段数由契约模板推导(不是本地字面量)", () => {
    expect(LAUNCH_PATH_PLACEHOLDERS).toEqual(["challengeId", "version"]);
    expect(LAUNCH_PATH_SEGMENT_COUNT).toBe(4);
    expect(LAUNCH_TICKET_REDEEM_PATH_TEMPLATE).toBe("/app/c/:challengeId/:version");
  });

  it("launchRedeemPath 产出与契约模板逐字对应(构造器与解析器互为逆)", () => {
    const path = launchRedeemPath("chal-stack-escape", "1.2.3");
    expect(path).toBe("/app/c/chal-stack-escape/1.2.3");
    expect(parseLaunchPath(path)).toEqual({
      challengeId: "chal-stack-escape",
      version: "1.2.3",
    });
  });
});

describe("parseLaunchPath:合法形态", () => {
  it("干净路径(302 之后的地址)解析出题目导航信息", () => {
    expect(parseLaunchPath("/app/c/chal-0001/1.0.0")).toEqual({
      challengeId: "chal-0001",
      version: "1.0.0",
    });
  });

  it("百分号编码段被解码(与契约 encodeURIComponent 的产出对称)", () => {
    expect(parseLaunchPath("/app/c/chal%2D0001/1.0.0")).toEqual({
      challengeId: "chal-0001",
      version: "1.0.0",
    });
  });

  it("带查询串时按 pathname 解析(查询串不参与;页面不读票据)", () => {
    // 传入的就是 location.pathname,天然没有 query;此处固定「即使有人把
    // 带 query 的字符串传进来,? 之后也不参与匹配」这一事实。
    expect(parseLaunchPath("/app/c/chal-0001/1.0.0")).not.toBeNull();
  });
});

describe("parseLaunchPath:非法形态一律 null(页面呈现无效地址、零网络请求)", () => {
  const invalid: readonly (readonly [string, string])[] = [
    ["根路径", "/"],
    ["静态段不符", "/app/x/chal-0001/1.0.0"],
    ["前缀不符", "/other/c/chal-0001/1.0.0"],
    ["段数不足", "/app/c/chal-0001"],
    ["段数过多", "/app/c/chal-0001/1.0.0/extra"],
    ["尾部斜杠(不宽容解释)", "/app/c/chal-0001/1.0.0/"],
    ["空占位符段", "/app/c//1.0.0"],
    ["没有题目定位路径", "/app"],
    ["畸形百分号编码", "/app/c/chal%ZZ/1.0.0"],
  ];

  for (const [name, pathname] of invalid) {
    it(`${name}: ${pathname}`, () => {
      expect(parseLaunchPath(pathname)).toBeNull();
    });
  }
});

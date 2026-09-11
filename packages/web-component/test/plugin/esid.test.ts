import { describe, expect, it } from "vitest";

import { readEmbedSessionIdFromFragment } from "../../src/plugin/esid.js";

describe("esid fragment 一次性读取(嵌入协议 §4.1 插件侧行为要点)", () => {
  it("从 #esid= 形态提取并返回校验后的 esid", () => {
    const esid = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
    expect(readEmbedSessionIdFromFragment(`#esid=${esid}`)).toBe(esid);
  });

  it("接受跟随其他参数的 &esid= 形态", () => {
    const esid = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
    expect(readEmbedSessionIdFromFragment(`#a=1&esid=${esid}`)).toBe(esid);
  });

  it("fragment 缺失 / 空串 → null(降级路径,零请求)", () => {
    expect(readEmbedSessionIdFromFragment(null)).toBeNull();
    expect(readEmbedSessionIdFromFragment("")).toBeNull();
  });

  it("fragment 非 esid 形态 → null", () => {
    expect(readEmbedSessionIdFromFragment("#section-anchor")).toBeNull();
    expect(readEmbedSessionIdFromFragment("#esid=")).toBeNull();
    expect(readEmbedSessionIdFromFragment("#esid=short")).toBeNull();
  });

  it("esid 形态不符(字符集 / 熵下限)→ null,与缺失同路径降级", () => {
    // 22 字符但含非法字符(`$`)→ Schema 拒绝。
    expect(readEmbedSessionIdFromFragment("#esid=ABCDEFGHIJKLMNOPQRSTUVWXYZ$bcdef")).toBeNull();
    // 低于熵下限(21 字符)。
    expect(readEmbedSessionIdFromFragment("#esid=ABCDEFGHIJKLMNOPQRSTU")).toBeNull();
  });
});

/**
 * EmbedMessage 契约测试(WP-5 完成标准:消息信封有 schema,校验规则逐条可测)。
 *
 * 样例来自 test/fixtures/embed-message/,同样作为 WP-6 golden fixture 的增量
 * 来源;非法样例与 docs/contracts/嵌入协议.md §五 的校验规则编号一一对应:
 * 未知消息类型(V-4)、错误协议版本(V-3)、缺失会话 ID(V-5)、序号非正整数(V-7 结构面)、
 * 未知信封字段(含伪造成绩 / 成功标志的篡改形态,V-9 的契约表达)、payload 未知字段、
 * 版本候选集为空 / 非整数、未知能力、能力超上限、配置缺 theme、语言标签非法 / 超长、
 * 高度越界 / 非整数、type 与 payload 不匹配、标识符字符集违规、缺 payload、主题非法。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ZodLiteral } from "zod";
import {
  EMBED_CAPABILITIES,
  EMBED_HOST_TO_PLUGIN_TYPES,
  EMBED_MESSAGE_TYPES,
  EMBED_PLUGIN_TO_HOST_TYPES,
  EMBED_PROTOCOL_VERSION,
  EmbedMessageSchema,
  MAX_EMBED_CAPABILITIES,
} from "../src/index.js";
import type { EmbedMessageType } from "../src/index.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "embed-message");

interface FixtureCase {
  readonly name: string;
  readonly payload: unknown;
}

function loadFixtures(kind: "valid" | "invalid"): readonly FixtureCase[] {
  const dir = join(FIXTURE_DIR, kind);
  return readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => ({
      name: fileName,
      payload: JSON.parse(readFileSync(join(dir, fileName), "utf8")) as unknown,
    }));
}

describe("EmbedMessage 契约(WP-5)", () => {
  it.each(loadFixtures("valid"))("接受典型样例 $name", ({ payload }) => {
    const result = EmbedMessageSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it.each(loadFixtures("invalid"))("拒绝非法样例 $name", ({ payload }) => {
    const result = EmbedMessageSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it("消息判别联合恰好覆盖 5 种冻结消息类型", () => {
    expect(EmbedMessageSchema.options).toHaveLength(EMBED_MESSAGE_TYPES.length);
    const unionTypes = EmbedMessageSchema.options.map(
      (option) => (option.shape.type as ZodLiteral<EmbedMessageType>).value,
    );
    expect([...unionTypes].sort()).toEqual([...EMBED_MESSAGE_TYPES].sort());
  });

  it("合法样例两两消息类型不同,合计覆盖全部 5 种消息", () => {
    const coveredTypes = loadFixtures("valid").map(
      (fixture) => EmbedMessageSchema.parse(fixture.payload).type,
    );
    expect(new Set(coveredTypes).size).toBe(EMBED_MESSAGE_TYPES.length);
  });

  it("方向划分互斥且完备(接收端方向检查的前提,规则 V-6)", () => {
    const pluginToHost = new Set<EmbedMessageType>(EMBED_PLUGIN_TO_HOST_TYPES);
    const hostToPlugin = new Set<EmbedMessageType>(EMBED_HOST_TO_PLUGIN_TYPES);
    for (const type of pluginToHost) {
      expect(hostToPlugin.has(type)).toBe(false);
    }
    expect(new Set([...pluginToHost, ...hostToPlugin]).size).toBe(EMBED_MESSAGE_TYPES.length);
  });

  it("能力枚举基数与数组上限一致(MAX_EMBED_CAPABILITIES 不超枚举)", () => {
    expect(MAX_EMBED_CAPABILITIES).toBe(EMBED_CAPABILITIES.length);
  });

  it("嵌入协议当前版本为 1(hello 支持集与信封字面量均含之)", () => {
    expect(EMBED_PROTOCOL_VERSION).toBe(1);
  });
});

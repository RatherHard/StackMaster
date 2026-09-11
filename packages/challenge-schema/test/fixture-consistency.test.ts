/**
 * 夹具 ↔ 公开 Schema 形态一致性断言(阶段五 WP-54;阶段六风险表「M2 通道与
 * 夹具漂移」行的对齐锚 = 公开 Schema,阶段四定案延续;任务分解 WP-54 完成
 * 标准「夹具与正式数据形态一致性断言绿」)。
 *
 * 三份语料对**同一公开 Schema 校验器**(`validatePublicDescriptor`)同绿:
 *  1. 本包 `test/fixtures/public-descriptor/basic.json` —— 既有绿灯基线
 *     (public-descriptor.test.ts 维护);
 *  2. `apps/plugin-dev/fixtures/dev-descriptor.json` —— 开发壳夹具通道语料
 *     (WP-F8 起为形态自检测试锚);
 *  3. `apps/plugin-dev/e2e/fixtures/formal-descriptor.json` —— E2E 正式下发
 *     通道登记语料(descriptor 端点实际下发内容的前身;每用例唯一
 *     challengeId 由 seed 侧覆写,不影响形态)。
 *
 * 落点登记:challenge-schema 是 Node 侧叶子包(浏览器包禁 import),故本断言
 * 以 Node 测试**读文件系统**跨包校验语料(零依赖边;插件侧运行时形态对齐另
 * 由 vm-ui 加载器的轻量结构检查 + 测试锚承接,两面对同一 Schema)。
 *
 * 附红灯反例:任一语料定向破坏(未知顶层字段 / debugMode 非布尔)即被同一
 * 校验器拒绝——证明断言可咬合(漂移必红灯)。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parsePublicDescriptorText } from "../src/index.js";

/** 跨包语料解析(cwd 兼容:包根直跑 / 仓库根聚合跑),不存在即报错。 */
function resolveAcrossRepo(relativeFromRoot: string): string {
  const candidates = [
    join(process.cwd(), relativeFromRoot),
    join(process.cwd(), "..", "..", relativeFromRoot),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(`语料不存在:${relativeFromRoot}(尝试过:${candidates.join(" ; ")})`);
  }
  return found;
}

const BASIC_PATH = join(import.meta.dirname, "fixtures", "public-descriptor", "basic.json");
const FIXTURE_PATH = resolveAcrossRepo(join("apps", "plugin-dev", "fixtures", "dev-descriptor.json"));
const FORMAL_PATH = resolveAcrossRepo(
  join("apps", "plugin-dev", "e2e", "fixtures", "formal-descriptor.json"),
);

/** 语料清单(路径 + 角色;一致性断言的数据面)。 */
const CORPORA = [
  { role: "schema 绿灯基线", path: BASIC_PATH },
  { role: "plugin-dev 夹具通道", path: FIXTURE_PATH },
  { role: "E2E 正式下发通道", path: FORMAL_PATH },
] as const;

describe("夹具 ↔ 公开 Schema 形态一致性(WP-54)", () => {
  it.each(CORPORA)("$role:对同一公开 Schema 校验同绿($path)", ({ path }) => {
    const result = parsePublicDescriptorText(readFileSync(path, "utf8"));
    expect(result.ok).toBe(true);
  });

  it("夹具与正式通道语料的 ED 教学面齐备( hintLadder / publicErrorMapping / debugMode=true)", () => {
    for (const path of [FIXTURE_PATH, FORMAL_PATH]) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(parsed["debugMode"]).toBe(true);
      expect((parsed["hintLadder"] as unknown[]).length).toBeGreaterThanOrEqual(1);
      expect((parsed["publicErrorMapping"] as unknown[]).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("红灯反例:定向破坏被同一校验器拒绝(断言可咬合,漂移必红灯)", () => {
    for (const { path } of CORPORA) {
      const clone = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      // 未知顶层字段(公开 Schema additionalProperties: false;I-1)。
      clone["secrets"] = { flag: "FLAG{drift}" };
      expect(parsePublicDescriptorText(JSON.stringify(clone)).ok).toBe(false);
      // debugMode 非布尔(布尔字段漂移形态)。
      const clone2 = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      clone2["debugMode"] = "true";
      expect(parsePublicDescriptorText(JSON.stringify(clone2)).ok).toBe(false);
    }
  });
});

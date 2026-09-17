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
/** M10/WP-80 出题者积木声明面黄金样例(与 basic 同一 Schema,同一目录)。 */
const AUTHOR_BLOCKS_PATH = join(
  import.meta.dirname,
  "fixtures",
  "public-descriptor",
  "author-blocks.json",
);
const AUTHOR_BLOCKS_MINIMAL_PATH = join(
  import.meta.dirname,
  "fixtures",
  "public-descriptor",
  "author-blocks-minimal.json",
);
const FIXTURE_PATH = resolveAcrossRepo(join("apps", "plugin-dev", "fixtures", "dev-descriptor.json"));
const FORMAL_PATH = resolveAcrossRepo(
  join("apps", "plugin-dev", "e2e", "fixtures", "formal-descriptor.json"),
);

/** 语料清单(路径 + 角色;一致性断言的数据面)。 */
const CORPORA = [
  { role: "schema 绿灯基线", path: BASIC_PATH },
  { role: "M10 出题者积木声明面", path: AUTHOR_BLOCKS_PATH },
  { role: "M10 出题者积木下界形态", path: AUTHOR_BLOCKS_MINIMAL_PATH },
  { role: "plugin-dev 夹具通道", path: FIXTURE_PATH },
  { role: "E2E 正式下发通道", path: FORMAL_PATH },
] as const;

/** 必修红线语料(断言可咬合;每条 = 定向破坏 + 期望拒绝)。 */
const DRIFT_EDITS: ReadonlyArray<{
  readonly role: string;
  readonly edit: (clone: Record<string, unknown>) => void;
}> = [
  {
    role: "未知顶层字段(additionalProperties: false;I-1)",
    edit: (clone) => {
      clone["secrets"] = { flag: "FLAG{drift}" };
    },
  },
  {
    role: "布尔字段类型漂移(debugMode 非布尔)",
    edit: (clone) => {
      clone["debugMode"] = "true";
    },
  },
  {
    role: "M10 authorBlocks 类型漂移(数组 → 对象)",
    edit: (clone) => {
      clone["authorBlocks"] = { id: "drift" };
    },
  },
  {
    role: "M10 authorBlocks 动作 type 漂移(非 12 公开动作)",
    edit: (clone) => {
      clone["authorBlocks"] = [
        { id: "drift", displayText: "漂移", interfaceId: 512, slots: [], actions: [{ type: "loop_forever", args: {} }] },
      ];
    },
  },
  {
    role: "M10 参数位取值类型漂移(槽位引用 → 数字)",
    edit: (clone) => {
      clone["authorBlocks"] = [
        {
          id: "drift",
          displayText: "漂移",
          interfaceId: 512,
          slots: [{ key: "target", label: "目标地址", kind: "address" }],
          actions: [{ type: "write_bytes", args: { addressHex: 4096, bytesHex: "41" } }],
        },
      ];
    },
  },
];

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
      for (const drift of DRIFT_EDITS) {
        const clone = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
        drift.edit(clone);
        expect(
          parsePublicDescriptorText(JSON.stringify(clone)).ok,
          `${path} × ${drift.role}`,
        ).toBe(false);
      }
    }
  });

  it("M10 声明面只在显式声明的语料上出现(既有语料零新增字段)", () => {
    for (const path of [BASIC_PATH, FIXTURE_PATH, FORMAL_PATH]) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(parsed["authorBlocks"], `${path} 不应携带 authorBlocks`).toBeUndefined();
    }
    const declared = JSON.parse(readFileSync(AUTHOR_BLOCKS_PATH, "utf8")) as Record<string, unknown>;
    expect(Array.isArray(declared["authorBlocks"])).toBe(true);
  });
});

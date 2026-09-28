/**
 * 夹具 ↔ 公开 Schema 形态一致性断言(阶段五 WP-54;阶段六风险表「M2 通道与
 * 夹具漂移」行的对齐锚 = 公开 Schema,阶段四定案延续;任务分解 WP-54 完成
 * 标准「夹具与正式数据形态一致性断言绿」)。
 *
 * 四份语料对**同一公开 Schema 校验器**(`validatePublicDescriptor`)同绿:
 *  1. 本包 `test/fixtures/public-descriptor/basic.json` —— 既有绿灯基线
 *     (IR 模式 / 64 位 / code + stack 双区;public-descriptor.test.ts 维护);
 *  2. `test/fixtures/public-descriptor/author-blocks.json` —— M10 出题者积木
 *     声明面(含 authorBlocks);
 *  3. `test/fixtures/public-descriptor/author-blocks-minimal.json` —— 同一字段的
 *     下界形态(单模板 / 零槽位);
 *  4. `test/fixtures/public-descriptor/byte-mode-32bit.json` —— **字节模式
 *     (encodingTable)+ archBits 32 + heap 区域 + canary 关闭 + 12 动作全量**;
 *     承接已退场语料的形态维度(见下「沿革」)。
 *
 * **沿革(2026-09-19,WP-96 物理删除退役面)**:本断言原以**跨包文件语料**取证
 * 「两条独立生产者通道对同一 Schema 同绿」——`apps/plugin-dev/fixtures/
 * dev-descriptor.json`(开发壳夹具通道)与 `apps/plugin-dev/e2e/fixtures/
 * formal-descriptor.json`(E2E 正式下发通道)。二者随 `apps/plugin-dev` **物理删除
 * 而退场**(该应用与其夹具目录已不在磁盘上)。处置 = **删除这两个语料项**,
 * 不以改指向 / `existsSync` 跳过把「语料消失」伪装成通过;其**形态维度**由本包内
 * 新增语料 `byte-mode-32bit.json` 承接(优先在 `test/fixtures/**` 内自建等价公开包
 * 样例)。**失去的一维覆盖**:「跨包读取另一 workspace 包生产者产物」这一
 * **取证路径**——该维度随那两条通道一同退场,当今生产侧唯一公开描述包来源 =
 * session-api 的 descriptor 端点(无磁盘夹具),故本包内无法重建等价取证路径
 * (详见 WP-96-D 报告「测试残留处置表」)。
 *
 * 落点登记:challenge-schema 是 Node 侧叶子包(浏览器包禁 import),故本断言
 * 以 Node 测试**读文件系统**校验语料(零依赖边;插件侧运行时形态对齐另
 * 由 vm-ui 加载器的轻量结构检查 + 测试锚承接,两面对同一 Schema)。
 *
 * 附红灯反例:任一语料定向破坏(未知顶层字段 / debugMode 非布尔)即被同一
 * 校验器拒绝——证明断言可咬合(漂移必红灯)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parsePublicDescriptorText } from "../src/index.js";

// 沿革:原 `resolveAcrossRepo()` 跨包定位助手随两个跨包语料一同退场
// (它只服务那两条已删通道;保留一个无人调用的助手既过不了 noUnusedLocals,
// 也会让人误以为跨包取证仍在生效)。将来若有**活在磁盘上**的 app 侧描述包
// 夹具落地,再按需重建该助手 —— **不得**用 `existsSync` 跳过冒充通过。

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
/**
 * 字节模式 / 32 位形态语料(承接已删 `formal-descriptor.json` 的形态维度:
 * encodingTable + archBits 32 + heap 区域 + canary 关闭 + 12 动作全量)。
 */
const BYTE_MODE_32BIT_PATH = join(
  import.meta.dirname,
  "fixtures",
  "public-descriptor",
  "byte-mode-32bit.json",
);

/** 语料清单(路径 + 角色;一致性断言的数据面)。 */
const CORPORA = [
  { role: "schema 绿灯基线", path: BASIC_PATH },
  { role: "M10 出题者积木声明面", path: AUTHOR_BLOCKS_PATH },
  { role: "M10 出题者积木下界形态", path: AUTHOR_BLOCKS_MINIMAL_PATH },
  { role: "字节模式 / 32 位形态", path: BYTE_MODE_32BIT_PATH },
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

  it("语料的 ED 教学面齐备(hintLadder / publicErrorMapping / debugMode=true)", () => {
    // 沿革:原断言面 = [开发壳夹具通道语料, E2E 正式下发通道语料](两者均已随
    // apps/plugin-dev 物理删除)。该维度(**完整 ED 教学面**)**原样保留**,
    // 改由仍在磁盘上的两份全量语料承担(下界形态语料 hintLadder /
    // publicErrorMapping 为空数组,故不在本断言面内 —— 这是既有的口径,非本次放宽)。
    for (const path of [BASIC_PATH, AUTHOR_BLOCKS_PATH, BYTE_MODE_32BIT_PATH]) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(parsed["debugMode"], `${path} 的 debugMode`).toBe(true);
      expect(
        (parsed["hintLadder"] as unknown[]).length,
        `${path} 的 hintLadder 条数`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        (parsed["publicErrorMapping"] as unknown[]).length,
        `${path} 的 publicErrorMapping 条数`,
      ).toBeGreaterThanOrEqual(1);
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
    for (const path of [BASIC_PATH, BYTE_MODE_32BIT_PATH]) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(parsed["authorBlocks"], `${path} 不应携带 authorBlocks`).toBeUndefined();
    }
    const declared = JSON.parse(readFileSync(AUTHOR_BLOCKS_PATH, "utf8")) as Record<string, unknown>;
    expect(Array.isArray(declared["authorBlocks"])).toBe(true);
  });
});

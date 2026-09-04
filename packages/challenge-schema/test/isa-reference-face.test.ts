/**
 * 整改清单 R1 / R2:公开 ISA 引用面(裁决见 checker/index.ts 记录)。
 *
 * 公开包 encodingTable[].op 的自定义助记符与 operands[].interfaceId 是
 * 经裁决的公开 ISA 引用:揭示"存在哪些指令 / 接口及其公开标识";本文件
 * 以扫描测试证明公开包无法反推私有声明面的任何语义内容(微算子、效果
 * 序列、displayText、fileId、FLAG 名、秘密值),且未声明引用被拒绝
 * ——隐藏声明不产生存在性信号。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validatePublicDescriptor } from "../src/index.js";
import type { PublicChallengeDescriptor } from "../src/index.js";
import { checkChallengePair } from "../src/server-only/index.js";
import type { PrivateChallengeBundle } from "../src/server-only/index.js";
import { buildPrivateBundle } from "./helpers/private-bundle.js";
import { scanStringValues } from "../src/server-only/checker/deep-scan.js";

const basicText = readFileSync(
  join(import.meta.dirname, "fixtures", "public-descriptor", "basic.json"),
  "utf8",
);

/** 私有声明面哨兵:公开包不得以任何形态携带这些值。 */
const DISPLAY_SENTINEL = "R7 私有展示文本哨兵";
const MICRO_VALUE_HEX = "0xdead1111beef2222";
const FILE_ID = "win-notes";
const FILE_CONTENT_SENTINEL = "r1 私有虚拟文件内容哨兵";
const FLAG_REGISTER = "FLAG_DIAG";

/** 构造带自定义指令 + 作者接口引用的字节模式公开包(R1/R2 承载面)。 */
function loadByteDescriptorWithAuthorSurface(): PublicChallengeDescriptor {
  const descriptor = JSON.parse(basicText) as Record<string, unknown>;
  const profile = descriptor.vmProfile as Record<string, unknown>;
  profile.encodingTable = [
    { tokenHex: "0x00", op: "ret", operands: [] },
    { tokenHex: "0xe1", op: "FROB", operands: [] },
    { tokenHex: "0xcd", op: "call", operands: [{ kind: "interface", interfaceId: 512 }] },
    {
      tokenHex: "0xf1",
      op: "syscall",
      operands: [{ kind: "immediate", width: "arch" }],
    },
  ];
  const projection = descriptor.initialProjection as {
    visibleRegions: Array<Record<string, unknown>>;
  };
  const codeProjection = projection.visibleRegions.find((region) => region.regionId === "code");
  if (codeProjection === undefined) {
    throw new Error("字节模式 fixture 缺少公开代码投影");
  }
  // E1 FROB → CD call interface → F1 syscall(内联 8 字节派发号 0x200):
  // bytesHex 只是公开前缀(≤ 256 字节),其余代码字节由 builder 以 00 填充;
  // 00 = ret token,前 11 字节译码 3 条,尾部 4085 条 ret,合计 4088 条
  // (低于 MAX_IR_INSTRUCTIONS 上界,绿灯;私有 contentHex 经 XS-PROJ-VALUES
  // 前缀镜像自动成立)。
  codeProjection.bytesHex = `e1cdf1${"0002000000000000"}`;
  const result = validatePublicDescriptor(descriptor);
  if (!result.ok) {
    throw new Error(`字节模式 fixture 应通过校验:${JSON.stringify(result.violations, null, 2)}`);
  }
  return result.value;
}

function buildAuthorPrivateBundle(base: PublicChallengeDescriptor): PrivateChallengeBundle {
  return buildPrivateBundle(base, (bundle) => {
    // builder 入参为只读镜像类型;测试内定向装配走可变视图
    // (与 checker.test 的 JSON 克隆编辑同纪律,不触达调用方对象)。
    const mutable = bundle as {
      customInstructions?: unknown;
      interfaces?: unknown;
      secrets: unknown;
    };
    mutable.customInstructions = [
      {
        mnemonic: "FROB",
        displayText: DISPLAY_SENTINEL,
        semantics: [
          { op: "load_imm", dst: "RAX", valueHex: MICRO_VALUE_HEX },
          { op: "bit_mask", dst: "RAX", src: "RAX", maskHex: "0xFF", logic: "and" },
        ],
      },
    ];
    mutable.interfaces = [
      {
        interfaceId: 512,
        displayText: "授予解题笔记读取权",
        effects: [
          { effect: "grant_virtual_file", fileId: FILE_ID },
          { effect: "set_flag", flagRegister: FLAG_REGISTER, valueHex: "0x1" },
        ],
      },
    ];
    mutable.secrets = {
      flag: "FLAG{r1_secret_content_sentinel}",
      virtualFiles: [{ fileId: FILE_ID, content: FILE_CONTENT_SENTINEL }],
    };
  });
}

describe("R1/R2:公开 ISA 引用面绿灯基线", () => {
  it("自定义助记符与接口号全链路声明一致时双包零违规", () => {
    const base = loadByteDescriptorWithAuthorSurface();
    const result = checkChallengePair(base, buildAuthorPrivateBundle(base));

    expect(result.ok).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

describe("R1/R2:公开包扫描(私有声明面零泄漏)", () => {
  it("公开包不含微算子语义、效果细节、displayText、fileId、FLAG 名与秘密内容", () => {
    const base = loadByteDescriptorWithAuthorSurface();
    const privateBundle = buildAuthorPrivateBundle(base);
    const pairResult = checkChallengePair(base, privateBundle);
    expect(pairResult.ok).toBe(true);

    const publicStrings: Array<{ text: string; path: string }> = [];
    scanStringValues(base, (text, path) => publicStrings.push({ text, path }));

    const forbiddenSubstrings = [
      // 微算子封闭集词汇与语义常量
      "load_imm",
      "mov_reg",
      "store_mem",
      "set_flag",
      "bit_mask",
      MICRO_VALUE_HEX.slice(2), // 语义常量值(去 0x 前缀防大小写表述差异)
      // 私有展示文本与虚拟文件
      DISPLAY_SENTINEL,
      FILE_CONTENT_SENTINEL,
      "FLAG{r1_secret_content_sentinel}",
      "grant_virtual_file",
      "virtual_file_read",
      // FLAG 汇寄存器名(仅 flagRegisterNames 声明的 FLAG0 允许出现)
      FLAG_REGISTER,
    ];
    for (const item of publicStrings) {
      for (const forbidden of forbiddenSubstrings) {
        expect(
          item.text.includes(forbidden),
          `公开包 ${item.path} 泄露私有面内容:${forbidden}`,
        ).toBe(false);
      }
    }
    // fileId 是私有引用 ID:XS-ID-NO-PRIVATE 同锚,此处结构性复核。
    expect(publicStrings.some((item) => item.text === FILE_ID)).toBe(false);
  });

  it("公开包按裁决携带公开 ISA 引用标识(助记符与接口号)", () => {
    const base = loadByteDescriptorWithAuthorSurface();
    const texts: string[] = [];
    scanStringValues(base, (text) => texts.push(text));

    expect(texts).toContain("FROB");
    expect(JSON.stringify(base)).toContain("512");
  });
});

describe("R1/R2:未声明引用拒绝(隐藏声明不产生存在性信号)", () => {
  it("编码表引用未声明接口号被拒绝(XS-ENC-TOKEN,R2)", () => {
    const base = loadByteDescriptorWithAuthorSurface();
    const privateBundle = buildAuthorPrivateBundle(base);
    const publicClone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    const table = (publicClone.vmProfile as { encodingTable: Array<Record<string, unknown>> })
      .encodingTable;
    const callEntry = table.find((entry) => entry.op === "call");
    if (callEntry === undefined) {
      throw new Error("测试破坏点缺失:call 条目");
    }
    callEntry.operands = [{ kind: "interface", interfaceId: 999 }];
    const privateClone = JSON.parse(JSON.stringify(privateBundle)) as Record<string, unknown>;

    const result = checkChallengePair(
      publicClone as unknown as PublicChallengeDescriptor,
      privateClone as unknown as PrivateChallengeBundle,
    );

    const violation = result.violations.find(
      (candidate) => candidate.ruleId === "XS-ENC-TOKEN" && candidate.message.includes("999"),
    );
    expect(violation).toBeDefined();
    expect(violation?.path).toBe("/vmProfile/encodingTable/2/operands/0/interfaceId");
  });

  it("公开编码表引用未声明助记符被拒绝(XS-ENC-TOKEN,R1 复核)", () => {
    const base = loadByteDescriptorWithAuthorSurface();
    const publicClone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    const table = (publicClone.vmProfile as { encodingTable: Array<Record<string, unknown>> })
      .encodingTable;
    const frobEntry = table.find((entry) => entry.op === "FROB");
    if (frobEntry === undefined) {
      throw new Error("测试破坏点缺失:FROB 条目");
    }
    frobEntry.op = "GHOST_OP";
    const privateClone = JSON.parse(
      JSON.stringify(buildAuthorPrivateBundle(base)),
    ) as Record<string, unknown>;

    const result = checkChallengePair(
      publicClone as unknown as PublicChallengeDescriptor,
      privateClone as unknown as PrivateChallengeBundle,
    );

    const violation = result.violations.find(
      (candidate) =>
        candidate.ruleId === "XS-ENC-TOKEN" && candidate.message.includes("GHOST_OP"),
    );
    expect(violation).toBeDefined();
    expect(violation?.path).toBe("/vmProfile/encodingTable/1/op");
  });
});

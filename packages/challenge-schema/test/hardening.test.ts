/**
 * 整改清单 R5 / R6 / R7 加固测试:
 * - R5:seedPolicy 策略与固定 seed 互斥——Schema if/then/else 与检查器
 *   XS-SEED-POLICY 两层;
 * - R6:Ajv ownProperties(自有属性校验)与原型污染形态拒绝;
 * - R7:错误两层模型——违规消息(内部诊断层)不含秘密值哨兵,
 *   PUBLIC_FACING_ERROR_CODE_FOR_VIOLATIONS 锚定协议错误码词汇。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validatePublicDescriptor } from "../src/index.js";
import type { PublicChallengeDescriptor } from "../src/index.js";
import {
  checkChallengePair,
  PUBLIC_FACING_ERROR_CODE_FOR_VIOLATIONS,
  validatePrivateBundle,
} from "../src/server-only/index.js";
import type { PrivateChallengeBundle } from "../src/server-only/index.js";
import type { CheckerResult, CheckerViolation } from "../src/server-only/index.js";
import { buildPrivateBundle } from "./helpers/private-bundle.js";

const basicText = readFileSync(
  join(import.meta.dirname, "fixtures", "public-descriptor", "basic.json"),
  "utf8",
);

/** R7 哨兵:秘密值在测试夹具中放置的独特标记,泄漏扫描断言其不出现在错误面。 */
const FLAG_SENTINEL = "FLAG{r7_s3nt1nel_do_not_leak}";
const SEED_SENTINEL = "7e1fd00d5eedc0de1a2b3c4d5e6f7081";
const FILE_CONTENT_SENTINEL = "r7 virtual file content sentinel // 判题面内容哨兵";

function loadPublicDescriptor(): PublicChallengeDescriptor {
  const result = validatePublicDescriptor(JSON.parse(basicText));
  if (!result.ok) {
    throw new Error(`fixture 应通过校验:${JSON.stringify(result.violations, null, 2)}`);
  }
  return result.value;
}

type PairEdit = (clone: Record<string, unknown>) => void;

function checkPairWith(editPrivate?: PairEdit): CheckerResult {
  const base = loadPublicDescriptor();
  const privateClone = JSON.parse(
    JSON.stringify(buildPrivateBundle(base)),
  ) as Record<string, unknown>;
  editPrivate?.(privateClone);
  return checkChallengePair(base, privateClone as unknown as PrivateChallengeBundle);
}

function expectRule(result: CheckerResult, ruleId: string): CheckerViolation {
  const violation = result.violations.find((candidate) => candidate.ruleId === ruleId);
  if (violation === undefined) {
    throw new Error(`预期违规 ${ruleId},实际:${JSON.stringify(result.violations, null, 2)}`);
  }
  return violation;
}

describe("R5:seed 策略与固定 seed 互斥(Schema 层 if/then/else)", () => {
  function validateSeedPolicy(strategy: string, withSeed: boolean) {
    const base = loadPublicDescriptor();
    const bundle = buildPrivateBundle(base);
    const mutated = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
    const seedPolicy: Record<string, unknown> = { strategy };
    if (withSeed) {
      seedPolicy.seedHex = SEED_SENTINEL;
    }
    mutated.seedPolicy = seedPolicy;
    return validatePrivateBundle(mutated);
  }

  it("fixed + seedHex 通过(可回放前提成立)", () => {
    const result = validateSeedPolicy("fixed", true);
    expect(result.ok).toBe(true);
  });

  it("fixed 缺 seedHex 被拒绝(then:seedHex 必填)", () => {
    const result = validateSeedPolicy("fixed", false);
    expect(result.ok).toBe(false);
  });

  it("server_random_per_session 携带 seedHex 被拒绝(else:seedHex 禁止,R5)", () => {
    const result = validateSeedPolicy("server_random_per_session", true);
    expect(result.ok).toBe(false);
  });

  it("server_random_per_session 不带 seedHex 通过(会话随机策略合法形态)", () => {
    const result = validateSeedPolicy("server_random_per_session", false);
    expect(result.ok).toBe(true);
  });
});

describe("R5:XS-SEED-POLICY 检查器纵深防御(绕过 Schema 直测)", () => {
  it("server_random_per_session 携带固定 seedHex 被拒绝", () => {
    const result = checkPairWith((priv) => {
      priv.seedPolicy = { strategy: "server_random_per_session", seedHex: SEED_SENTINEL };
    });

    const violation = expectRule(result, "XS-SEED-POLICY");
    expect(violation.path).toBe("/seedPolicy/seedHex");
    expect(violation.message).toContain("互斥");
  });

  it("fixed 缺 seedHex 被拒绝", () => {
    const result = checkPairWith((priv) => {
      priv.seedPolicy = { strategy: "fixed" };
    });

    const violation = expectRule(result, "XS-SEED-POLICY");
    expect(violation.message).toContain("seedHex");
  });

  it("两种正确策略组合均保持绿灯", () => {
    const fixed = checkPairWith((priv) => {
      priv.seedPolicy = { strategy: "fixed", seedHex: SEED_SENTINEL };
    });
    const random = checkPairWith((priv) => {
      priv.seedPolicy = { strategy: "server_random_per_session" };
    });

    expect(fixed.ok).toBe(true);
    expect(random.ok).toBe(true);
  });
});

describe("R6:Ajv ownProperties 与原型污染防御", () => {
  it("required 字段被原型继承属性满足时仍被拒绝(ownProperties: true)", () => {
    // 完整合法公开包放在原型上,自有属性为空对象:若未启用 ownProperties,
    // required 检查会沿原型链命中全部必填字段而误放行。
    const validDescriptor = JSON.parse(basicText) as Record<string, unknown>;
    const prototypeOnly = Object.create(validDescriptor) as Record<string, unknown>;

    const result = validatePublicDescriptor(prototypeOnly);
    expect(result.ok).toBe(false);
  });

  it("__proto__ 键形态被拒绝且不产生原型污染", () => {
    const polluted = basicText.replace(
      "{",
      `{ "__proto__": {"polluted": true}, "injected": true,`,
    );
    const parsed: unknown = JSON.parse(polluted);

    // JSON.parse 以 DefineOwnProperty 语义创建自有 __proto__ 属性:
    // additionalProperties(unknown 属性)必须在 Schema 层拒绝。
    const result = validatePublicDescriptor(parsed);
    expect(result.ok).toBe(false);

    // 原型未被污染:新对象的 Object.prototype 上不存在 polluted 键。
    expect(Object.getOwnPropertyDescriptor(Object.prototype, "polluted")).toBeUndefined();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("constructor / prototype 键形态被拒绝(未知属性)", () => {
    const base = JSON.parse(basicText) as Record<string, unknown>;
    base["constructor"] = { "prototype": {} };
    base["prototype"] = true;

    const result = validatePublicDescriptor(base);
    expect(result.ok).toBe(false);
  });

  it("寄存器映射中 __proto__ 键名被 propertyNames 模式拒绝", () => {
    const base = loadPublicDescriptor();
    const bundle = buildPrivateBundle(base);
    const mutated = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
    const registers = mutated.initialState as { registers: Record<string, string> };
    // JSON 文本路径才能产生自有 __proto__ 键;此处经 parse 往返构造同形输入。
    const roundTripped = JSON.parse(
      JSON.stringify(registers).replace("{", `{ "__proto__": "0x0",`),
    ) as Record<string, string>;
    mutated.initialState = {
      ...(mutated.initialState as Record<string, unknown>),
      registers: roundTripped,
    };

    const result = validatePrivateBundle(mutated);
    expect(result.ok).toBe(false);
  });

  it("违规消息不回显超长恶意属性名(错误粗化,R7 配套)", () => {
    const base = JSON.parse(basicText) as Record<string, unknown>;
    const maliciousName = "恶意".repeat(500);
    base[maliciousName] = true;

    const result = validatePublicDescriptor(base);
    if (result.ok) {
      throw new Error("预期校验失败,实际通过");
    }
    const echoed = result.violations.some((violation) => violation.message.includes(maliciousName));
    expect(echoed).toBe(false);
  });
});

describe("R7:错误消息两层模型(内部诊断层泄漏扫描)", () => {
  it("违规消息与路径不含隐藏 flag、seed、虚拟文件内容等秘密值哨兵", () => {
    // 多场景触发跨规则违规,汇总后扫描:内部诊断层允许私有 ID 上下文,
    // 但秘密值(flag 内容 / seedHex / 虚拟文件内容)任何情况下不得出现。
    const scenarios: CheckerResult[] = [
      checkPairWith((priv) => {
        priv.challengeContentVersion = "9.9.9";
        priv.secretSinkRegisters = ["RAX"];
      }),
      checkPairWith((priv) => {
        (priv.initialState as { registers: Record<string, string> }).registers["RSP"] = "0xdeadbeefdeadbeef";
      }),
      checkPairWith((priv) => {
        priv.interfaces = [
          {
            interfaceId: 512,
            displayText: "调用隐藏接口",
            effects: [{ effect: "set_flag", flagRegister: "FLAG_GHOST", valueHex: "0x1" }],
          },
        ];
        (priv.compiledIr as { instructions: unknown[] }).instructions = [
          { op: "syscall", operands: [{ kind: "immediate", valueHex: "0x200" }] },
        ];
      }),
      checkPairWith((priv) => {
        priv.seedPolicy = { strategy: "server_random_per_session", seedHex: SEED_SENTINEL };
      }),
      checkPairWith((priv) => {
        (priv.initialState as { memoryRegions: Array<Record<string, unknown>> }).memoryRegions.forEach(
          (region) => {
            region.byteLength = 6144;
          },
        );
      }),
      checkPairWith((priv) => {
        const ir = priv.compiledIr as { labels: Array<Record<string, unknown>> };
        ir.labels.push({ ...ir.labels[0]! });
        ir.labels[0]!.instructionIndex = 999;
      }),
      checkPairWith(undefined),
    ];

    // 将哨兵植入夹具秘密位:校验失败的输入同样不得把秘密带回错误面。
    const base = loadPublicDescriptor();
    const bundle = buildPrivateBundle(base);
    const seeded = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
    seeded.secrets = {
      flag: FLAG_SENTINEL,
      virtualFiles: [{ fileId: "win-notes", content: FILE_CONTENT_SENTINEL }],
    };
    scenarios.push(checkChallengePair(base, seeded as unknown as PrivateChallengeBundle));

    const violations = scenarios.flatMap((scenario) => scenario.violations);
    expect(violations.length).toBeGreaterThan(10);

    const forbidden = [FLAG_SENTINEL, SEED_SENTINEL, FILE_CONTENT_SENTINEL];
    for (const violation of violations) {
      for (const secret of forbidden) {
        expect(violation.message.includes(secret), violation.ruleId).toBe(false);
        expect((violation.path ?? "").includes(secret)).toBe(false);
      }
    }
  });

  it("违规统一映射 internal_error,且该码在协议 PublicError 词汇中存在", () => {
    expect(PUBLIC_FACING_ERROR_CODE_FOR_VIOLATIONS).toBe("internal_error");

    // 跨包防漂移:仅测试代码经 node:fs 读协议数据文件(非 import 边,
    // 双包Schema语义.md §六纪律),断言映射目标在协议冻结 16 码词汇内。
    const protocolErrorSchema = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "..", "protocol", "schema", "public-error.schema.json"),
        "utf8",
      ),
    ) as { properties: { code: { enum: readonly string[] } } };
    expect(protocolErrorSchema.properties.code.enum).toContain(
      PUBLIC_FACING_ERROR_CODE_FOR_VIOLATIONS,
    );
  });
});

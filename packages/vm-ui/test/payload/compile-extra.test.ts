/**
 * Payload 编译器补强测试(WP-F6):算子全覆盖、内存单字节读取、缺失输入
 * 与字段防御、窗口截断、类型错配其他形态、求值步数上限——与 compile.test.ts
 * 互补,同样全部以序列化 JSON 为输入。
 */
import { describe, expect, it } from "vitest";
import type { ActionObject } from "@stackmaster/protocol";

import {
  PAYLOAD_ARITH_TYPE,
  PAYLOAD_COMPARE_TYPE,
  PAYLOAD_FUNC_CALL_VALUE_TYPE,
  PAYLOAD_FUNC_DEF_TYPE,
  PAYLOAD_IF_TYPE,
  PAYLOAD_LIST_PUSH_TYPE,
  PAYLOAD_MEM_READ8_TYPE,
  PAYLOAD_MEM_READ_BYTE_TYPE,
  PAYLOAD_NUM_TYPE,
  PAYLOAD_PUSH_TYPE,
  PAYLOAD_REPEAT_TYPE,
  PAYLOAD_START_BLOCK_TYPE,
  PAYLOAD_STRING_LENGTH_TYPE,
  PAYLOAD_TEXT_TYPE,
  PAYLOAD_VAR_CHANGE_TYPE,
  PAYLOAD_VAR_GET_TYPE,
  PAYLOAD_VAR_SET_TYPE,
  PAYLOAD_WRITE_BYTES_TYPE,
  PAYLOAD_WRITE_STRING_TYPE,
} from "../../src/payload/compiler/blocks.js";
import { compilePayload } from "../../src/payload/compiler/compile.js";
import { createPublicEvalEnvironment } from "../../src/payload/compiler/eval.js";
import type {
  BlocklySerializedBlockState,
  BlocklySerializedState,
  PayloadStep,
} from "../../src/payload/compiler/types.js";
import { FakeMemoryDataSource } from "../views/byte/fake-data-source.js";

// ── 构造助手(与 compile.test.ts 同形的独立副本)──────────────────────────

let nextBlockId = 0;

function block(
  type: string,
  options: {
    fields?: Record<string, string>;
    inputs?: Record<string, unknown>;
  } = {},
): BlocklySerializedBlockState {
  nextBlockId += 1;
  return {
    type,
    id: `extra-blk-${nextBlockId}`,
    ...(options.fields === undefined ? {} : { fields: options.fields }),
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
  };
}

function value(blockSpec: BlocklySerializedBlockState): Record<string, unknown> {
  return { block: blockSpec };
}

function num(text: string): BlocklySerializedBlockState {
  return block(PAYLOAD_NUM_TYPE, { fields: { N: text } });
}

function text(textValue: string): BlocklySerializedBlockState {
  return block(PAYLOAD_TEXT_TYPE, { fields: { TEXT: textValue } });
}

function linkedProgram(...statements: BlocklySerializedBlockState[]): BlocklySerializedState {
  const start = block(PAYLOAD_START_BLOCK_TYPE);
  let tail: { block: BlocklySerializedBlockState } | undefined;
  for (const statement of [...statements].reverse()) {
    tail = tail === undefined ? { block: statement } : { block: { ...statement, next: tail } };
  }
  return {
    blocks: {
      languageVersion: 0,
      blocks: tail === undefined ? [start] : [{ ...start, next: tail }],
    },
  };
}

function actionOf(step: PayloadStep | undefined): ActionObject {
  if (step === undefined || step.kind !== "action") {
    throw new Error(`期望动作步骤,实际:${JSON.stringify(step)}`);
  }
  return step.action;
}

// ── 算术与比较算子(全算子矩阵)────────────────────────────────────────────

describe("算术与比较算子(全算子矩阵)", () => {
  it("sub / mul / mod 按无符号回绕与整除语义求值", () => {
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, {
          inputs: {
            VALUE: value(
              block(PAYLOAD_ARITH_TYPE, { fields: { OP: "sub" }, inputs: { A: value(num("3")), B: value(num("5")) } }),
            ),
          },
        }),
        block(PAYLOAD_PUSH_TYPE, {
          inputs: {
            VALUE: value(
              block(PAYLOAD_ARITH_TYPE, { fields: { OP: "mul" }, inputs: { A: value(num("6")), B: value(num("7")) } }),
            ),
          },
        }),
        block(PAYLOAD_PUSH_TYPE, {
          inputs: {
            VALUE: value(
              block(PAYLOAD_ARITH_TYPE, { fields: { OP: "mod" }, inputs: { A: value(num("9")), B: value(num("4")) } }),
            ),
          },
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // 3 − 5 回绕为 64 位无符号最大值。
    expect(actionOf(result.program.steps[0]).args).toEqual({ valueHex: "0xFFFFFFFFFFFFFFFE" });
    expect(actionOf(result.program.steps[1]).args).toEqual({ valueHex: "0x2A" });
    expect(actionOf(result.program.steps[2]).args).toEqual({ valueHex: "0x1" });
  });

  it("取模零确定性报错(同除零)", () => {
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, {
          inputs: {
            VALUE: value(
              block(PAYLOAD_ARITH_TYPE, { fields: { OP: "mod" }, inputs: { A: value(num("9")), B: value(num("0")) } }),
            ),
          },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("division_by_zero");
    }
  });

  it("比较算子 eq / ne / lt / gt / ge / le 全部可用", () => {
    const cases: Array<[string, string, string, boolean]> = [
      ["eq", "7", "7", true],
      ["ne", "7", "8", true],
      ["lt", "3", "4", true],
      ["gt", "5", "4", true],
      ["ge", "4", "4", true],
      ["le", "4", "5", true],
    ];
    for (const [op, a, b, expected] of cases) {
      const result = compilePayload(
        linkedProgram(
          block(PAYLOAD_IF_TYPE, {
            inputs: {
              COND: value(
                block(PAYLOAD_COMPARE_TYPE, { fields: { OP: op }, inputs: { A: value(num(a)), B: value(num(b)) } }),
              ),
              DO: { block: block(PAYLOAD_PUSH_TYPE, { inputs: { VALUE: value(num("1")) } }) },
              ELSE: { block: block(PAYLOAD_PUSH_TYPE, { inputs: { VALUE: value(num("2")) } }) },
            },
          }),
        ),
      );
      expect(result.ok, `${op} ${a} ${b}`).toBe(true);
      if (result.ok) {
        expect(actionOf(result.program.steps[0]).args).toEqual({ valueHex: expected ? "0x1" : "0x2" });
      }
    }
  });

  it("读内存单字节报告积木可组合进表达式", () => {
    const dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          windowBytesHex: "ff00",
        },
      ],
      [],
    );
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, {
          inputs: { VALUE: value(block(PAYLOAD_MEM_READ_BYTE_TYPE, { inputs: { ADDR: value(num("0x1000")) } })) },
        }),
      ),
      { environment: createPublicEvalEnvironment(dataSource) },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(actionOf(result.program.steps[0]).args).toEqual({ valueHex: "0xFF" });
    }
  });

  it("区域已映射但超出已下发窗口的读取给「不在已下发窗口内」报错", () => {
    const dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-heap",
          label: "heap",
          startAddressHex: "0x2000",
          byteLength: 64,
          permissions: "rw",
          windowBytesHex: "aa", // D3 截断:窗口仅下发 1 字节。
        },
      ],
      [],
    );
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, {
          inputs: { VALUE: value(block(PAYLOAD_MEM_READ8_TYPE, { inputs: { ADDR: value(num("0x2000")) } })) },
        }),
      ),
      { environment: createPublicEvalEnvironment(dataSource) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("unknown_reference");
      expect(result.errors[0]?.message).toContain("不在已下发窗口内");
    }
  });
});

// ── 缺失输入与字段防御(确定性报错)──────────────────────────────────────

describe("缺失输入与字段防御(确定性报错)", () => {
  it("值输入未连接 → missing_input", () => {
    const result = compilePayload(linkedProgram(block(PAYLOAD_PUSH_TYPE)));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("missing_input");
    }
  });

  it("无返回值函数不能作为取值调用 → missing_input", () => {
    nextBlockId += 1;
    const state: BlocklySerializedState = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: PAYLOAD_START_BLOCK_TYPE,
            id: "extra-start",
            next: {
              block: {
                type: PAYLOAD_PUSH_TYPE,
                id: "extra-push",
                inputs: {
                  VALUE: { block: { type: PAYLOAD_FUNC_CALL_VALUE_TYPE, id: "extra-call", fields: { NAME: "f" } } },
                },
              },
            },
          },
          { type: PAYLOAD_FUNC_DEF_TYPE, id: "extra-def-f", fields: { NAME: "f" } },
        ],
      },
    };
    const result = compilePayload(state);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("missing_input");
    }
  });

  it("字节内容超过协议级上限 → invalid_field", () => {
    const oversize = "ab".repeat(4097); // 4097 字节 > MAX_WRITE_BYTES(4096)。
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_WRITE_BYTES_TYPE, { fields: { BYTES: oversize }, inputs: { ADDR: value(num("0x1000")) } }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("invalid_field");
    }
  });

  it("空字符串与超长字符串写入 → invalid_field", () => {
    const empty = compilePayload(
      linkedProgram(
        block(PAYLOAD_WRITE_STRING_TYPE, { inputs: { STR: value(text("")), ADDR: value(num("0x1000")) } }),
      ),
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.errors[0]?.code).toBe("invalid_field");
    }

    const oversize = compilePayload(
      linkedProgram(
        block(PAYLOAD_WRITE_STRING_TYPE, {
          inputs: { STR: value(text("字".repeat(4097))), ADDR: value(num("0x1000")) },
        }),
      ),
    );
    expect(oversize.ok).toBe(false);
    if (!oversize.ok) {
      expect(oversize.errors[0]?.code).toBe("invalid_field");
    }
  });

  it("空变量名 / 未赋值变量增减 / 空列表名 → invalid_field 或 unknown_reference", () => {
    const emptyVar = compilePayload(
      linkedProgram(block(PAYLOAD_VAR_SET_TYPE, { fields: { VAR: "  " }, inputs: { VALUE: value(num("1")) } })),
    );
    expect(emptyVar.ok).toBe(false);
    if (!emptyVar.ok) {
      expect(emptyVar.errors[0]?.code).toBe("invalid_field");
    }

    const unassigned = compilePayload(
      linkedProgram(
        block(PAYLOAD_VAR_CHANGE_TYPE, { fields: { VAR: "x", OP: "inc" }, inputs: { DELTA: value(num("1")) } }),
      ),
    );
    expect(unassigned.ok).toBe(false);
    if (!unassigned.ok) {
      expect(unassigned.errors[0]?.code).toBe("unknown_reference");
    }

    const emptyList = compilePayload(
      linkedProgram(
        block(PAYLOAD_LIST_PUSH_TYPE, { fields: { LIST: " " }, inputs: { ITEM: value(num("1")) } }),
      ),
    );
    expect(emptyList.ok).toBe(false);
    if (!emptyList.ok) {
      expect(emptyList.errors[0]?.code).toBe("invalid_field");
    }
  });

  it("空函数名的顶层定义 → invalid_field(带 blockId)", () => {
    nextBlockId += 1;
    const state: BlocklySerializedState = {
      blocks: {
        languageVersion: 0,
        blocks: [
          { type: PAYLOAD_START_BLOCK_TYPE, id: "extra-start-2" },
          { type: PAYLOAD_FUNC_DEF_TYPE, id: "extra-nameless", fields: { NAME: " " } },
        ],
      },
    };
    const result = compilePayload(state);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({ code: "invalid_field", blockId: "extra-nameless" });
    }
  });
});

// ── 类型错配的其他形态与求值上限 ─────────────────────────────────────────

describe("类型错配的其他形态(求值期兜底)", () => {
  it("数值流入字符串位 / 数值流入条件位 → type_mismatch", () => {
    // 通配输出(var_get)持有数值流入 String 输入:连接检查放行,求值期兜底。
    const stringMismatch = compilePayload(
      linkedProgram(
        block(PAYLOAD_VAR_SET_TYPE, { fields: { VAR: "n" }, inputs: { VALUE: value(num("5")) } }),
        block(PAYLOAD_PUSH_TYPE, {
          inputs: {
            VALUE: value(
              block(PAYLOAD_STRING_LENGTH_TYPE, {
                inputs: { S: value(block(PAYLOAD_VAR_GET_TYPE, { fields: { VAR: "n" } })) },
              }),
            ),
          },
        }),
      ),
    );
    expect(stringMismatch.ok).toBe(false);
    if (!stringMismatch.ok) {
      expect(stringMismatch.errors[0]?.code).toBe("type_mismatch");
    }

    // 条件位同理:通配输出的数值经 var_get 流入 Boolean 输入。
    const condMismatch = compilePayload(
      linkedProgram(
        block(PAYLOAD_VAR_SET_TYPE, { fields: { VAR: "n" }, inputs: { VALUE: value(num("1")) } }),
        block(PAYLOAD_IF_TYPE, {
          inputs: {
            COND: value(block(PAYLOAD_VAR_GET_TYPE, { fields: { VAR: "n" } })),
            DO: { block: block(PAYLOAD_PUSH_TYPE, { inputs: { VALUE: value(num("1")) } }) },
            ELSE: { block: block(PAYLOAD_PUSH_TYPE, { inputs: { VALUE: value(num("2")) } }) },
          },
        }),
      ),
    );
    expect(condMismatch.ok).toBe(false);
    if (!condMismatch.ok) {
      expect(condMismatch.errors[0]?.code).toBe("type_mismatch");
    }
  });

  it("无求值环境时的内存引用给「当前无求值数据」确定性报错", () => {
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, {
          inputs: { VALUE: value(block(PAYLOAD_MEM_READ8_TYPE, { inputs: { ADDR: value(num("0x1000")) } })) },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("unknown_reference");
      expect(result.errors[0]?.message).toContain("当前无求值数据");
    }
  });

  it("表达式求值步数超上限 → eval_limit_exceeded(终止编译)", () => {
    // 深嵌套算术树(16 层 ≈ 33 次求值/轮)× repeat 200:求值预算先于展开
    // 预算耗尽(125 轮 ≈ 4125 次求值 > 4096,而语句计数 250 < 256)。
    let delta: BlocklySerializedBlockState = num("1");
    for (let depth = 0; depth < 16; depth += 1) {
      delta = block(PAYLOAD_ARITH_TYPE, {
        fields: { OP: "add" },
        inputs: { A: value(delta), B: value(num("1")) },
      });
    }
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_VAR_SET_TYPE, { fields: { VAR: "x" }, inputs: { VALUE: value(num("0")) } }),
        block(PAYLOAD_REPEAT_TYPE, {
          inputs: {
            TIMES: value(num("200")),
            DO: {
              block: block(PAYLOAD_VAR_CHANGE_TYPE, { fields: { VAR: "x", OP: "inc" }, inputs: { DELTA: value(delta) } }),
            },
          },
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("eval_limit_exceeded");
    }
  });
});

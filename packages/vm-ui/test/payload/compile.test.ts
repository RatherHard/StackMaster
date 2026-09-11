/**
 * Payload 编译器行为测试(WP-F6,TDD):全部以 Blockly workspace 序列化
 * JSON 为输入(纯编译器,不依赖 Blockly DOM 渲染)。覆盖:顺序映射、
 * 字符串 UTF-8 写字节、变量与运算求值、分支/循环展开、断点标记、
 * allowedActions 裁剪、展开上限、未知引用、函数内联与递归上限、列表、
 * 结构性错误与公开投影求值环境。
 */
import { describe, expect, it } from "vitest";
import type { ActionObject } from "@stackmaster/protocol";

import {
  PAYLOAD_ARITH_TYPE,
  PAYLOAD_BREAKPOINT_TYPE,
  PAYLOAD_CALL_TYPE,
  PAYLOAD_COMPARE_TYPE,
  PAYLOAD_FUNC_CALL_STMT_TYPE,
  PAYLOAD_FUNC_CALL_VALUE_TYPE,
  PAYLOAD_FUNC_DEF_TYPE,
  PAYLOAD_IF_TYPE,
  PAYLOAD_LIST_GET_TYPE,
  PAYLOAD_LIST_LENGTH_TYPE,
  PAYLOAD_LIST_PUSH_TYPE,
  PAYLOAD_MEM_READ8_TYPE,
  PAYLOAD_NUM_TYPE,
  PAYLOAD_POP_TYPE,
  PAYLOAD_PUSH_TYPE,
  PAYLOAD_REGISTER_GET_TYPE,
  PAYLOAD_RET_TYPE,
  PAYLOAD_REPEAT_TYPE,
  PAYLOAD_START_BLOCK_TYPE,
  PAYLOAD_STEP_TYPE,
  PAYLOAD_STRING_CONCAT_TYPE,
  PAYLOAD_STRING_LENGTH_TYPE,
  PAYLOAD_TEXT_TYPE,
  PAYLOAD_VAR_CHANGE_TYPE,
  PAYLOAD_VAR_GET_TYPE,
  PAYLOAD_VAR_SET_TYPE,
  PAYLOAD_WRITE_BYTES_TYPE,
  PAYLOAD_WRITE_STRING_TYPE,
} from "../../src/payload/compiler/blocks.js";
import {
  PAYLOAD_DEFAULT_ALLOWED_ACTIONS,
  PAYLOAD_MAX_CALL_DEPTH,
  PAYLOAD_MAX_EXPANDED_ACTIONS,
  compilePayload,
} from "../../src/payload/compiler/compile.js";
import { createPublicEvalEnvironment } from "../../src/payload/compiler/eval.js";
import type {
  BlocklySerializedBlockState,
  BlocklySerializedState,
  PayloadStep,
} from "../../src/payload/compiler/types.js";
import { FakeMemoryDataSource } from "../views/byte/fake-data-source.js";

// ── 序列化状态构造助手 ─────────────────────────────────────────────────────

let nextBlockId = 0;

/** 步骤收窄:断言为动作步骤并返回其 ActionObject(12 动作形态)。 */
function actionOf(step: PayloadStep | undefined): ActionObject {
  if (step === undefined || step.kind !== "action") {
    throw new Error(`期望动作步骤,实际:${JSON.stringify(step)}`);
  }
  return step.action;
}

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
    id: `blk-${nextBlockId}`,
    ...(options.fields === undefined ? {} : { fields: options.fields }),
    ...(options.inputs === undefined ? {} : { inputs: options.inputs }),
  };
}

/** 值输入(报告积木连接)。 */
function value(blockSpec: BlocklySerializedBlockState): Record<string, unknown> {
  return { block: blockSpec };
}

/** 以起始积木为首的语句链(单开始积木;start → next 嵌套)。 */
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

function num(text: string): BlocklySerializedBlockState {
  return block(PAYLOAD_NUM_TYPE, { fields: { N: text } });
}

function text(textValue: string): BlocklySerializedBlockState {
  return block(PAYLOAD_TEXT_TYPE, { fields: { TEXT: textValue } });
}

// ── 顺序映射(主控定案:write bytes→write_bytes、push/pop/call/ret 直接映射、
//    step 积木→step 动作)──────────────────────────────────────────────────

describe("顺序映射:动作积木 → 12 动作原子序列", () => {
  it("write_bytes / push / pop / call / ret / step 逐一映射且顺序保持", () => {
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_WRITE_BYTES_TYPE, { fields: { BYTES: "4142" }, inputs: { ADDR: value(num("0x1000")) } }),
        block(PAYLOAD_PUSH_TYPE, { inputs: { VALUE: value(num("0x10")) } }),
        block(PAYLOAD_POP_TYPE),
        block(PAYLOAD_CALL_TYPE, { inputs: { TARGET: value(num("0x2000")) } }),
        block(PAYLOAD_RET_TYPE),
        block(PAYLOAD_STEP_TYPE),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const steps = result.program.steps;
    expect(steps).toHaveLength(6);
    expect(steps[0]).toMatchObject({
      kind: "action",
      action: { type: "write_bytes", args: { addressHex: "0x1000", bytesHex: "4142" } },
    });
    expect(steps[1]).toMatchObject({
      action: { type: "push", args: { valueHex: "0x10" } },
    });
    expect(steps[2]).toMatchObject({ action: { type: "pop", args: {} } });
    expect(steps[3]).toMatchObject({ action: { type: "call", args: { targetHex: "0x2000" } } });
    expect(steps[4]).toMatchObject({ action: { type: "ret", args: {} } });
    expect(steps[5]).toMatchObject({ action: { type: "step", args: {} } });
    // 摘要与溯源:label 非空(悬停/时间线用),blockId 指向来源积木。
    for (const step of steps) {
      expect(step.label.length).toBeGreaterThan(0);
      expect(step.blockId).toBeTypeOf("string");
    }
  });

  it("缺省 allowedActions = 12 动作裁去 run_to_event(run_to_event 不暴露)", () => {
    expect(PAYLOAD_DEFAULT_ALLOWED_ACTIONS).not.toContain("run_to_event");
    expect(PAYLOAD_DEFAULT_ALLOWED_ACTIONS).toContain("write_bytes");
    expect(PAYLOAD_DEFAULT_ALLOWED_ACTIONS).toHaveLength(11);
  });

  it("地址可为表达式(num 字面量十六进制/十进制)", () => {
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_WRITE_BYTES_TYPE, { fields: { BYTES: "00" }, inputs: { ADDR: value(num("4096")) } }),
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(actionOf(result.program.steps[0])).toMatchObject({
        type: "write_bytes",
        args: { addressHex: "0x1000" },
      });
    }
  });
});

// ── 字符串操作(UTF-8 定案)────────────────────────────────────────────────

describe("字符串积木:写字符串 → write_bytes(UTF-8 定案)", () => {
  it("ASCII 与多字节 UTF-8 均按 UTF-8 字节写入", () => {
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_WRITE_STRING_TYPE, { inputs: { STR: value(text("AB")), ADDR: value(num("0x1000")) } }),
        block(PAYLOAD_WRITE_STRING_TYPE, { inputs: { STR: value(text("中")), ADDR: value(num("0x1010")) } }),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(actionOf(result.program.steps[0])).toMatchObject({
      type: "write_bytes",
      args: { addressHex: "0x1000", bytesHex: "4142" },
    });
    expect(actionOf(result.program.steps[1])).toMatchObject({
      type: "write_bytes",
      args: { addressHex: "0x1010", bytesHex: "e4b8ad" },
    });
  });

  it("字符串长度 = UTF-8 字节数;连接可组合", () => {
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, {
          inputs: {
            VALUE: value(
              block(PAYLOAD_STRING_LENGTH_TYPE, {
                inputs: {
                  S: value(
                    block(PAYLOAD_STRING_CONCAT_TYPE, { inputs: { A: value(text("中")), B: value(text("ab")) } }),
                  ),
                },
              }),
            ),
          },
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // "中" 3 字节 + "ab" 2 字节 = 5。
      expect(actionOf(result.program.steps[0])).toMatchObject({ type: "push", args: { valueHex: "0x5" } });
    }
  });
});

// ── 变量与运算(客户端编译期求值)─────────────────────────────────────────

describe("变量与运算积木:客户端编译期求值", () => {
  it("变量赋值 / 增减 / 读取按顺序语义求值", () => {
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_VAR_SET_TYPE, { fields: { VAR: "x" }, inputs: { VALUE: value(num("0x10")) } }),
        block(PAYLOAD_VAR_CHANGE_TYPE, { fields: { VAR: "x", OP: "inc" }, inputs: { DELTA: value(num("4")) } }),
        block(PAYLOAD_PUSH_TYPE, { inputs: { VALUE: value(block(PAYLOAD_VAR_GET_TYPE, { fields: { VAR: "x" } })) } }),
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(actionOf(result.program.steps[0])).toMatchObject({ type: "push", args: { valueHex: "0x14" } });
    }
  });

  it("算术 64 位无符号回绕(mask64)", () => {
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, {
          inputs: {
            VALUE: value(
              block(PAYLOAD_ARITH_TYPE, {
                fields: { OP: "add" },
                inputs: {
                  A: value(num("0xFFFFFFFFFFFFFFFF")),
                  B: value(num("1")),
                },
              }),
            ),
          },
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(actionOf(result.program.steps[0])).toMatchObject({ type: "push", args: { valueHex: "0x0" } });
    }
  });

  it("除零确定性报错;类型错配确定性报错(连接检查 + 求值兜底)", () => {
    const divZero = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, {
          inputs: {
            VALUE: value(
              block(PAYLOAD_ARITH_TYPE, { fields: { OP: "div" }, inputs: { A: value(num("1")), B: value(num("0")) } }),
            ),
          },
        }),
      ),
    );
    expect(divZero.ok).toBe(false);
    if (!divZero.ok) {
      expect(divZero.errors[0]?.code).toBe("division_by_zero");
    }

    // 字符串积木直连 Number 输入:Blockly 连接检查在加载期即拒绝(load_failed)。
    const checkedMismatch = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, {
          inputs: {
            VALUE: value(
              block(PAYLOAD_ARITH_TYPE, { fields: { OP: "add" }, inputs: { A: value(text("a")), B: value(num("1")) } }),
            ),
          },
        }),
      ),
    );
    expect(checkedMismatch.ok).toBe(false);
    if (!checkedMismatch.ok) {
      expect(checkedMismatch.errors[0]?.code).toBe("load_failed");
    }

    // 通配输出(var_get)持有字符串流入算术:求值期 type_mismatch 兜底。
    const evalMismatch = compilePayload(
      linkedProgram(
        block(PAYLOAD_VAR_SET_TYPE, { fields: { VAR: "s" }, inputs: { VALUE: value(text("a")) } }),
        block(PAYLOAD_PUSH_TYPE, {
          inputs: {
            VALUE: value(
              block(PAYLOAD_ARITH_TYPE, {
                fields: { OP: "add" },
                inputs: {
                  A: value(block(PAYLOAD_VAR_GET_TYPE, { fields: { VAR: "s" } })),
                  B: value(num("1")),
                },
              }),
            ),
          },
        }),
      ),
    );
    expect(evalMismatch.ok).toBe(false);
    if (!evalMismatch.ok) {
      expect(evalMismatch.errors[0]?.code).toBe("type_mismatch");
    }
  });
});

// ── 分支与循环(编译期展开;Q3:暂停只发生在原子动作边界)────────────────

describe("分支与循环积木:编译期展开为原子序列", () => {
  it("分支只展开被选中的支(条件编译期求值)", () => {
    const ifBlock = (n: string): BlocklySerializedBlockState =>
      block(PAYLOAD_IF_TYPE, {
        inputs: {
          COND: value(
            block(PAYLOAD_COMPARE_TYPE, { fields: { OP: "le" }, inputs: { A: value(num(n)), B: value(num("10")) } }),
          ),
          DO: { block: block(PAYLOAD_PUSH_TYPE, { inputs: { VALUE: value(num("1")) } }) },
          ELSE: { block: block(PAYLOAD_PUSH_TYPE, { inputs: { VALUE: value(num("2")) } }) },
        },
      });
    const thenResult = compilePayload(linkedProgram(ifBlock("5")));
    expect(thenResult.ok).toBe(true);
    if (thenResult.ok) {
      expect(thenResult.program.steps).toHaveLength(1);
      expect(actionOf(thenResult.program.steps[0])).toMatchObject({ type: "push", args: { valueHex: "0x1" } });
    }
    const elseResult = compilePayload(linkedProgram(ifBlock("11")));
    expect(elseResult.ok).toBe(true);
    if (elseResult.ok) {
      expect(actionOf(elseResult.program.steps[0])).toMatchObject({ type: "push", args: { valueHex: "0x2" } });
    }
  });

  it("循环按次数展开;体内变量状态逐次推进(顺序展开语义)", () => {
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_VAR_SET_TYPE, { fields: { VAR: "x" }, inputs: { VALUE: value(num("0")) } }),
        block(PAYLOAD_REPEAT_TYPE, {
          inputs: {
            TIMES: value(num("3")),
            DO: {
              block: block(PAYLOAD_VAR_CHANGE_TYPE, {
                fields: { VAR: "x", OP: "inc" },
                inputs: { DELTA: value(num("1")) },
              }),
            },
          },
        }),
        block(PAYLOAD_PUSH_TYPE, { inputs: { VALUE: value(block(PAYLOAD_VAR_GET_TYPE, { fields: { VAR: "x" } })) } }),
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.program.steps).toHaveLength(1);
      expect(actionOf(result.program.steps[0])).toMatchObject({ type: "push", args: { valueHex: "0x3" } });
    }
  });

  it("循环 0 次不产出步骤;超过展开上限确定性报错", () => {
    const zero = compilePayload(
      linkedProgram(
        block(PAYLOAD_REPEAT_TYPE, { inputs: { TIMES: value(num("0")), DO: { block: block(PAYLOAD_PUSH_TYPE, { inputs: { VALUE: value(num("1")) } }) } } }),
      ),
    );
    expect(zero.ok).toBe(true);
    if (zero.ok) {
      expect(zero.program.steps).toHaveLength(0);
    }

    const overLimit = compilePayload(
      linkedProgram(
        block(PAYLOAD_REPEAT_TYPE, {
          inputs: {
            TIMES: value(num("1000")),
            DO: { block: block(PAYLOAD_PUSH_TYPE, { inputs: { VALUE: value(num("1")) } }) },
          },
        }),
      ),
    );
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) {
      expect(overLimit.errors[0]?.code).toBe("expansion_limit_exceeded");
    }
    expect(PAYLOAD_MAX_EXPANDED_ACTIONS).toBe(256);
  });
});

// ── 断点(M7 变通:断点 = 步进暂停点标记)────────────────────────────────

describe("断点积木:标记断点位置", () => {
  it("断点在序列中产出 breakpoint 标记(非动作)", () => {
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, { inputs: { VALUE: value(num("1")) } }),
        block(PAYLOAD_BREAKPOINT_TYPE),
        block(PAYLOAD_PUSH_TYPE, { inputs: { VALUE: value(num("2")) } }),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.program.steps).toHaveLength(3);
    expect(result.program.steps[0]?.kind).toBe("action");
    expect(result.program.steps[1]?.kind).toBe("breakpoint");
    expect(result.program.steps[1]?.label).toContain("断点");
    expect(result.program.steps[2]?.kind).toBe("action");
  });
});

// ── allowedActions 裁剪(编译期,标红反馈带 blockId)───────────────────────

describe("allowedActions 裁剪(编译期)", () => {
  it("引用未授权动作的积木报 unauthorized_action 且携带 blockId", () => {
    const push = block(PAYLOAD_PUSH_TYPE, { inputs: { VALUE: value(num("1")) } });
    const result = compilePayload(linkedProgram(push), { allowedActions: ["write_bytes"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ code: "unauthorized_action", blockId: push.id });
    }
  });

  it("白名单内的动作正常编译;断点标记不受 allowedActions 影响", () => {
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_WRITE_BYTES_TYPE, { fields: { BYTES: "41" }, inputs: { ADDR: value(num("0x1000")) } }),
        block(PAYLOAD_BREAKPOINT_TYPE),
      ),
      { allowedActions: ["write_bytes"] },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.program.steps).toHaveLength(2);
    }
  });
});

// ── 未知引用确定性报错(M9 底线:求值仅限公开投影)───────────────────────

describe("未知引用确定性报错(M9 求值口径)", () => {
  it("未知变量 / 未接投影的寄存器与内存引用确定性报错", () => {
    const unknownVar = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, { inputs: { VALUE: value(block(PAYLOAD_VAR_GET_TYPE, { fields: { VAR: "x" } })) } }),
      ),
    );
    expect(unknownVar.ok).toBe(false);
    if (!unknownVar.ok) {
      expect(unknownVar.errors[0]?.code).toBe("unknown_reference");
    }

    const unknownRegister = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, {
          inputs: { VALUE: value(block(PAYLOAD_REGISTER_GET_TYPE, { fields: { REG: "rax" } })) },
        }),
      ),
    );
    expect(unknownRegister.ok).toBe(false);
    if (!unknownRegister.ok) {
      expect(unknownRegister.errors[0]?.code).toBe("unknown_reference");
    }
  });

  it("公开投影求值环境:寄存器可读、窗口内小端读 8 字节、窗口外报错", () => {
    const dataSource = new FakeMemoryDataSource(
      [
        {
          regionId: "region-stack",
          label: "stack",
          startAddressHex: "0x1000",
          byteLength: 4096,
          permissions: "rw",
          windowBytesHex: "0102030405060708ff",
        },
      ],
      [{ name: "RSP", valueHex: "0x1004" }],
    );
    const environment = createPublicEvalEnvironment(dataSource);

    const registerResult = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, {
          inputs: { VALUE: value(block(PAYLOAD_REGISTER_GET_TYPE, { fields: { REG: "rsp" } })) },
        }),
      ),
      { environment },
    );
    expect(registerResult.ok).toBe(true);
    if (registerResult.ok) {
      expect(actionOf(registerResult.program.steps[0])).toMatchObject({
        type: "push",
        args: { valueHex: "0x1004" },
      });
    }

    // 小端:低地址字节为低位(0x1000..0x1007 = 01..08 → 0x0807060504030201)。
    const memResult = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, {
          inputs: { VALUE: value(block(PAYLOAD_MEM_READ8_TYPE, { inputs: { ADDR: value(num("0x1000")) } })) },
        }),
      ),
      { environment },
    );
    expect(memResult.ok).toBe(true);
    if (memResult.ok) {
      expect(actionOf(memResult.program.steps[0])).toMatchObject({
        type: "push",
        args: { valueHex: "0x807060504030201" },
      });
    }

    // 窗口外(未映射地址)确定性报错。
    const outside = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, {
          inputs: { VALUE: value(block(PAYLOAD_MEM_READ8_TYPE, { inputs: { ADDR: value(num("0x9000")) } })) },
        }),
      ),
      { environment },
    );
    expect(outside.ok).toBe(false);
    if (!outside.ok) {
      expect(outside.errors[0]?.code).toBe("unknown_reference");
      expect(outside.errors[0]?.message).toContain("不可见");
    }
  });
});

// ── 函数(模块化积木,有返回值)──────────────────────────────────────────

describe("函数积木:编译期内联展开(有返回值)", () => {
  it("语句调用内联展开函数主体;取值调用返回 RETURN 求值", () => {
    const final = compilePayload(withTwoFunctions());
    expect(final.ok).toBe(true);
    if (!final.ok) {
      return;
    }
    // f 的主体(push 1)+ 主链 push(函数 g 返回 0x42)。
    expect(final.program.steps).toHaveLength(2);
    expect(actionOf(final.program.steps[0])).toMatchObject({ type: "push", args: { valueHex: "0x1" } });
    expect(actionOf(final.program.steps[1])).toMatchObject({ type: "push", args: { valueHex: "0x42" } });
  });

  function withTwoFunctions(): BlocklySerializedState {
    nextBlockId += 1;
    const mainCall = { ...block(PAYLOAD_FUNC_CALL_STMT_TYPE, { fields: { NAME: "f" } }), id: "main-1" };
    const mainPush = {
      ...block(PAYLOAD_PUSH_TYPE, {
        inputs: { VALUE: value(block(PAYLOAD_FUNC_CALL_VALUE_TYPE, { fields: { NAME: "g" } })) },
      }),
      id: "main-2",
    };
    nextBlockId += 1;
    return {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: PAYLOAD_START_BLOCK_TYPE,
            id: "start",
            next: { block: { ...mainCall, next: { block: mainPush } } },
          },
          {
            type: PAYLOAD_FUNC_DEF_TYPE,
            id: "def-f",
            fields: { NAME: "f" },
            inputs: { BODY: { block: { type: PAYLOAD_PUSH_TYPE, id: "f-body", fields: {}, inputs: { VALUE: value({ type: PAYLOAD_NUM_TYPE, id: "f-n", fields: { N: "1" } }) } } } },
          },
          {
            type: PAYLOAD_FUNC_DEF_TYPE,
            id: "def-g",
            fields: { NAME: "g" },
            inputs: { RETURN: { block: { type: PAYLOAD_NUM_TYPE, id: "g-ret", fields: { N: "0x42" } } } },
          },
        ],
      },
    };
  }

  it("递归受内联深度上限约束(确定性报错,防无限展开)", () => {
    nextBlockId += 1;
    const state: BlocklySerializedState = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: PAYLOAD_START_BLOCK_TYPE,
            id: "start",
            next: { block: { type: PAYLOAD_FUNC_CALL_STMT_TYPE, id: "call", fields: { NAME: "f" } } },
          },
          {
            type: PAYLOAD_FUNC_DEF_TYPE,
            id: "def-f",
            fields: { NAME: "f" },
            inputs: { BODY: { block: { type: PAYLOAD_FUNC_CALL_STMT_TYPE, id: "f-recurse", fields: { NAME: "f" } } } },
          },
        ],
      },
    };
    const result = compilePayload(state);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.errors.map((error) => error.code);
      expect(codes).toContain("call_depth_exceeded");
    }
    expect(PAYLOAD_MAX_CALL_DEPTH).toBe(32);
  });

  it("重复定义 / 未定义函数 / 主序列中的函数定义 = 确定性报错", () => {
    nextBlockId += 1;
    const duplicate: BlocklySerializedState = {
      blocks: {
        languageVersion: 0,
        blocks: [
          { type: PAYLOAD_START_BLOCK_TYPE, id: "s" },
          { type: PAYLOAD_FUNC_DEF_TYPE, id: "d1", fields: { NAME: "f" } },
          { type: PAYLOAD_FUNC_DEF_TYPE, id: "d2", fields: { NAME: "f" } },
        ],
      },
    };
    const duplicateResult = compilePayload(duplicate);
    expect(duplicateResult.ok).toBe(false);
    if (!duplicateResult.ok) {
      expect(duplicateResult.errors[0]?.code).toBe("duplicate_definition");
    }

    const unknownCall = compilePayload(
      linkedProgram(block(PAYLOAD_FUNC_CALL_STMT_TYPE, { fields: { NAME: "nope" } })),
    );
    expect(unknownCall.ok).toBe(false);
    if (!unknownCall.ok) {
      expect(unknownCall.errors[0]?.code).toBe("unknown_reference");
    }

    // 函数定义积木无 previousStatement:序列化进语句链在加载期即被拒绝
    // (连接检查;misplaced_block 为编译器防御性兜底,合法状态不可达)。
    nextBlockId += 1;
    const misplaced: BlocklySerializedState = {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: PAYLOAD_START_BLOCK_TYPE,
            id: "s2",
            next: { block: { type: PAYLOAD_FUNC_DEF_TYPE, id: "inline-def", fields: { NAME: "h" } } },
          },
        ],
      },
    };
    const misplacedResult = compilePayload(misplaced);
    expect(misplacedResult.ok).toBe(false);
    if (!misplacedResult.ok) {
      expect(misplacedResult.errors[0]?.code).toBe("load_failed");
    }
  });
});

// ── 列表(客户端求值)─────────────────────────────────────────────────────

describe("列表积木:客户端求值", () => {
  it("追加自动建表;按下标取值与长度可组合", () => {
    const result = compilePayload(
      linkedProgram(
        block(PAYLOAD_LIST_PUSH_TYPE, { fields: { LIST: "items" }, inputs: { ITEM: value(num("0xA")) } }),
        block(PAYLOAD_LIST_PUSH_TYPE, { fields: { LIST: "items" }, inputs: { ITEM: value(num("0xB")) } }),
        block(PAYLOAD_PUSH_TYPE, {
          inputs: {
            VALUE: value(
              block(PAYLOAD_ARITH_TYPE, {
                fields: { OP: "add" },
                inputs: {
                  A: value(block(PAYLOAD_LIST_GET_TYPE, { fields: { LIST: "items" }, inputs: { INDEX: value(num("1")) } })),
                  B: value(block(PAYLOAD_LIST_LENGTH_TYPE, { fields: { LIST: "items" } })),
                },
              }),
            ),
          },
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // items[1] = 0xB + 长度 2 = 0xD。
      expect(actionOf(result.program.steps[0])).toMatchObject({ type: "push", args: { valueHex: "0xD" } });
    }
  });

  it("未知列表读取与下标越界确定性报错", () => {
    const missing = compilePayload(
      linkedProgram(
        block(PAYLOAD_PUSH_TYPE, {
          inputs: { VALUE: value(block(PAYLOAD_LIST_GET_TYPE, { fields: { LIST: "none" }, inputs: { INDEX: value(num("0")) } })) },
        }),
      ),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors[0]?.code).toBe("unknown_reference");
    }

    const outOfRange = compilePayload(
      linkedProgram(
        block(PAYLOAD_LIST_PUSH_TYPE, { fields: { LIST: "items" }, inputs: { ITEM: value(num("1")) } }),
        block(PAYLOAD_PUSH_TYPE, {
          inputs: { VALUE: value(block(PAYLOAD_LIST_GET_TYPE, { fields: { LIST: "items" }, inputs: { INDEX: value(num("5")) } })) },
        }),
      ),
    );
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) {
      expect(outOfRange.errors[0]?.code).toBe("unknown_reference");
    }
  });
});

// ── 结构性错误 ─────────────────────────────────────────────────────────────

describe("结构性错误(FE-PB-03 唯一起始 + 状态加载)", () => {
  it("缺少起始积木 / 多个起始积木确定性报错", () => {
    const missing = compilePayload({ blocks: { languageVersion: 0, blocks: [] } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors[0]?.code).toBe("no_start_block");
    }

    nextBlockId += 1;
    const duplicated = compilePayload({
      blocks: {
        languageVersion: 0,
        blocks: [
          { type: PAYLOAD_START_BLOCK_TYPE, id: "s1" },
          { type: PAYLOAD_START_BLOCK_TYPE, id: "s2" },
        ],
      },
    });
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) {
      expect(duplicated.errors[0]?.code).toBe("multiple_start_blocks");
    }
  });

  it("未知积木类型 / 畸形状态 → 编译错误(不抛异常)", () => {
    const unknownBlock = compilePayload({
      blocks: { languageVersion: 0, blocks: [{ type: "totally_unknown_block", id: "x" }] },
    });
    expect(unknownBlock.ok).toBe(false);
    if (!unknownBlock.ok) {
      expect(unknownBlock.errors[0]?.code).toBe("unknown_block_type");
    }

    const malformed = compilePayload({ blocks: "not-an-object" as unknown as BlocklySerializedState["blocks"] });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(["load_failed", "unknown_block_type"]).toContain(malformed.errors[0]?.code);
    }
  });

  it("写字节字段非法(奇数长度 / 非十六进制)确定性报错", () => {
    const odd = compilePayload(
      linkedProgram(
        block(PAYLOAD_WRITE_BYTES_TYPE, { fields: { BYTES: "414" }, inputs: { ADDR: value(num("0x1000")) } }),
      ),
    );
    expect(odd.ok).toBe(false);
    if (!odd.ok) {
      expect(odd.errors[0]?.code).toBe("invalid_field");
    }
  });

  it("空程序(只有起始积木)编译为空序列", () => {
    const result = compilePayload(linkedProgram());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.program.steps).toHaveLength(0);
    }
  });
});

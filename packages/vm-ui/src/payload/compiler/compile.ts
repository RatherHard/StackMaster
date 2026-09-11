/**
 * Payload 编译器(WP-F6):Blockly workspace 序列化(JSON state)→
 * 12 动作原子步骤序列。**纯逻辑,不依赖 Blockly DOM 渲染**——内部以无头
 * `Blockly.Workspace` 加载序列化状态(jsdom 下渲染受限,编译器测试全部走
 * 序列化 JSON 输入)。
 *
 * 语义(M9 变通口径 + Q3 定案):
 *  - 变量 / 运算 / 字符串操作 / 列表在**客户端编译期求值**,求值环境 =
 *    公开投影只读快照(见 eval.ts);未知引用确定性报错;
 *  - 循环 / 分支展开为原子动作序列(分支只展开被选中的支;循环逐次展开,
 *    体内表达式随编译期变量状态逐次求值——与顺序展开语义一致);
 *  - 函数(模块化积木)编译期内联展开,可携带返回值;递归受
 *    `PAYLOAD_MAX_CALL_DEPTH` 与展开上限约束;
 *  - 断点积木 → `breakpoint` 步骤标记(步进暂停点,M7 变通);
 *  - `allowedActions` 编译期裁剪:引用未授权动作的积木产出编译错误
 *    (带 blockId,UI 标红),不产出对应步骤;
 *  - 展开总量受 `PAYLOAD_MAX_EXPANDED_ACTIONS` 约束(同时约束"展开语句
 *    访问数"与"产出步骤数"两个口径,取更严者,防无限展开)。
 */
import {
  MAX_WRITE_BYTES,
  SESSION_ACTION_TYPES,
  type ActionObject,
} from "@stackmaster/protocol";
import * as Blockly from "blockly";

import { t } from "../../i18n/i18n.js";
import { addressToHex } from "../../render/hex.js";
import { bytesToBytesHex } from "../../render/hex.js";
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
  PAYLOAD_MEM_READ_BYTE_TYPE,
  PAYLOAD_NUM_TYPE,
  PAYLOAD_PUSH_TYPE,
  PAYLOAD_REGISTER_GET_TYPE,
  PAYLOAD_RET_TYPE,
  PAYLOAD_REPEAT_TYPE,
  PAYLOAD_START_BLOCK_TYPE,
  PAYLOAD_STEP_TYPE,
  PAYLOAD_STRING_CONCAT_TYPE,
  PAYLOAD_STRING_LENGTH_TYPE,
  PAYLOAD_POP_TYPE,
  PAYLOAD_TEXT_TYPE,
  PAYLOAD_VAR_CHANGE_TYPE,
  PAYLOAD_VAR_GET_TYPE,
  PAYLOAD_VAR_SET_TYPE,
  PAYLOAD_WRITE_BYTES_TYPE,
  PAYLOAD_WRITE_STRING_TYPE,
  registerPayloadBlocks,
} from "./blocks.js";
import {
  PayloadEvalError,
  PayloadList,
  createEmptyEvalEnvironment,
  mask64,
  parseNumericLiteral,
  utf8Encode,
  valueToBoolean,
  valueToNumber,
  valueToString,
  type PayloadValue,
} from "./eval.js";
import type {
  BlocklySerializedState,
  CompilePayloadOptions,
  CompilePayloadResult,
  PayloadCompileError,
  PayloadCompileErrorCode,
  PayloadEvalEnvironment,
  PayloadProgram,
  PayloadStep,
} from "./types.js";

/**
 * 展开上限常量:编译产出的原子步骤总数(以及展开过程中的语句访问总数)
 * 不得超过该值,超限确定性报错(防无限展开 / 限流不可行,主控定案示例值)。
 */
export const PAYLOAD_MAX_EXPANDED_ACTIONS = 256;

/** 函数内联深度上限(递归防无限展开)。 */
export const PAYLOAD_MAX_CALL_DEPTH = 32;

/** 表达式求值步数上限(纯求值型程序的表达式节点求值总量;防编译期失控)。 */
export const PAYLOAD_MAX_EVAL_STEPS = 4096;

/**
 * 缺省 allowedActions:12 动作裁去 run_to_event(教学范围定案:run_to_event
 * 不暴露);其余动作(pause/undo/checkpoint 族含内)缺省可编译,题目侧以
 * allowedActions 再裁剪。
 */
export const PAYLOAD_DEFAULT_ALLOWED_ACTIONS: readonly string[] = SESSION_ACTION_TYPES.filter(
  (type) => type !== "run_to_event",
);

/** 编译中断(内部控制流;错误以值返回,不外抛)。 */
class CompileAbort extends Error {
  constructor(readonly error: PayloadCompileError) {
    super(error.message);
    this.name = "CompileAbort";
  }
}

/** 编译上下文(编译期可变状态;求值环境快照 + 变量/列表/函数表)。 */
interface CompileContext {
  readonly steps: PayloadStep[];
  readonly variables: Map<string, PayloadValue>;
  readonly lists: Map<string, PayloadList>;
  readonly functions: Map<string, Blockly.Block>;
  readonly allowedActions: ReadonlySet<string>;
  readonly environment: PayloadEvalEnvironment;
  readonly errors: PayloadCompileError[];
  expandedStatementCount: number;
  expandedActionCount: number;
  evalStepCount: number;
  callDepth: number;
}

/** 确定性失败(中断当前编译路径)。 */
function fail(code: PayloadCompileErrorCode, message: string, blockId: string | null): never {
  throw new CompileAbort({ code, message, blockId });
}

/** 字段文本(field_input / field_dropdown)。 */
function fieldText(block: Blockly.Block, name: string): string {
  const value = block.getFieldValue(name);
  return typeof value === "string" ? value : "";
}

/** 取语句输入的第一块(输入缺席 / 未连接 → null)。 */
function statementOf(block: Blockly.Block, name: string): Blockly.Block | null {
  return block.getInput(name)?.connection?.targetBlock() ?? null;
}

// ── 表达式求值(编译期)────────────────────────────────────────────────────

/** 求值一个值输入连接的报告积木。 */
function evalReporter(ctx: CompileContext, block: Blockly.Block): PayloadValue {
  ctx.evalStepCount += 1;
  if (ctx.evalStepCount > PAYLOAD_MAX_EVAL_STEPS) {
    fail("eval_limit_exceeded", t("compile.errEvalLimit", { limit: PAYLOAD_MAX_EVAL_STEPS }), block.id);
  }
  switch (block.type) {
    case PAYLOAD_NUM_TYPE:
      return parseNumericLiteral(fieldText(block, "N"));
    case PAYLOAD_TEXT_TYPE:
      return fieldText(block, "TEXT");
    case PAYLOAD_VAR_GET_TYPE: {
      const name = fieldText(block, "VAR").trim();
      const value = ctx.variables.get(name);
      if (value === undefined) {
        fail("unknown_reference", t("compile.errVarUnassigned", { name }), block.id);
      }
      return value;
    }
    case PAYLOAD_ARITH_TYPE: {
      const a = evalNumberInput(ctx, block, "A");
      const b = evalNumberInput(ctx, block, "B");
      const op = fieldText(block, "OP");
      if (op === "add") {
        return mask64(a + b);
      }
      if (op === "sub") {
        return mask64(a - b);
      }
      if (op === "mul") {
        return mask64(a * b);
      }
      if (op === "div") {
        if (b === 0n) {
          fail("division_by_zero", t("compile.errDivisionByZero"), block.id);
        }
        return a / b;
      }
      if (op === "mod") {
        if (b === 0n) {
          fail("division_by_zero", t("compile.errModuloByZero"), block.id);
        }
        return a % b;
      }
      return fail("invalid_field", t("compile.errUnknownArithOp", { op }), block.id);
    }
    case PAYLOAD_COMPARE_TYPE: {
      const a = evalNumberInput(ctx, block, "A");
      const b = evalNumberInput(ctx, block, "B");
      const op = fieldText(block, "OP");
      if (op === "eq") {
        return a === b;
      }
      if (op === "ne") {
        return a !== b;
      }
      if (op === "lt") {
        return a < b;
      }
      if (op === "le") {
        return a <= b;
      }
      if (op === "gt") {
        return a > b;
      }
      if (op === "ge") {
        return a >= b;
      }
      return fail("invalid_field", t("compile.errUnknownCompareOp", { op }), block.id);
    }
    case PAYLOAD_REGISTER_GET_TYPE:
      return ctx.environment.registerValue(fieldText(block, "REG"));
    case PAYLOAD_MEM_READ8_TYPE:
      return ctx.environment.readBytesLittleEndian(evalNumberInput(ctx, block, "ADDR"), 8);
    case PAYLOAD_MEM_READ_BYTE_TYPE:
      return BigInt(ctx.environment.byteAt(evalNumberInput(ctx, block, "ADDR")));
    case PAYLOAD_LIST_GET_TYPE: {
      const list = requireList(ctx, block);
      const index = evalNumberInput(ctx, block, "INDEX");
      if (index < 0n || index >= BigInt(list.items.length)) {
        fail(
          "unknown_reference",
          t("compile.errListIndexOutOfRange", { index: String(index), length: list.items.length }),
          block.id,
        );
      }
      // 越界已在上方确定性拦截;此处索引必在界内。
      return list.items[Number(index)] as PayloadValue;
    }
    case PAYLOAD_LIST_LENGTH_TYPE:
      return BigInt(requireList(ctx, block).items.length);
    case PAYLOAD_STRING_CONCAT_TYPE:
      return evalStringInput(ctx, block, "A") + evalStringInput(ctx, block, "B");
    case PAYLOAD_STRING_LENGTH_TYPE:
      return BigInt(utf8Encode(evalStringInput(ctx, block, "S")).length);
    case PAYLOAD_FUNC_CALL_VALUE_TYPE:
      return callFunction(ctx, block, true);
    default:
      fail("unknown_block_type", t("compile.errValueBlock", { type: block.type }), block.id);
  }
}

/** 求值值输入(未连接 → 缺少输入确定性报错)。 */
function evalValueInput(ctx: CompileContext, block: Blockly.Block, name: string): PayloadValue {
  const connected = block.getInput(name)?.connection?.targetBlock() ?? null;
  if (connected === null) {
    fail("missing_input", t("compile.errMissingInput", { name }), block.id);
  }
  return evalReporter(ctx, connected);
}

function evalNumberInput(ctx: CompileContext, block: Blockly.Block, name: string): bigint {
  return valueToNumber(evalValueInput(ctx, block, name));
}

function evalStringInput(ctx: CompileContext, block: Blockly.Block, name: string): string {
  return valueToString(evalValueInput(ctx, block, name));
}

function evalBooleanInput(ctx: CompileContext, block: Blockly.Block, name: string): boolean {
  return valueToBoolean(evalValueInput(ctx, block, name));
}

/** 取具名列表(未知列表确定性报错;push 之外的操作不自动创建)。 */
function requireList(ctx: CompileContext, block: Blockly.Block): PayloadList {
  const name = fieldText(block, "LIST").trim();
  const list = ctx.lists.get(name);
  if (list === undefined) {
    fail("unknown_reference", t("compile.errListUnknown", { name }), block.id);
  }
  return list;
}

/** 函数内联调用(语句形态忽略返回值;取值形态返回 RETURN 输入求值)。 */
function callFunction(ctx: CompileContext, block: Blockly.Block, wantReturnValue: boolean): PayloadValue {
  const name = fieldText(block, "NAME").trim();
  const definition = ctx.functions.get(name);
  if (definition === undefined) {
    fail("unknown_reference", t("compile.errFunctionUndefined", { name }), block.id);
  }
  if (ctx.callDepth >= PAYLOAD_MAX_CALL_DEPTH) {
    fail(
      "call_depth_exceeded",
      t("compile.errCallDepthExceeded", { limit: PAYLOAD_MAX_CALL_DEPTH }),
      block.id,
    );
  }
  ctx.callDepth += 1;
  try {
    compileStatementChain(ctx, statementOf(definition, "BODY"));
    if (!wantReturnValue) {
      return 0n;
    }
    const connected = definition.getInput("RETURN")?.connection?.targetBlock() ?? null;
    if (connected === null) {
      fail("missing_input", t("compile.errFunctionNoReturn", { name }), block.id);
    }
    return evalReporter(ctx, connected);
  } finally {
    ctx.callDepth -= 1;
  }
}

// ── 语句编译(展开为原子步骤)──────────────────────────────────────────────

/** 产出动作步骤(allowedActions 裁剪 + 展开上限;未授权不产出步骤但继续编译)。 */
function emitAction(ctx: CompileContext, block: Blockly.Block, action: ActionObject, label: string): void {
  if (!ctx.allowedActions.has(action.type)) {
    ctx.errors.push({
      code: "unauthorized_action",
      message: t("compile.errActionNotAllowed", { action: action.type }),
      blockId: block.id,
    });
    return;
  }
  ctx.expandedActionCount += 1;
  if (ctx.expandedActionCount > PAYLOAD_MAX_EXPANDED_ACTIONS) {
    fail(
      "expansion_limit_exceeded",
      t("compile.errExpandedActionsExceeded", { limit: PAYLOAD_MAX_EXPANDED_ACTIONS }),
      block.id,
    );
  }
  ctx.steps.push({ kind: "action", action, label, blockId: block.id });
}

/** 语句链编译:逐块展开(顺序语义,变量状态随编译推进)。 */
function compileStatementChain(ctx: CompileContext, block: Blockly.Block | null): void {
  let current = block;
  while (current !== null) {
    ctx.expandedStatementCount += 1;
    if (ctx.expandedStatementCount > PAYLOAD_MAX_EXPANDED_ACTIONS) {
      fail(
        "expansion_limit_exceeded",
        `展开语句数超过上限(${PAYLOAD_MAX_EXPANDED_ACTIONS}),请缩小循环或拆分程序`,
        current.id,
      );
    }
    compileStatement(ctx, current);
    current = current.getNextBlock();
  }
}

function compileStatement(ctx: CompileContext, block: Blockly.Block): void {
  switch (block.type) {
    case PAYLOAD_WRITE_BYTES_TYPE: {
      const address = evalNumberInput(ctx, block, "ADDR");
      const bytesHex = fieldText(block, "BYTES").trim();
      if (!/^(?:[0-9a-fA-F]{2})+$/.test(bytesHex)) {
        fail(
          "invalid_field",
          t("compile.errInvalidBytesHex", { value: JSON.stringify(bytesHex) }),
          block.id,
        );
      }
      if (bytesHex.length / 2 > MAX_WRITE_BYTES) {
        fail(
          "invalid_field",
          t("compile.errBytesTooLong", { limit: MAX_WRITE_BYTES }),
          block.id,
        );
      }
      emitAction(
        ctx,
        block,
        { type: "write_bytes", args: { addressHex: addressToHex(address), bytesHex: bytesHex.toLowerCase() } },
        t("compile.stepWriteBytes", {
          address: addressToHex(address),
          bytes: bytesHex.toLowerCase(),
        }),
      );
      return;
    }
    case PAYLOAD_WRITE_STRING_TYPE: {
      // 编码定案(主控):公开档无编码表下发,字符串一律按 UTF-8 字节写入。
      const text = evalStringInput(ctx, block, "STR");
      const address = evalNumberInput(ctx, block, "ADDR");
      const bytes = utf8Encode(text);
      if (bytes.length === 0) {
        fail("invalid_field", t("compile.errEmptyString"), block.id);
      }
      if (bytes.length > MAX_WRITE_BYTES) {
        fail(
          "invalid_field",
          t("compile.errStringTooLong", { limit: MAX_WRITE_BYTES }),
          block.id,
        );
      }
      const bytesHex = bytesToBytesHex(bytes);
      emitAction(
        ctx,
        block,
        { type: "write_bytes", args: { addressHex: addressToHex(address), bytesHex } },
        t("compile.stepWriteString", { text, address: addressToHex(address) }),
      );
      return;
    }
    case PAYLOAD_PUSH_TYPE: {
      const value = evalNumberInput(ctx, block, "VALUE");
      emitAction(
        ctx,
        block,
        { type: "push", args: { valueHex: `0x${value.toString(16).toUpperCase()}` } },
        t("compile.stepPush", { value: value.toString(16).toUpperCase() }),
      );
      return;
    }
    case PAYLOAD_POP_TYPE:
      emitAction(ctx, block, { type: "pop", args: {} }, t("compile.stepPop"));
      return;
    case PAYLOAD_CALL_TYPE: {
      const target = evalNumberInput(ctx, block, "TARGET");
      emitAction(
        ctx,
        block,
        { type: "call", args: { targetHex: addressToHex(target) } },
        t("compile.stepCall", { address: addressToHex(target) }),
      );
      return;
    }
    case PAYLOAD_RET_TYPE:
      emitAction(ctx, block, { type: "ret", args: {} }, t("compile.stepRet"));
      return;
    case PAYLOAD_STEP_TYPE:
      emitAction(ctx, block, { type: "step", args: {} }, t("compile.stepInstruction"));
      return;
    case PAYLOAD_BREAKPOINT_TYPE:
      // 断点(M7 变通):不是动作,是步进暂停点标记。
      ctx.steps.push({ kind: "breakpoint", label: t("compile.stepBreakpoint"), blockId: block.id });
      return;
    case PAYLOAD_IF_TYPE: {
      // 分支:编译期求值,只展开被选中的支(Q3:暂停只发生在原子动作边界)。
      const condition = evalBooleanInput(ctx, block, "COND");
      compileStatementChain(ctx, statementOf(block, condition ? "DO" : "ELSE"));
      return;
    }
    case PAYLOAD_REPEAT_TYPE: {
      // 循环:编译期逐次展开;每次迭代计入展开预算(体内表达式随变量状态
      // 逐次求值,与顺序展开语义一致);超限确定性报错。
      const times = evalNumberInput(ctx, block, "TIMES");
      for (let index = 0n; index < times; index += 1n) {
        ctx.expandedStatementCount += 1;
        if (ctx.expandedStatementCount > PAYLOAD_MAX_EXPANDED_ACTIONS) {
          fail(
            "expansion_limit_exceeded",
            t("compile.errRepeatExceeded", { limit: PAYLOAD_MAX_EXPANDED_ACTIONS }),
            block.id,
          );
        }
        compileStatementChain(ctx, statementOf(block, "DO"));
      }
      return;
    }
    case PAYLOAD_VAR_SET_TYPE: {
      const name = fieldText(block, "VAR").trim();
      if (name === "") {
        fail("invalid_field", t("compile.errEmptyVarName"), block.id);
      }
      ctx.variables.set(name, evalValueInput(ctx, block, "VALUE"));
      return;
    }
    case PAYLOAD_VAR_CHANGE_TYPE: {
      const name = fieldText(block, "VAR").trim();
      const current = ctx.variables.get(name);
      if (current === undefined) {
        fail("unknown_reference", t("compile.errVarUnassignedChange", { name }), block.id);
      }
      const delta = evalNumberInput(ctx, block, "DELTA");
      const base = valueToNumber(current);
      ctx.variables.set(
        name,
        mask64(fieldText(block, "OP") === "dec" ? base - delta : base + delta),
      );
      return;
    }
    case PAYLOAD_LIST_PUSH_TYPE: {
      const name = fieldText(block, "LIST").trim();
      if (name === "") {
        fail("invalid_field", t("compile.errEmptyListName"), block.id);
      }
      const item = evalValueInput(ctx, block, "ITEM");
      let list = ctx.lists.get(name);
      if (list === undefined) {
        // 首次追加自动创建(工具箱 tooltip 登记的口径)。
        list = new PayloadList();
        ctx.lists.set(name, list);
      }
      list.items.push(item);
      return;
    }
    case PAYLOAD_FUNC_DEF_TYPE:
      fail("misplaced_block", t("compile.errFunctionDefPosition"), block.id);
      return;
    case PAYLOAD_FUNC_CALL_STMT_TYPE:
      void callFunction(ctx, block, false);
      return;
    default:
      fail("unknown_block_type", t("compile.errUnknownStatementBlock", { type: block.type }), block.id);
  }
}

// ── 编译入口 ───────────────────────────────────────────────────────────────

/**
 * 编译:序列化 JSON state → 原子步骤序列(或确定性错误列表)。
 * 编译器不抛错——错误是值(见 `CompilePayloadResult`)。
 */
export function compilePayload(
  state: BlocklySerializedState,
  options: CompilePayloadOptions = {},
): CompilePayloadResult {
  registerPayloadBlocks();
  const workspace = new Blockly.Workspace();
  try {
    try {
      Blockly.serialization.workspaces.load(state as never, workspace);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const unknownType = /Invalid block definition for type:\s*(\S+)/.exec(message);
      return {
        ok: false,
        errors: [
          {
            code: unknownType !== null ? "unknown_block_type" : "load_failed",
            message: unknownType !== null
              ? t("compile.errLoadUnknownType", { type: unknownType[1] ?? "" })
              : t("compile.errLoadFailed", { message }),
            blockId: null,
          },
        ],
      };
    }

    const topBlocks = workspace.getTopBlocks(false);
    const starts = topBlocks.filter((block) => block.type === PAYLOAD_START_BLOCK_TYPE);
    if (starts.length === 0) {
      return {
        ok: false,
        errors: [
          {
            code: "no_start_block",
            message: t("compile.errNoStartBlock"),
            blockId: null,
          },
        ],
      };
    }
    if (starts.length > 1) {
      return {
        ok: false,
        errors: [
          {
            code: "multiple_start_blocks",
            message: t("compile.errMultipleStartBlocks", { count: starts.length }),
            blockId: starts[1]?.id ?? null,
          },
        ],
      };
    }

    const ctx: CompileContext = {
      steps: [],
      variables: new Map(),
      lists: new Map(),
      functions: new Map(),
      allowedActions: new Set(options.allowedActions ?? PAYLOAD_DEFAULT_ALLOWED_ACTIONS),
      environment: options.environment ?? createFallbackEnvironment(),
      errors: [],
      expandedStatementCount: 0,
      expandedActionCount: 0,
      evalStepCount: 0,
      callDepth: 0,
    };

    // 函数表:仅画布顶层 func_def(主序列里的 func_def 由语句编译报错)。
    for (const block of topBlocks) {
      if (block.type !== PAYLOAD_FUNC_DEF_TYPE) {
        continue;
      }
      const name = fieldText(block, "NAME").trim();
      if (name === "") {
        ctx.errors.push({ code: "invalid_field", message: t("compile.errEmptyFunctionName"), blockId: block.id });
        continue;
      }
      if (ctx.functions.has(name)) {
        ctx.errors.push({
          code: "duplicate_definition",
          message: t("compile.errDuplicateFunction", { name }),
          blockId: block.id,
        });
        continue;
      }
      ctx.functions.set(name, block);
    }

    try {
      if (ctx.errors.length === 0) {
        compileStatementChain(ctx, starts[0]?.getNextBlock() ?? null);
      }
    } catch (error) {
      if (error instanceof CompileAbort) {
        ctx.errors.push(error.error);
      } else if (error instanceof PayloadEvalError) {
        ctx.errors.push({ code: error.code, message: error.message, blockId: null });
      } else {
        ctx.errors.push({
          code: "load_failed",
          message: t("compile.errInternal", {
            message: error instanceof Error ? error.message : String(error),
          }),
          blockId: null,
        });
      }
    }

    if (ctx.errors.length > 0) {
      return { ok: false, errors: ctx.errors };
    }
    const program: PayloadProgram = { steps: ctx.steps };
    return { ok: true, program };
  } finally {
    workspace.dispose();
  }
}

/** 兜底求值环境(未提供 environment 时:任何寄存器/内存引用确定性报错)。 */
function createFallbackEnvironment(): PayloadEvalEnvironment {
  return createEmptyEvalEnvironment();
}

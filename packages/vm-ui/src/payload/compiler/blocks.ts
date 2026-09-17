/**
 * Payload 积木定义与工具箱(WP-F6 / FE-PB-02 / FE-PB-03 / FE-PB-06)。
 *
 * 本模块是 UI(Blockly inject)与编译器(无头 workspace 加载)共享的
 * **唯一定义源**:积木 JSON 定义在此登记一次,两侧同形。
 *
 * 定案登记:
 *  - **八类基础积木**(FE-PB-02,以拆解文档为准)+ 增设「会话动作」分类承载
 *    12 动作教学映射(拆解八类没有给动作映射落点,以"编译到 12 动作原子"
 *    为唯一准绳,主控定案映射:write bytes→write_bytes、push/pop/call/ret
 *    直接映射、字符串写字节→write_bytes(公开档无编码表下发,**字符串一律
 *    按 UTF-8 字节**——定案)、step 积木→step 动作;run_to_event 不暴露);
 *  - **唯一起始积木**(FE-PB-03):`payload_start` 不进工具箱,画布唯一
 *    预置(deletable=false),编译以它为唯一入口;
 *  - **悬停提示**(FE-PB-06):每块积木 tooltip 为中文功能说明;
 *  - 变量名 / 列表名 / 函数名用文本字段(不用 Blockly 变量模型 / flyout
 *    动态列表)——序列化形态稳定、无头编译零额外状态;动态名下拉留打磨。
 */
import * as Blockly from "blockly";

import { t, type SmMessageKey } from "../../i18n/i18n.js";

/** 起始积木类型(唯一入口;FE-PB-03)。 */
export const PAYLOAD_START_BLOCK_TYPE = "payload_start";

// ── 积木类型常量(编译器与 UI 共用)────────────────────────────────────────

/** 会话动作类。 */
export const PAYLOAD_WRITE_BYTES_TYPE = "payload_write_bytes";
export const PAYLOAD_PUSH_TYPE = "payload_push";
export const PAYLOAD_POP_TYPE = "payload_pop";
export const PAYLOAD_CALL_TYPE = "payload_call";
export const PAYLOAD_RET_TYPE = "payload_ret";
export const PAYLOAD_STEP_TYPE = "payload_step_action";
/** 断点类。 */
export const PAYLOAD_BREAKPOINT_TYPE = "payload_breakpoint";
/** 变量类。 */
export const PAYLOAD_VAR_SET_TYPE = "payload_var_set";
export const PAYLOAD_VAR_GET_TYPE = "payload_var_get";
export const PAYLOAD_VAR_CHANGE_TYPE = "payload_var_change";
/** 列表类。 */
export const PAYLOAD_LIST_PUSH_TYPE = "payload_list_push";
export const PAYLOAD_LIST_GET_TYPE = "payload_list_get";
export const PAYLOAD_LIST_LENGTH_TYPE = "payload_list_length";
/** 分支 / 循环类。 */
export const PAYLOAD_IF_TYPE = "payload_if";
export const PAYLOAD_REPEAT_TYPE = "payload_repeat";
/** 函数(模块化)类。 */
export const PAYLOAD_FUNC_DEF_TYPE = "payload_func_def";
export const PAYLOAD_FUNC_CALL_STMT_TYPE = "payload_func_call_stmt";
export const PAYLOAD_FUNC_CALL_VALUE_TYPE = "payload_func_call_value";
/** 运算与赋值类。 */
export const PAYLOAD_NUM_TYPE = "payload_num";
export const PAYLOAD_TEXT_TYPE = "payload_text";
export const PAYLOAD_ARITH_TYPE = "payload_arith";
export const PAYLOAD_COMPARE_TYPE = "payload_compare";
/** 字符串类。 */
export const PAYLOAD_WRITE_STRING_TYPE = "payload_write_string";
export const PAYLOAD_STRING_CONCAT_TYPE = "payload_string_concat";
export const PAYLOAD_STRING_LENGTH_TYPE = "payload_string_length";
/** 公开投影读取类(求值环境面)。 */
export const PAYLOAD_REGISTER_GET_TYPE = "payload_register_get";
export const PAYLOAD_MEM_READ8_TYPE = "payload_mem_read8";
export const PAYLOAD_MEM_READ_BYTE_TYPE = "payload_mem_read_byte";

/** 值类型检查串(Blockly 连接检查:Number / String / Boolean;缺省 = 任意)。 */
const NUM = "Number";
const STR = "String";
const BOOL = "Boolean";

/**
 * 积木文案 i18n 键映射(积木 type → message / tooltip 目录键;下拉选项键)。
 * WP-53 抽取面:`PAYLOAD_BLOCK_DEFINITIONS` 常量保持 zh-CN 快照(既有测试与
 * 公开 API 面的事实来源),`registerPayloadBlocks()` 经 `buildPayloadBlock
 * Definitions()` 按**注册时刻 locale** 构建(遗留登记:运行中切换不追溯已
 * 注册画布——Blockly 定义为注册期固化机制,见决策草稿)。
 */
const BLOCK_MESSAGE_KEYS: Readonly<
  Record<string, { readonly message: SmMessageKey; readonly tooltip: SmMessageKey }>
> = {
  [PAYLOAD_START_BLOCK_TYPE]: { message: "block.start.message", tooltip: "block.start.tooltip" },
  [PAYLOAD_WRITE_BYTES_TYPE]: { message: "block.writeBytes.message", tooltip: "block.writeBytes.tooltip" },
  [PAYLOAD_PUSH_TYPE]: { message: "block.push.message", tooltip: "block.push.tooltip" },
  [PAYLOAD_POP_TYPE]: { message: "block.pop.message", tooltip: "block.pop.tooltip" },
  [PAYLOAD_CALL_TYPE]: { message: "block.call.message", tooltip: "block.call.tooltip" },
  [PAYLOAD_RET_TYPE]: { message: "block.ret.message", tooltip: "block.ret.tooltip" },
  [PAYLOAD_STEP_TYPE]: { message: "block.step.message", tooltip: "block.step.tooltip" },
  [PAYLOAD_BREAKPOINT_TYPE]: { message: "block.breakpoint.message", tooltip: "block.breakpoint.tooltip" },
  [PAYLOAD_VAR_SET_TYPE]: { message: "block.varSet.message", tooltip: "block.varSet.tooltip" },
  [PAYLOAD_VAR_GET_TYPE]: { message: "block.varGet.message", tooltip: "block.varGet.tooltip" },
  [PAYLOAD_VAR_CHANGE_TYPE]: { message: "block.varChange.message", tooltip: "block.varChange.tooltip" },
  [PAYLOAD_LIST_PUSH_TYPE]: { message: "block.listPush.message", tooltip: "block.listPush.tooltip" },
  [PAYLOAD_LIST_GET_TYPE]: { message: "block.listGet.message", tooltip: "block.listGet.tooltip" },
  [PAYLOAD_LIST_LENGTH_TYPE]: { message: "block.listLength.message", tooltip: "block.listLength.tooltip" },
  [PAYLOAD_IF_TYPE]: { message: "block.if.message", tooltip: "block.if.tooltip" },
  [PAYLOAD_REPEAT_TYPE]: { message: "block.repeat.message", tooltip: "block.repeat.tooltip" },
  [PAYLOAD_FUNC_DEF_TYPE]: { message: "block.funcDef.message", tooltip: "block.funcDef.tooltip" },
  [PAYLOAD_FUNC_CALL_STMT_TYPE]: { message: "block.funcCallStmt.message", tooltip: "block.funcCallStmt.tooltip" },
  [PAYLOAD_FUNC_CALL_VALUE_TYPE]: { message: "block.funcCallValue.message", tooltip: "block.funcCallValue.tooltip" },
  [PAYLOAD_NUM_TYPE]: { message: "block.num.message", tooltip: "block.num.tooltip" },
  [PAYLOAD_TEXT_TYPE]: { message: "block.text.message", tooltip: "block.text.tooltip" },
  [PAYLOAD_ARITH_TYPE]: { message: "block.arith.message", tooltip: "block.arith.tooltip" },
  [PAYLOAD_COMPARE_TYPE]: { message: "block.compare.message", tooltip: "block.compare.tooltip" },
  [PAYLOAD_WRITE_STRING_TYPE]: { message: "block.writeString.message", tooltip: "block.writeString.tooltip" },
  [PAYLOAD_STRING_CONCAT_TYPE]: { message: "block.stringConcat.message", tooltip: "block.stringConcat.tooltip" },
  [PAYLOAD_STRING_LENGTH_TYPE]: { message: "block.stringLength.message", tooltip: "block.stringLength.tooltip" },
  [PAYLOAD_REGISTER_GET_TYPE]: { message: "block.registerGet.message", tooltip: "block.registerGet.tooltip" },
  [PAYLOAD_MEM_READ8_TYPE]: { message: "block.memRead8.message", tooltip: "block.memRead8.tooltip" },
  [PAYLOAD_MEM_READ_BYTE_TYPE]: { message: "block.memReadByte.message", tooltip: "block.memReadByte.tooltip" },
};

/** 工具箱分类名 i18n 键(分类 → 目录键)。 */
const CATEGORY_NAME_KEYS: Readonly<Record<string, SmMessageKey>> = {
  会话动作: "block.catSessionActions",
  变量: "block.catVars",
  列表: "block.catLists",
  分支: "block.catBranch",
  循环: "block.catLoop",
  函数: "block.catFunction",
  运算与赋值: "block.catArith",
  字符串: "block.catString",
  公开投影读取: "block.catProjection",
  断点: "block.catBreakpoint",
};

/**
 * 积木 JSON 定义(FE-PB-02 八类 + 会话动作 + 起始;tooltip 中文 = FE-PB-06)。
 * 本常量 = **zh-CN 快照**(模块加载时刻形态,与 i18n 目录一字不差;既有测试
 * 与公开 API 面消费);本地化注册形态见 `buildPayloadBlockDefinitions()`。
 * 经 `registerPayloadBlocks()` 幂等登记。
 */
export const PAYLOAD_BLOCK_DEFINITIONS: readonly Record<string, unknown>[] = [
  // —— 起始(唯一入口,不进工具箱)——
  {
    type: PAYLOAD_START_BLOCK_TYPE,
    message0: "🚩 Payload 开始",
    nextStatement: null,
    colour: 160,
    tooltip: "Payload 程序的唯一入口:执行从这里开始;每张画布只允许一个。",
  },
  // —— 会话动作类(12 动作教学映射;run_to_event 不暴露)——
  {
    type: PAYLOAD_WRITE_BYTES_TYPE,
    message0: "写字节到 %1 内容 %2",
    args0: [
      { type: "input_value", name: "ADDR", check: NUM },
      { type: "field_input", name: "BYTES", text: "41424344" },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 20,
    tooltip:
      "write_bytes 动作:把十六进制字节串(偶数长度)写到目标地址。地址可以是表达式。",
  },
  {
    type: PAYLOAD_PUSH_TYPE,
    message0: "压栈 %1",
    args0: [{ type: "input_value", name: "VALUE", check: NUM }],
    previousStatement: null,
    nextStatement: null,
    colour: 20,
    tooltip: "push 动作:把 64 位值压入栈(字节序语义由服务端按题目 VM Profile 决定)。",
  },
  {
    type: PAYLOAD_POP_TYPE,
    message0: "出栈",
    previousStatement: null,
    nextStatement: null,
    colour: 20,
    tooltip: "pop 动作:弹出栈顶值;弹出结果只在公开投影可见。",
  },
  {
    type: PAYLOAD_CALL_TYPE,
    message0: "调用 %1",
    args0: [{ type: "input_value", name: "TARGET", check: NUM }],
    previousStatement: null,
    nextStatement: null,
    colour: 20,
    tooltip: "call 动作:压入返回地址并跳转到目标地址(教学动作,非任意指令执行)。",
  },
  {
    type: PAYLOAD_RET_TYPE,
    message0: "返回",
    previousStatement: null,
    nextStatement: null,
    colour: 20,
    tooltip: "ret 动作:弹出栈顶值作为新 RIP;非法 RIP 会得到可解释错误。",
  },
  {
    type: PAYLOAD_STEP_TYPE,
    message0: "单步执行一条指令",
    previousStatement: null,
    nextStatement: null,
    colour: 20,
    tooltip: "step 动作:恰执行一条 VM 指令后暂停;可在积木序列中间插入观察状态。",
  },
  // —— 断点类(M7 变通:断点 = 步进暂停点)——
  {
    type: PAYLOAD_BREAKPOINT_TYPE,
    message0: "🔴 断点(暂停观察)",
    previousStatement: null,
    nextStatement: null,
    colour: 0,
    tooltip:
      "断点积木:步进执行到这里暂停,供观察内存/寄存器变化(客户端步进暂停点;不含服务端语义)。",
  },
  // —— 变量类(客户端求值)——
  {
    type: PAYLOAD_VAR_SET_TYPE,
    message0: "把变量 %1 设为 %2",
    args0: [
      { type: "field_input", name: "VAR", text: "x" },
      { type: "input_value", name: "VALUE" },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 260,
    tooltip: "变量赋值:在客户端编译期求值,不产生会话动作。",
  },
  {
    type: PAYLOAD_VAR_GET_TYPE,
    message0: "变量 %1",
    args0: [{ type: "field_input", name: "VAR", text: "x" }],
    output: null,
    colour: 260,
    tooltip: "读取变量(客户端编译期求值);读取未赋值变量会确定性报错。",
  },
  {
    type: PAYLOAD_VAR_CHANGE_TYPE,
    message0: "把变量 %1 %2 %3",
    args0: [
      { type: "field_input", name: "VAR", text: "x" },
      {
        type: "field_dropdown",
        name: "OP",
        options: [
          ["增加", "inc"],
          ["减少", "dec"],
        ],
      },
      { type: "input_value", name: "DELTA", check: NUM },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 260,
    tooltip: "变量增减(64 位无符号回绕;客户端编译期求值)。",
  },
  // —— 列表类(客户端求值;列表按名自动创建)——
  {
    type: PAYLOAD_LIST_PUSH_TYPE,
    message0: "向列表 %1 追加 %2",
    args0: [
      { type: "field_input", name: "LIST", text: "items" },
      { type: "input_value", name: "ITEM" },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 210,
    tooltip: "向具名列表追加元素;列表不存在时自动创建(客户端编译期求值)。",
  },
  {
    type: PAYLOAD_LIST_GET_TYPE,
    message0: "列表 %1 的第 %2 项",
    args0: [
      { type: "field_input", name: "LIST", text: "items" },
      { type: "input_value", name: "INDEX", check: NUM },
    ],
    output: null,
    colour: 210,
    tooltip: "按下标(0 起)取列表元素;越界或未知列表确定性报错。",
  },
  {
    type: PAYLOAD_LIST_LENGTH_TYPE,
    message0: "列表 %1 的长度",
    args0: [{ type: "field_input", name: "LIST", text: "items" }],
    output: NUM,
    colour: 210,
    tooltip: "列表长度(未知列表确定性报错)。",
  },
  // —— 分支类(编译期选支展开)——
  {
    type: PAYLOAD_IF_TYPE,
    message0: "如果 %1 那么 %2 否则 %3",
    args0: [
      { type: "input_value", name: "COND", check: BOOL },
      { type: "input_statement", name: "DO" },
      { type: "input_statement", name: "ELSE" },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 120,
    tooltip:
      "分支结构:条件在客户端编译期求值,只有被选中的分支展开为原子动作序列。",
  },
  // —— 循环类(编译期展开,受展开上限约束)——
  {
    type: PAYLOAD_REPEAT_TYPE,
    message0: "重复 %1 次 %2",
    args0: [
      { type: "input_value", name: "TIMES", check: NUM },
      { type: "input_statement", name: "DO" },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 120,
    tooltip:
      "循环结构:编译期展开为原子动作序列;展开总量受上限约束,超限确定性报错(防无限展开)。",
  },
  // —— 函数(模块化)类(编译期内联展开;有返回值)——
  {
    type: PAYLOAD_FUNC_DEF_TYPE,
    message0: "定义函数 %1 主体 %2 返回 %3",
    args0: [
      { type: "field_input", name: "NAME", text: "f" },
      { type: "input_statement", name: "BODY" },
      { type: "input_value", name: "RETURN" },
    ],
    nextStatement: null,
    colour: 290,
    tooltip:
      "定义具名函数(独立放在画布空白处,不连入主序列);调用时在编译期内联展开,可携带返回值。",
  },
  {
    type: PAYLOAD_FUNC_CALL_STMT_TYPE,
    message0: "调用函数 %1",
    args0: [{ type: "field_input", name: "NAME", text: "f" }],
    previousStatement: null,
    nextStatement: null,
    colour: 290,
    tooltip: "调用具名函数(忽略返回值):编译期内联展开函数主体。",
  },
  {
    type: PAYLOAD_FUNC_CALL_VALUE_TYPE,
    message0: "函数 %1 的返回值",
    args0: [{ type: "field_input", name: "NAME", text: "f" }],
    output: null,
    colour: 290,
    tooltip: "调用具名函数并取其返回值:编译期内联展开(递归受深度与展开上限约束)。",
  },
  // —— 运算与赋值类(客户端求值;64 位无符号回绕)——
  {
    type: PAYLOAD_NUM_TYPE,
    message0: "# %1",
    args0: [{ type: "field_input", name: "N", text: "0" }],
    output: NUM,
    colour: 60,
    tooltip: "数字字面量:非负十进制(如 42)或 0x 前缀十六进制(如 0x1000)。",
  },
  {
    type: PAYLOAD_TEXT_TYPE,
    message0: "“ %1 ”",
    args0: [{ type: "field_input", name: "TEXT", text: "hello" }],
    output: STR,
    colour: 60,
    tooltip: "字符串字面量;写字符串积木按 UTF-8 编码为字节。",
  },
  {
    type: PAYLOAD_ARITH_TYPE,
    message0: "%1 %2 %3",
    args0: [
      { type: "input_value", name: "A", check: NUM },
      {
        type: "field_dropdown",
        name: "OP",
        options: [
          ["+", "add"],
          ["−", "sub"],
          ["×", "mul"],
          ["÷", "div"],
          ["%", "mod"],
        ],
      },
      { type: "input_value", name: "B", check: NUM },
    ],
    output: NUM,
    colour: 60,
    tooltip: "算术运算(64 位无符号回绕;除零确定性报错)。",
  },
  {
    type: PAYLOAD_COMPARE_TYPE,
    message0: "%1 %2 %3",
    args0: [
      { type: "input_value", name: "A", check: NUM },
      {
        type: "field_dropdown",
        name: "OP",
        options: [
          ["=", "eq"],
          ["≠", "ne"],
          ["<", "lt"],
          ["≤", "le"],
          [">", "gt"],
          ["≥", "ge"],
        ],
      },
      { type: "input_value", name: "B", check: NUM },
    ],
    output: BOOL,
    colour: 60,
    tooltip: "数值比较(无符号 64 位),产出真/假供分支使用。",
  },
  // —— 字符串类(UTF-8 定案;写字符串 → write_bytes)——
  {
    type: PAYLOAD_WRITE_STRING_TYPE,
    message0: "写字符串 %1 到 %2",
    args0: [
      { type: "input_value", name: "STR", check: STR },
      { type: "input_value", name: "ADDR", check: NUM },
    ],
    previousStatement: null,
    nextStatement: null,
    colour: 300,
    tooltip:
      "把字符串按 UTF-8 编码写入目标地址(编译为 write_bytes 动作;公开档无编码表下发,UTF-8 为定案编码)。",
  },
  {
    type: PAYLOAD_STRING_CONCAT_TYPE,
    message0: "连接 %1 %2",
    args0: [
      { type: "input_value", name: "A", check: STR },
      { type: "input_value", name: "B", check: STR },
    ],
    output: STR,
    colour: 300,
    tooltip: "连接两个字符串(客户端编译期求值)。",
  },
  {
    type: PAYLOAD_STRING_LENGTH_TYPE,
    message0: "字符串 %1 的 UTF-8 字节数",
    args0: [{ type: "input_value", name: "S", check: STR }],
    output: NUM,
    colour: 300,
    tooltip: "字符串按 UTF-8 编码后的字节长度。",
  },
  // —— 公开投影读取(求值环境面)——
  {
    type: "payload_register_get",
    message0: "寄存器 %1",
    args0: [{ type: "field_input", name: "REG", text: "rsp" }],
    output: NUM,
    colour: 15,
    tooltip: "读取公开投影寄存器值(仅白名单寄存器;未公开寄存器确定性报错)。",
  },
  {
    type: "payload_mem_read8",
    message0: "读内存 8 字节(小端)%1",
    args0: [{ type: "input_value", name: "ADDR", check: NUM }],
    output: NUM,
    colour: 15,
    tooltip:
      "从公开投影已下发窗口读 8 字节并按小端组合为无符号值(端序定案同跳转链);窗口外确定性报错。",
  },
  {
    type: "payload_mem_read_byte",
    message0: "读内存单字节 %1",
    args0: [{ type: "input_value", name: "ADDR", check: NUM }],
    output: NUM,
    colour: 15,
    tooltip: "从公开投影已下发窗口读单字节(0–255);窗口外确定性报错。",
  },
];

// ── M10/WP-80 出题者积木动态注入面 ─────────────────────────────────────────
//
// 声明面形状 = 公开描述包可选顶层字段 `authorBlocks`(D-MP-6 定案;锚 =
// packages/challenge-schema 的公开 Schema)。vm-ui 是浏览器包,**不依赖
// challenge-schema**(依赖方向 5.5:vm-ui 只依赖 protocol),故此处以**本地
// 结构镜像类型**承载(challenge-descriptor.ts 的 `ChallengeDescriptorView`
// 同纪律),字段与公开 Schema 逐项同形。
//
// 注入纪律(缺省空 ⇒ 既有行为零变化):
//  - 未声明 `authorBlocks` / 声明为空数组 ⇒ 积木定义、工具箱分类、编译行为
//    **逐字不变**(回归护栏:既有 29 块与 10 个分类不动);
//  - 声明即在此之上**追加**动态积木(`payload_author_<id>`)与「题目积木」分类,
//    追加不改写既有定义;
//  - 动态积木只在**编译期**展开为 12 公开动作的原子序列(见 compile.ts),
//    不在浏览器里执行任何语义:动作仍经 `actionSink` 提交服务端串行执行。
//  - `interfaceId` 只用于**展示与开发生成**,不参与编译(接口效果语义整体
//    留在私有包);公开面不承载效果原语序列。

/** 出题者积木声明中的参数槽位(结构镜像;见公开 Schema authorBlocks[].slots)。 */
export interface PayloadAuthorBlockSlot {
  readonly key: string;
  readonly label: string;
  /** 形态:address / immediate / length(决定编译期取值转换)。 */
  readonly kind: string;
}

/** 积木动作参数位取值:字面量串或 `{ slot }` 槽位引用(两种形态互斥)。 */
export type PayloadAuthorBlockArgValue = string | { readonly slot: string };

/** 出题者积木声明中的单条动作(12 公开动作的子集)。 */
export interface PayloadAuthorBlockAction {
  readonly type: string;
  readonly args: Readonly<Record<string, PayloadAuthorBlockArgValue>>;
}

/** 出题者积木模板声明(结构镜像;见公开 Schema authorBlocks[])。 */
export interface PayloadAuthorBlockDecl {
  readonly id: string;
  readonly displayText: string;
  readonly interfaceId: number;
  readonly slots: readonly PayloadAuthorBlockSlot[];
  readonly actions: readonly PayloadAuthorBlockAction[];
}

/** 动态积木类型前缀(与内建 `payload_*` 类型同命名空间,`author_` 段隔离)。 */
export const PAYLOAD_AUTHOR_BLOCK_TYPE_PREFIX = "payload_author_";

/** 动态积木类型名(`payload_author_<id>`;id 由 Schema 冻结为小写标识符形态)。 */
export function authorBlockType(id: string): string {
  return `${PAYLOAD_AUTHOR_BLOCK_TYPE_PREFIX}${id}`;
}

/** 是否为动态(题目声明)积木类型。 */
export function isAuthorBlockType(type: string): boolean {
  return type.startsWith(PAYLOAD_AUTHOR_BLOCK_TYPE_PREFIX);
}

/** 动态积木类型 → 模板 id(非动态类型返回 null)。 */
export function authorBlockIdFromType(type: string): string | null {
  return isAuthorBlockType(type) ? type.slice(PAYLOAD_AUTHOR_BLOCK_TYPE_PREFIX.length) : null;
}

/** 槽位 key → Blockly 输入名(大写化;Schema 冻结小写标识符 ⇒ 单射无歧义)。 */
export function authorBlockSlotInputName(key: string): string {
  return `SLOT_${key.toUpperCase()}`;
}

/**
 * 动态积木定义(每个模板一块;槽位 = `input_value`(Number)= 参数表达式输入)。
 * 动态块进工具箱与画布,与内建块同连接形态(上/下语句连接),可任意插序。
 */
export function buildAuthorBlockDefinitions(
  authorBlocks: readonly PayloadAuthorBlockDecl[],
): Record<string, unknown>[] {
  return authorBlocks.map((block) => {
    const slotLabels = block.slots.map((slot, index) => `${slot.label} %${index + 1}`);
    const message0 =
      slotLabels.length === 0 ? block.displayText : `${block.displayText} ${slotLabels.join(" ")}`;
    return {
      type: authorBlockType(block.id),
      message0,
      args0: block.slots.map((slot) => ({
        type: "input_value",
        name: authorBlockSlotInputName(slot.key),
        check: NUM,
        align: "RIGHT",
      })),
      previousStatement: null,
      nextStatement: null,
      colour: 200,
      tooltip: t("block.authorBlock.tooltip", { name: block.displayText }),
    };
  });
}

/** 「题目积木」工具箱分类(无声明时返回 null = 不追加分类)。 */
export function buildAuthorBlockCategory(
  authorBlocks: readonly PayloadAuthorBlockDecl[],
): PayloadToolboxCategory | null {
  if (authorBlocks.length === 0) {
    return null;
  }
  return {
    kind: "category",
    name: t("block.catAuthorBlocks"),
    colour: "200",
    contents: authorBlocks.map((block) => ({
      kind: "block" as const,
      type: authorBlockType(block.id),
    })),
  };
}

/**
 * 按当前 locale 构建积木定义(message0 / tooltip 取词;zh-CN 下与常量同形)。
 *
 * M10/WP-80:可选 `authorBlocks` **追加**题目声明积木;缺省 / 空数组 ⇒
 * 返回值与既往逐字相同(既有内建定义零变化——回归护栏)。
 */
export function buildPayloadBlockDefinitions(
  authorBlocks: readonly PayloadAuthorBlockDecl[] = [],
): Record<string, unknown>[] {
  const builtin = PAYLOAD_BLOCK_DEFINITIONS.map((definition) => {
    const keys = BLOCK_MESSAGE_KEYS[String(definition.type)];
    if (keys === undefined) {
      return { ...definition };
    }
    const localized: Record<string, unknown> = {
      ...definition,
      message0: t(keys.message),
      tooltip: t(keys.tooltip),
    };
    // 变量增减积木的下拉选项(增加 / 减少)同样取词(其余下拉为符号,非文案)。
    if (String(definition.type) === PAYLOAD_VAR_CHANGE_TYPE) {
      const args0 = (localized.args0 as Record<string, unknown>[]) ?? [];
      localized.args0 = args0.map((arg) =>
        (arg as { name?: string }).name === "OP"
          ? {
              ...(arg as Record<string, unknown>),
              options: [
                [t("block.opInc"), "inc"],
                [t("block.opDec"), "dec"],
              ],
            }
          : arg,
      );
    }
    return localized;
  });
  if (authorBlocks.length === 0) {
    return builtin;
  }
  return [...builtin, ...buildAuthorBlockDefinitions(authorBlocks)];
}

/**
 * 按当前 locale 构建工具箱分类名单(zh-CN 下与常量同形)。
 * 声明了题目积木时在末尾**追加**「题目积木」分类(内建分类零变化)。
 */
export function buildPayloadToolboxCategories(
  authorBlocks: readonly PayloadAuthorBlockDecl[] = [],
): PayloadToolboxCategory[] {
  const builtin = PAYLOAD_TOOLBOX_CATEGORIES.map((category) => {
    const key = CATEGORY_NAME_KEYS[category.name];
    return { ...category, name: key !== undefined ? t(key) : category.name };
  });
  const authorCategory = buildAuthorBlockCategory(authorBlocks);
  return authorCategory === null ? builtin : [...builtin, authorCategory];
}

/** Blockly 工具箱定义(本地化构建形态;inject 时消费)。 */
export function buildPayloadToolbox(
  authorBlocks: readonly PayloadAuthorBlockDecl[] = [],
): { kind: "categoryToolbox"; contents: PayloadToolboxCategory[] } {
  return { kind: "categoryToolbox", contents: buildPayloadToolboxCategories(authorBlocks) };
}

/** 内建积木注册状态(幂等登记;进程内一次性)。 */
let blocksRegistered = false;

/** 已登记的动态积木类型(幂等登记面;内建块由 `blocksRegistered` 单独守护)。 */
const registeredAuthorBlockTypes = new Set<string>();

/**
 * 幂等登记全部积木定义(UI inject 前与编译器加载前都要调用)。
 * 文案按**首次注册时刻 locale** 固化(Blockly 定义机制;运行中切换不追溯,
 * 遗留登记见决策草稿)。
 *
 * M10/WP-80:`authorBlocks` 参数只**增量**登记尚未登记的动态积木类型——
 * 同一类型重复 `defineBlocksWithJsonArray` 会覆盖既有定义,故按类型去重;
 * 换绑不同题目的声明集时,先声明的类型保留(画布上已放置的积木不失效),
 * 新声明集的新增类型继续登记(幂等纪律维持)。
 */
export function registerPayloadBlocks(
  authorBlocks: readonly PayloadAuthorBlockDecl[] = [],
): void {
  if (!blocksRegistered) {
    Blockly.defineBlocksWithJsonArray(buildPayloadBlockDefinitions() as never);
    blocksRegistered = true;
  }
  const pending = authorBlocks.filter(
    (block) => !registeredAuthorBlockTypes.has(authorBlockType(block.id)),
  );
  if (pending.length === 0) {
    return;
  }
  Blockly.defineBlocksWithJsonArray(buildAuthorBlockDefinitions(pending) as never);
  for (const block of pending) {
    registeredAuthorBlockTypes.add(authorBlockType(block.id));
  }
}

/** 工具箱分类(中文分类名;起始积木不进工具箱——FE-PB-03 唯一预置)。 */
export interface PayloadToolboxCategory {
  readonly kind: "category";
  readonly name: string;
  readonly colour: string;
  readonly contents: readonly { readonly kind: "block"; readonly type: string }[];
}

/** 工具箱分类名单(FE-PB-02 八类 + 会话动作 + 公开投影读取)。 */
export const PAYLOAD_TOOLBOX_CATEGORIES: readonly PayloadToolboxCategory[] = [
  {
    kind: "category",
    name: "会话动作",
    colour: "20",
    contents: [
      PAYLOAD_WRITE_BYTES_TYPE,
      PAYLOAD_PUSH_TYPE,
      PAYLOAD_POP_TYPE,
      PAYLOAD_CALL_TYPE,
      PAYLOAD_RET_TYPE,
      PAYLOAD_STEP_TYPE,
    ].map((type) => ({ kind: "block" as const, type })),
  },
  {
    kind: "category",
    name: "变量",
    colour: "260",
    contents: [PAYLOAD_VAR_SET_TYPE, PAYLOAD_VAR_GET_TYPE, PAYLOAD_VAR_CHANGE_TYPE].map((type) => ({
      kind: "block" as const,
      type,
    })),
  },
  {
    kind: "category",
    name: "列表",
    colour: "210",
    contents: [PAYLOAD_LIST_PUSH_TYPE, PAYLOAD_LIST_GET_TYPE, PAYLOAD_LIST_LENGTH_TYPE].map(
      (type) => ({ kind: "block" as const, type }),
    ),
  },
  {
    kind: "category",
    name: "分支",
    colour: "120",
    contents: [{ kind: "block" as const, type: PAYLOAD_IF_TYPE }],
  },
  {
    kind: "category",
    name: "循环",
    colour: "120",
    contents: [{ kind: "block" as const, type: PAYLOAD_REPEAT_TYPE }],
  },
  {
    kind: "category",
    name: "函数",
    colour: "290",
    contents: [
      PAYLOAD_FUNC_DEF_TYPE,
      PAYLOAD_FUNC_CALL_STMT_TYPE,
      PAYLOAD_FUNC_CALL_VALUE_TYPE,
    ].map((type) => ({ kind: "block" as const, type })),
  },
  {
    kind: "category",
    name: "运算与赋值",
    colour: "60",
    contents: [PAYLOAD_NUM_TYPE, PAYLOAD_TEXT_TYPE, PAYLOAD_ARITH_TYPE, PAYLOAD_COMPARE_TYPE].map(
      (type) => ({ kind: "block" as const, type }),
    ),
  },
  {
    kind: "category",
    name: "字符串",
    colour: "300",
    contents: [
      PAYLOAD_WRITE_STRING_TYPE,
      PAYLOAD_STRING_CONCAT_TYPE,
      PAYLOAD_STRING_LENGTH_TYPE,
    ].map((type) => ({ kind: "block" as const, type })),
  },
  {
    kind: "category",
    name: "公开投影读取",
    colour: "15",
    contents: [
      { kind: "block" as const, type: PAYLOAD_REGISTER_GET_TYPE },
      { kind: "block" as const, type: PAYLOAD_MEM_READ8_TYPE },
      { kind: "block" as const, type: PAYLOAD_MEM_READ_BYTE_TYPE },
    ],
  },
  {
    kind: "category",
    name: "断点",
    colour: "0",
    contents: [{ kind: "block" as const, type: PAYLOAD_BREAKPOINT_TYPE }],
  },
];

/** Blockly 工具箱定义(inject 选项;分类工具箱)。 */
export const PAYLOAD_TOOLBOX = {
  kind: "categoryToolbox",
  contents: PAYLOAD_TOOLBOX_CATEGORIES,
} as const;

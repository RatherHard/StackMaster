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
 * 积木 JSON 定义(FE-PB-02 八类 + 会话动作 + 起始;tooltip 中文 = FE-PB-06)。
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

/** 积木类型 → 注册状态(幂等登记)。 */
let blocksRegistered = false;

/** 幂等登记全部积木定义(UI inject 前与编译器加载前都要调用)。 */
export function registerPayloadBlocks(): void {
  if (blocksRegistered) {
    return;
  }
  Blockly.defineBlocksWithJsonArray(PAYLOAD_BLOCK_DEFINITIONS as never);
  blocksRegistered = true;
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

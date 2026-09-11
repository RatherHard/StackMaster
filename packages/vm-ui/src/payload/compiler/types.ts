/**
 * Payload 编译器类型面(WP-F6 / FE-PB-01~03 / M7 / M8 / M9 变通口径)。
 *
 * 主控定案(Q3 积木步进粒度):
 *  - **原子动作粒度**:积木图编译为 12 动作原子动作序列,每个原子动作 = 一步;
 *    循环/分支的步进暂停只发生在原子动作边界;
 *  - 断点积木 = 步进暂停点(M7 变通口径:纯客户端编排,不走服务端断点);
 *  - 变量/运算/字符串操作在**客户端编译期求值**(求值环境 = 公开投影只读快照:
 *    寄存器名 → 值、地址 → 窗口内 bytesHex;未知引用确定性报错——这是 M9 的
 *    底线约束而非缺陷:隐藏数据天然不可用);
 *  - 循环/分支展开为原子动作序列,展开总量受 `PAYLOAD_MAX_EXPANDED_ACTIONS`
 *    上限约束,超限确定性报错(防无限展开 / 限流不可行);
 *  - payload 程序 = 动作编排,与 `submit` 裁决命令无关(submit 独立按钮/流程);
 *  - 执行受题目 `allowedActions` 裁剪(编译期:引用未授权动作的积木报错,
 *    UI 侧按 blockId 标红)与 D-API-50~53 限流约束(运行期,见 executor.ts)。
 *
 * 编译器是**纯逻辑**:输入为 Blockly workspace 序列化(JSON state),内部以
 * 无头 Blockly workspace 加载(不依赖 DOM 渲染;jsdom 下渲染受限,编译器
 * 测试全部走序列化 JSON)。
 */
import type { ActionObject } from "@stackmaster/protocol";

/** Blockly workspace 序列化形态(`Blockly.serialization.workspaces.save` 的产物)。 */
export interface BlocklySerializedState {
  readonly blocks?: {
    readonly languageVersion?: number;
    readonly blocks?: readonly BlocklySerializedBlockState[];
  };
  /** Blockly 变量模型(本编译器积木不使用 Blockly 变量;仅透传)。 */
  readonly variables?: readonly unknown[];
}

/** 序列化积木(本编译器只消费结构子集;字段以无头 Blockly 加载校验为准)。 */
export interface BlocklySerializedBlockState {
  readonly type: string;
  readonly id?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly next?: { readonly block?: BlocklySerializedBlockState };
  /** 起始积木保护面(唯一起始积木不可删除;FE-PB-03)。 */
  readonly deletable?: boolean;
  readonly movable?: boolean;
  /** 画布坐标(序列化往返保留)。 */
  readonly x?: number;
  readonly y?: number;
}

/** 编译产物步骤:动作步骤或断点标记(Q3:断点积木 = 步进暂停点,非动作)。 */
export type PayloadStep =
  | {
      readonly kind: "action";
      /** 12 动作形态的原子动作(照协议 ActionObject 一字不差)。 */
      readonly action: ActionObject;
      /** 积木摘要(悬停 / 程序时间线 / 执行日志用,中文)。 */
      readonly label: string;
      /** 来源积木 id(UI 标红 / 定位;编译器合成的步骤为 null)。 */
      readonly blockId: string | null;
    }
  | {
      readonly kind: "breakpoint";
      readonly label: string;
      readonly blockId: string | null;
    };

/** 编译产物:原子步骤序列(执行器按序逐步提交)。 */
export interface PayloadProgram {
  readonly steps: readonly PayloadStep[];
}

/** 编译错误(确定性报错;blockId 供 UI 标红,缺省 null = 结构性错误)。 */
export interface PayloadCompileError {
  /** 稳定错误码(测试与 UI 分支用)。 */
  readonly code: PayloadCompileErrorCode;
  /** 中文教学可解释文案。 */
  readonly message: string;
  readonly blockId: string | null;
}

/** 编译错误码集合。 */
export type PayloadCompileErrorCode =
  | "no_start_block"
  | "multiple_start_blocks"
  | "unknown_block_type"
  | "unauthorized_action"
  | "unknown_reference"
  | "type_mismatch"
  | "division_by_zero"
  | "invalid_field"
  | "missing_input"
  | "expansion_limit_exceeded"
  | "eval_limit_exceeded"
  | "call_depth_exceeded"
  | "misplaced_block"
  | "duplicate_definition"
  | "load_failed";

/** 编译结果:成功带程序,失败带错误列表(编译器不抛错——错误是值)。 */
export type CompilePayloadResult =
  | { readonly ok: true; readonly program: PayloadProgram }
  | { readonly ok: false; readonly errors: readonly PayloadCompileError[] };

/**
 * 客户端求值环境(M9):公开投影只读快照。寄存器名 → 值、地址 → 窗口内
 * 字节;未知引用 / 窗口外地址确定性报错(抛 `PayloadEvalError`)。
 */
export interface PayloadEvalEnvironment {
  /** 寄存器值(名称大小写不敏感;未公开寄存器确定性报错)。 */
  registerValue(name: string): bigint;
  /** 单字节(0–255;窗口外 / 未映射确定性报错)。 */
  byteAt(address: bigint): number;
  /** 连续 `count` 字节按小端组合为无符号值(端序定案 = 小端,同 WP-F4)。 */
  readBytesLittleEndian(address: bigint, count: number): bigint;
}

/** 单条编译选项。 */
export interface CompilePayloadOptions {
  /**
   * 题目 allowedActions 白名单(编译期裁剪:引用未授权动作的积木报错)。
   * 缺省 = 12 动作裁去 run_to_event(教学范围定案:run_to_event 不暴露)。
   */
  readonly allowedActions?: readonly string[];
  /** 求值环境(缺省 = 空环境:任何寄存器 / 内存引用确定性报错)。 */
  readonly environment?: PayloadEvalEnvironment;
}

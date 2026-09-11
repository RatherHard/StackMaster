/**
 * 标签页类型注册表(WP-F5 / FE-WS-01 / FE-MV-01,按 Q2 定案"四个独立标签页
 * 类型、可多开";WP-F8 扩充调试档与 ED 教学组件面)。
 *
 * 定案(主控已裁决):
 *  - 登记四类:**stack**(栈视图 = 字节视图 stack 形态)、**free**(自由视图 =
 *    字节视图 free 形态)、**registers**(寄存器视图)、**debug**(WP-F8 起 =
 *    **指令视图** `<sm-instruction-view>` 真工厂——FE-IN-01"替换 debug 占位的
 *    同时新增";解题模式下呈现调试模式引导空态);
 *  - **ED 教学组件标签页**(WP-F8 挂接,W9 F9 契约面):structure(结构视图)/
 *    call-stack(调用栈)/ memory-diff(内存 diff)/ timeline(时间线)/
 *    checkpoints(checkpoint)。组件属性由工作区组合根注入(#syncEdContents,
 *    duck-typing 约定同 dataSource / actionSink);
 *  - **可扩展结构**:新标签页类型经 `register()` 追加登记即可进入工作区
 *    「打开」菜单;类型键为开放 string,不封闭枚举;
 *  - **可多开**(FE-MV-01):同类型可开多个实例——注册表只描述"怎么创建",
 *    实例生命周期(排布/焦点/关闭)归工作区布局模型(workspace-model.ts)。
 *
 * 数据纪律:工厂上下文只携带 `MemoryDataSource` 接口(视图唯一依赖面),
 * 注册表自身不接触 SessionClient / ProjectionStore。
 */
import { SmByteTab } from "./byte-tab.js";
import { SmRegisterView } from "../views/register/sm-register-view.js";
import { SmPayloadTab } from "../payload/sm-payload-tab.js";
import { SmInstructionView } from "../views/instruction/sm-instruction-view.js";
import { SmStructureView } from "../views/ed/sm-structure-view.js";
import { SmCallStack } from "../views/ed/sm-call-stack.js";
import { SmMemoryDiff } from "../views/ed/sm-memory-diff.js";
import { SmTimeline } from "../views/ed/sm-timeline.js";
import { SmCheckpoints } from "../views/ed/sm-checkpoints.js";
import type { SmMessageKey } from "../i18n/i18n.js";
import type { MemoryDataSource } from "../datasource/types.js";

/** 已登记标签页类型键(公开四类;开放 string 供 WP-F6 payload 等追加)。 */
export type WorkspaceTabType = string;

/** 已登记类型键常量(WP-F5 四类 + WP-F6 payload + WP-F8 ED 组件面)。 */
export const STACK_TAB_TYPE: WorkspaceTabType = "stack";
export const FREE_TAB_TYPE: WorkspaceTabType = "free";
export const REGISTERS_TAB_TYPE: WorkspaceTabType = "registers";
/** 指令视图(调试档;WP-F8 起 = 原 debug 占位位的真工厂,FE-IN-01)。 */
export const DEBUG_TAB_TYPE: WorkspaceTabType = "debug";
/** Payload 搭建标签页(WP-F6 / FE-PB;积木 → 12 动作编译 + 步进执行)。 */
export const PAYLOAD_TAB_TYPE: WorkspaceTabType = "payload";
// WP-F8 ED 教学组件标签页(WP-F9 契约面的工作区挂接位)。
export const STRUCTURE_TAB_TYPE: WorkspaceTabType = "structure";
export const CALL_STACK_TAB_TYPE: WorkspaceTabType = "call-stack";
export const MEMORY_DIFF_TAB_TYPE: WorkspaceTabType = "memory-diff";
export const TIMELINE_TAB_TYPE: WorkspaceTabType = "timeline";
export const CHECKPOINTS_TAB_TYPE: WorkspaceTabType = "checkpoints";

/** 标签页内容工厂上下文:视图组件只经 MemoryDataSource 接口消费投影。 */
export interface WorkspaceTabFactoryContext {
  readonly dataSource: MemoryDataSource | null;
}

/** 标签页类型描述(注册表条目)。 */
export interface WorkspaceTabTypeDescriptor {
  /** 类型键(稳定 id;开放集合,登记即扩展)。 */
  readonly type: WorkspaceTabType;
  /** 展示名(菜单项与标签页标题基名;模块加载时刻的静态快照)。 */
  readonly label: string;
  /**
   * 展示名 i18n 键(WP-53;可缺省):登记后菜单项按**当前 locale** 取词
   * (渲染时解析,语言切换即生效);缺省回落 `label`。标签页标题在打开
   * 时刻求值固化(打开后不随切换追溯——登记于决策草稿)。
   */
  readonly labelKey?: SmMessageKey;
  /**
   * 内容工厂:返回该标签页的内容元素。缺席 = **占位类型**(如 debug):
   * 工作区呈现 `placeholderNote` 空态,不创建内容元素。
   */
  readonly createContent?: (context: WorkspaceTabFactoryContext) => HTMLElement;
  /** 占位类型的空态文案(createContent 缺席时呈现)。 */
  readonly placeholderNote?: string;
}

/**
 * 标签页类型注册表:登记 → 枚举 → 工厂调用的最小扩展点。
 * 同名重复登记 = 覆盖更新(保持登记序位置),供宿主替换工厂或文案。
 */
export class WorkspaceTabTypeRegistry {
  readonly #descriptors = new Map<WorkspaceTabType, WorkspaceTabTypeDescriptor>();

  /** 登记 / 覆盖一个标签页类型(Map 保序:首登定位,覆盖不改变位置)。 */
  register(descriptor: WorkspaceTabTypeDescriptor): void {
    this.#descriptors.set(descriptor.type, descriptor);
  }

  /** 按类型键取描述;未登记返回 undefined。 */
  get(type: WorkspaceTabType): WorkspaceTabTypeDescriptor | undefined {
    return this.#descriptors.get(type);
  }

  /** 是否已登记(占位类型同样计为已登记)。 */
  has(type: WorkspaceTabType): boolean {
    return this.#descriptors.has(type);
  }

  /** 是否携带内容工厂(占位类型为 false → 工作区呈现空态)。 */
  hasFactory(type: WorkspaceTabType): boolean {
    return this.#descriptors.get(type)?.createContent !== undefined;
  }

  /** 全部登记项(登记序)。 */
  list(): readonly WorkspaceTabTypeDescriptor[] {
    return [...this.#descriptors.values()];
  }
}
/**
 * 默认注册表工厂:登记 WP-F5 四类(stack / free / registers 带工厂,debug =
 * WP-F8 指令视图真工厂)+ WP-F6 payload + WP-F8 ED 组件面五类。
 * 每次调用产生独立实例(测试隔离);生产单例见 `defaultTabTypeRegistry`。
 */
export function createDefaultTabTypeRegistry(): WorkspaceTabTypeRegistry {
  const registry = new WorkspaceTabTypeRegistry();
  // 栈视图 / 自由视图共用 <sm-byte-tab>(字节视图 + VMA 侧栏的组合页),
  // 仅 viewKind 不同(F3 定案:两视图共用默认形态,view-kind 只决定标题)。
  registry.register({
    type: STACK_TAB_TYPE,
    label: "栈视图",
    labelKey: "tab.stack",
    createContent: ({ dataSource }) => {
      const element = new SmByteTab();
      element.viewKind = "stack";
      element.dataSource = dataSource;
      return element;
    },
  });
  registry.register({
    type: FREE_TAB_TYPE,
    label: "自由视图",
    labelKey: "tab.free",
    createContent: ({ dataSource }) => {
      const element = new SmByteTab();
      element.viewKind = "free";
      element.dataSource = dataSource;
      return element;
    },
  });
  registry.register({
    type: REGISTERS_TAB_TYPE,
    label: "寄存器视图",
    labelKey: "tab.registers",
    createContent: ({ dataSource }) => {
      const element = new SmRegisterView();
      element.dataSource = dataSource;
      return element;
    },
  });
  // Payload 搭建(WP-F6 / FE-PB-01~03/05/06):积木画布 + 程序区 + 输出区;
  // 内容元素实现 refresh?()(投影更新 → 重建求值环境重编译)与可赋值
  // dataSource 属性(workspace 约定);动作提交面(actionSink)由工作区
  // 组合根按同一约定注入(FE-WS-04b「积木步进」经工作区菜单驱动);
  // FE-WS-07(F8):payload 元素状态跨模式共用(标签页不销毁即保留)。
  registry.register({
    type: PAYLOAD_TAB_TYPE,
    label: "Payload 搭建",
    labelKey: "tab.payload",
    createContent: ({ dataSource }) => {
      const element = new SmPayloadTab();
      element.dataSource = dataSource;
      return element;
    },
  });
  // 指令视图(WP-F8 / FE-IN-01~08):替换 F5 的 debug 占位为真工厂——伪指令
  // 流三段布局 / 函数表 / rip 锚点 / 检索双入口 / 行断点;数据源 = 调试档
  // (DebugDataSource),解题模式下呈现调试模式引导空态。
  registry.register({
    type: DEBUG_TAB_TYPE,
    label: "指令视图",
    labelKey: "tab.instruction",
    createContent: ({ dataSource }) => {
      const element = new SmInstructionView();
      element.dataSource = dataSource;
      return element;
    },
  });
  // ED 教学组件面(WP-F9 契约 × WP-F8 挂接):属性全部由工作区组合根
  // (#syncEdContents)注入公开投影 / 账本切面;组件自身零 client 依赖。
  registry.register({
    type: STRUCTURE_TAB_TYPE,
    label: "结构视图",
    labelKey: "tab.structure",
    createContent: () => new SmStructureView(),
  });
  registry.register({
    type: CALL_STACK_TAB_TYPE,
    label: "调用栈",
    labelKey: "tab.callStack",
    createContent: () => new SmCallStack(),
  });
  registry.register({
    type: MEMORY_DIFF_TAB_TYPE,
    label: "内存 diff",
    labelKey: "tab.memoryDiff",
    createContent: () => new SmMemoryDiff(),
  });
  registry.register({
    type: TIMELINE_TAB_TYPE,
    label: "时间线",
    labelKey: "tab.timeline",
    createContent: () => new SmTimeline(),
  });
  registry.register({
    type: CHECKPOINTS_TAB_TYPE,
    label: "checkpoint",
    labelKey: "tab.checkpoints",
    createContent: () => new SmCheckpoints(),
  });
  return registry;
}

/** 生产默认注册表单例(sm-workspace 缺省消费;WP-F6 向其追加 payload 类型)。 */
export const defaultTabTypeRegistry: WorkspaceTabTypeRegistry = createDefaultTabTypeRegistry();

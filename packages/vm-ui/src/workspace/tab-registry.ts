/**
 * 标签页类型注册表(WP-F5 / FE-WS-01 / FE-MV-01,按 Q2 定案"四个独立标签页
 * 类型、可多开")。
 *
 * 定案(主控已裁决):
 *  - 登记四类:**stack**(栈视图 = 字节视图 stack 形态)、**free**(自由视图 =
 *    字节视图 free 形态)、**registers**(寄存器视图)、**debug**(调试——
 *    **登记占位不实现**):注册存在(菜单可扩展性的体现),但无内容工厂,
 *    选中呈现"调试模式档由 WP-F8 提供"空态;解题/调试模式切换 UI 归 WP-F8,
 *    本工作区只在菜单保留挂点注释(见 sm-workspace-menu.ts)。
 *  - **可扩展结构**:WP-F6 的 payload 标签页经 `register()` 追加登记即可进入
 *    工作区「打开」菜单;类型键为开放 string,不封闭枚举。
 *  - **可多开**(FE-MV-01):同类型可开多个实例——注册表只描述"怎么创建",
 *    实例生命周期(排布/焦点/关闭)归工作区布局模型(workspace-model.ts)。
 *
 * 数据纪律:工厂上下文只携带 `MemoryDataSource` 接口(视图唯一依赖面),
 * 注册表自身不接触 SessionClient / ProjectionStore。
 */
import { SmByteTab } from "./byte-tab.js";
import { SmRegisterView } from "../views/register/sm-register-view.js";
import { SmPayloadTab } from "../payload/sm-payload-tab.js";
import type { MemoryDataSource } from "../datasource/types.js";

/** 已登记标签页类型键(公开四类;开放 string 供 WP-F6 payload 等追加)。 */
export type WorkspaceTabType = string;

/** 已登记类型键常量(WP-F5 四类 + WP-F6 payload)。 */
export const STACK_TAB_TYPE: WorkspaceTabType = "stack";
export const FREE_TAB_TYPE: WorkspaceTabType = "free";
export const REGISTERS_TAB_TYPE: WorkspaceTabType = "registers";
export const DEBUG_TAB_TYPE: WorkspaceTabType = "debug";
/** Payload 搭建标签页(WP-F6 / FE-PB;积木 → 12 动作编译 + 步进执行)。 */
export const PAYLOAD_TAB_TYPE: WorkspaceTabType = "payload";

/** 标签页内容工厂上下文:视图组件只经 MemoryDataSource 接口消费投影。 */
export interface WorkspaceTabFactoryContext {
  readonly dataSource: MemoryDataSource | null;
}

/** 标签页类型描述(注册表条目)。 */
export interface WorkspaceTabTypeDescriptor {
  /** 类型键(稳定 id;开放集合,登记即扩展)。 */
  readonly type: WorkspaceTabType;
  /** 展示名(菜单项与标签页标题基名)。 */
  readonly label: string;
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
 * 默认注册表工厂:登记 WP-F5 四类(stack / free / registers 带工厂,
 * debug 仅占位)。每次调用产生独立实例(测试隔离);生产单例见
 * `defaultTabTypeRegistry`。
 */
export function createDefaultTabTypeRegistry(): WorkspaceTabTypeRegistry {
  const registry = new WorkspaceTabTypeRegistry();
  // 栈视图 / 自由视图共用 <sm-byte-tab>(字节视图 + VMA 侧栏的组合页),
  // 仅 viewKind 不同(F3 定案:两视图共用默认形态,view-kind 只决定标题)。
  registry.register({
    type: STACK_TAB_TYPE,
    label: "栈视图",
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
    createContent: ({ dataSource }) => {
      const element = new SmRegisterView();
      element.dataSource = dataSource;
      return element;
    },
  });
  // Payload 搭建(WP-F6 / FE-PB-01~03/05/06):积木画布 + 程序区 + 输出区;
  // 内容元素实现 refresh?()(投影更新 → 重建求值环境重编译)与可赋值
  // dataSource 属性(workspace 约定);动作提交面(actionSink)由工作区
  // 组合根按同一约定注入(FE-WS-04b「积木步进」经工作区菜单驱动)。
  registry.register({
    type: PAYLOAD_TAB_TYPE,
    label: "Payload 搭建",
    createContent: ({ dataSource }) => {
      const element = new SmPayloadTab();
      element.dataSource = dataSource;
      return element;
    },
  });
  // 调试类型:**登记占位不实现**(主控定案)——注册存在但无工厂,选中呈现
  // 空态;指令视图 / 断点 / 模式切换 UI 归 WP-F8(FE-IN 系 + FE-WS-06/07)。
  registry.register({
    type: DEBUG_TAB_TYPE,
    label: "调试",
    placeholderNote: "调试模式档由 WP-F8 提供",
  });
  return registry;
}

/** 生产默认注册表单例(sm-workspace 缺省消费;WP-F6 向其追加 payload 类型)。 */
export const defaultTabTypeRegistry: WorkspaceTabTypeRegistry = createDefaultTabTypeRegistry();

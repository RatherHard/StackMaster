/**
 * vm-ui 构建产物的**运行期**加载面(分发改版 WP-92)。
 *
 * ## 为什么是动态 URL import,而不是静态 import
 *
 * `tooling/dependency-cruiser.cjs` 的 `no-backend-dependency-on-browser-packages`
 * 禁止 `apps/**` 静态依赖浏览器可达包(vm-ui 等)。这是**安全边界**,不是风格
 * 偏好:浏览器包的机制面不得进服务端可达的构建图。`apps/plugin-dev` 的既有
 * 做法(publicDir 提供 dist + 运行期按 URL import)即为本约束下的既有形态,
 * 本模块沿用同一形态(见 `vite.config.ts` 文件头 §2)。
 *
 * ## 因此本模块**只**做三件事
 *
 *  1. 按 URL 取回 vm-ui 产物模块;
 *  2. **形状校验**(缺 `SessionClient` / `fetchChallengeDescriptor` 即失败)——
 *     产物版本漂移时给一条可操作的提示,而不是在后续某行抛 `undefined is not
 *     a constructor`;
 *  3. 把模块面收窄成 page-app 真正消费的那几个成员(本文件是唯一的类型接缝)。
 *
 * `import()` 的参数是**变量**(带 `@vite-ignore` 注解)⇒ 打包器不做静态解析,
 * 不产生依赖边;资源本身由 publicDir 从 `packages/vm-ui/dist` 整目录拷贝到
 * `/vm-ui/`。
 */

/** vm-ui 产物 URL(同源静态资源;变量间接引用避免打包器解析)。 */
export const VM_UI_MODULE_URL = "/vm-ui/index.js";

/** `<sm-workspace>` 自定义元素标签(vm-ui 产物加载即注册)。 */
export const WORKSPACE_ELEMENT_TAG = "sm-workspace";

/** 题目导航信息(与契约 `CreateSessionRequestPayload` 同形)。 */
export interface LaunchIdentityLike {
  readonly challengeId: string;
  readonly challengeVersion: string;
}

/** 加载结果面(成功 / 失败原因;原因码不进玩家可见 DOM 的调试位以外)。 */
export type VmUiModuleOutcome =
  | { readonly ok: true; readonly module: VmUiModule }
  | { readonly ok: false; readonly reason: VmUiModuleFailureReason };

/** 失败原因(确定性码;文案在引导层组装)。 */
export type VmUiModuleFailureReason =
  /** 产物取不回(未构建 vm-ui 就先起服务 / 部署漏了 /vm-ui/ 目录)。 */
  | "module-unreachable"
  /** 取回了但形状不对(产物版本漂移)。 */
  | "module-shape-drift";

/**
 * page-app 消费的 vm-ui 面(**结构类型**,不 import vm-ui 的类型)。
 *
 * 这一层刻意写成结构类型:page-app 与 vm-ui 之间**没有 TypeScript 依赖边**,
 * 两边靠「同一份产物契约」对接——形状不符在运行期由 `isVmUiModuleLike` 拦下。
 */
export interface SessionClientLike {
  createSession(identity: LaunchIdentityLike): Promise<unknown>;
  connect(): void;
  readonly sessionId: string | null;
}

/** 描述包加载结果(vm-ui `ChallengeDescriptorOutcome` 的结构镜像)。 */
export type DescriptorOutcomeLike =
  | { readonly ok: true; readonly descriptor: unknown }
  | { readonly ok: false; readonly reason: string };

/** vm-ui 产物消费面。 */
export interface VmUiModule {
  readonly SessionClient: new () => SessionClientLike;
  readonly fetchChallengeDescriptor: (input: {
    readonly sessionApiOrigin: string;
    readonly challengeId: string;
    readonly challengeVersion: string;
  }) => Promise<DescriptorOutcomeLike>;
}

/** 结构闸:产物是否具备本应用消费的全部成员(缺一即 shape-drift)。 */
export function isVmUiModuleLike(value: unknown): value is VmUiModule {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["SessionClient"] === "function" &&
    typeof candidate["fetchChallengeDescriptor"] === "function"
  );
}

/** 缺省加载器:同源 URL 动态 import(变量型 ⇒ 不进构建图)。 */
export async function loadVmUiModule(
  url: string = VM_UI_MODULE_URL,
): Promise<VmUiModuleOutcome> {
  let namespace: unknown;
  try {
    namespace = await import(/* @vite-ignore */ url);
  } catch {
    return { ok: false, reason: "module-unreachable" };
  }
  if (!isVmUiModuleLike(namespace)) {
    return { ok: false, reason: "module-shape-drift" };
  }
  return { ok: true, module: namespace };
}

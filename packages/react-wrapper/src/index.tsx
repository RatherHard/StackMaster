/**
 * @stackmaster/react-wrapper —— embed-runtime 的 React 薄封装(WP-51)。
 *
 * 依赖纪律(CLAUDE.md 5.5 / dependency-cruiser):本包是浏览器可达包,
 * 允许依赖 @stackmaster/embed-runtime(WP-51 收紧的唯一放行横向边)与
 * react(peerDependency);零业务逻辑——协议面(握手 / V-1~V-13 / 重载 /
 * port 交付)全部在 embed-runtime,本包只做组件挂接与 props/handle 透传。
 *
 * <EmbedFrame> —— 组件本体(形态纪律:无业务逻辑,全部协议逻辑在
 * embed-runtime core;本组件只做——
 *  1. 挂载时 createEmbedSession(props 即 createEmbedSession 参数面)+ 挂接
 *     iframe + 以 SDK 的 buildIframeSrc() 设置 src(fragment 只放 esid);
 *  2. iframe load → notifyIframeLoad(T_handshake 启动);
 *  3. SDK 事件 → onXxx 回调(props 事件面);
 *  4. 卸载 dispose;reload 经 handle 触发时同步更新 iframe src(新 esid)。
 *
 * 会话生命周期 = 组件生命周期(每次挂载创建一个会话);构造选项只在挂载时
 * 消费一次,运行时外观 / 凭证 / 重载一律走 ref handle 命令面(Thin wrapper:
 * 变更 props 不会重建会话,需要重建时由宿主以 key 重挂)。
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, type CSSProperties } from "react";
import {
  createEmbedSession,
  EMBED_SESSION_EVENTS,
  type EmbedHandshakeCompleteDetail,
  type EmbedHeightChangedDetail,
  type EmbedReloadInitiatedDetail,
  type EmbedSession,
  type EmbedSessionOptions,
  type EmbedSessionState,
  type EmbedSessionUnavailableDetail,
  type EmbedTheme,
  type EmbedViolationCountersChangedDetail,
} from "@stackmaster/embed-runtime";

/** 事件回调 props(与 SDK 事件一一对应)。 */
export interface EmbedFrameEventCallbacks {
  /** 握手完成(ready 已发出)。 */
  readonly onHandshakeComplete?: (detail: EmbedHandshakeCompleteDetail) => void;
  /** 会话不可用(超时 / 版本失败 / dispose)。 */
  readonly onSessionUnavailable?: (detail: EmbedSessionUnavailableDetail) => void;
  /** 违规计数面变化(V-12 宿主本地面)。 */
  readonly onViolationCountersChanged?: (detail: EmbedViolationCountersChangedDetail) => void;
  /** 插件高度上报(已过 V-7/V-8/V-10;宿主据此设置 iframe 高度)。 */
  readonly onHeightChanged?: (detail: EmbedHeightChangedDetail) => void;
}

export interface EmbedFrameProps extends EmbedSessionOptions, EmbedFrameEventCallbacks {
  /** iframe 无障碍标题(必填;第十章语义化 DOM 纪律)。 */
  readonly title: string;
  /** iframe 的 data-testid(E2E 选择器锚)。 */
  readonly testId?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  /** iframe sandbox 属性(原样透传;opaque 形态 = "allow-scripts")。 */
  readonly sandbox?: string;
}

/** 命令式 handle(ref 命令面;全部转发 embed-runtime core)。 */
export interface EmbedFrameHandle {
  /** iframe 重载(§4.5):新 esid、旧值作废、重走握手;iframe src 同步更新。 */
  reload(): EmbedReloadInitiatedDetail;
  /** 经 MessageChannel port 下发凭证(D-API-75 备用通道;port 转移为前置)。 */
  deliverTokenViaPort(token: string): void;
  /** 主题切换(仅 theme 已授予;V-10 超限返回 false)。 */
  sendThemeChanged(theme: EmbedTheme): boolean;
  /** 语言切换(仅 language 已授予;V-10 超限返回 false)。 */
  sendLanguageChanged(language: string): boolean;
  readonly embedSessionId: string | null;
  readonly state: EmbedSessionState | null;
  readonly violationCounters: Readonly<Record<string, number>>;
  /** 底层会话实例(只读透传;未挂载为 null)。 */
  readonly session: EmbedSession | null;
}

type EventBinding = readonly [name: string, listener: (event: Event) => void];

export const EmbedFrame = forwardRef<EmbedFrameHandle, EmbedFrameProps>(function EmbedFrame(
  props,
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const sessionRef = useRef<EmbedSession | null>(null);
  // 最新 props 经 ref 供 effect / handle 读取(会话只在挂载时创建一次)。
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const iframe = iframeRef.current;
    if (iframe === null) return;
    const options = propsRef.current;
    const session = createEmbedSession(options);
    sessionRef.current = session;
    session.attachIframe(iframe);
    // src 只经 SDK 构造(fragment 只放 esid;硬门槛 V-13)。
    iframe.src = session.buildIframeSrc();

    const onLoad = (): void => {
      session.notifyIframeLoad();
    };
    iframe.addEventListener("load", onLoad);

    const callbacks = (): EmbedFrameEventCallbacks => propsRef.current;
    const bindings: readonly EventBinding[] = [
      [
        EMBED_SESSION_EVENTS.handshakeComplete,
        (event) => callbacks().onHandshakeComplete?.((event as CustomEvent<EmbedHandshakeCompleteDetail>).detail),
      ],
      [
        EMBED_SESSION_EVENTS.sessionUnavailable,
        (event) => callbacks().onSessionUnavailable?.((event as CustomEvent<EmbedSessionUnavailableDetail>).detail),
      ],
      [
        EMBED_SESSION_EVENTS.violationCountersChanged,
        (event) =>
          callbacks().onViolationCountersChanged?.(
            (event as CustomEvent<EmbedViolationCountersChangedDetail>).detail,
          ),
      ],
      [
        EMBED_SESSION_EVENTS.heightChanged,
        (event) => callbacks().onHeightChanged?.((event as CustomEvent<EmbedHeightChangedDetail>).detail),
      ],
    ];
    for (const [name, listener] of bindings) session.addEventListener(name, listener);

    return () => {
      iframe.removeEventListener("load", onLoad);
      for (const [name, listener] of bindings) session.removeEventListener(name, listener);
      session.dispose();
      sessionRef.current = null;
    };
    // 会话 = 组件生命周期;props 变更不经此处(见文件头纪律:构造选项只在
    // 挂载时消费,运行时变更走 handle 命令面)。
  }, []);

  useImperativeHandle(
    ref,
    (): EmbedFrameHandle => ({
      reload(): EmbedReloadInitiatedDetail {
        const session = sessionRef.current;
        const iframe = iframeRef.current;
        if (session === null || iframe === null) {
          throw new Error("EmbedFrame 未挂载:reload 不可用");
        }
        const detail = session.reload();
        iframe.src = detail.iframeSrc;
        return detail;
      },
      deliverTokenViaPort(token: string): void {
        sessionRef.current?.deliverTokenViaPort(token);
      },
      sendThemeChanged(theme: EmbedTheme): boolean {
        return sessionRef.current?.sendThemeChanged(theme) ?? false;
      },
      sendLanguageChanged(language: string): boolean {
        return sessionRef.current?.sendLanguageChanged(language) ?? false;
      },
      get embedSessionId(): string | null {
        return sessionRef.current?.getEmbedSessionId() ?? null;
      },
      get state(): EmbedSessionState | null {
        return sessionRef.current?.getState() ?? null;
      },
      get violationCounters(): Readonly<Record<string, number>> {
        return sessionRef.current?.getViolationCounters() ?? {};
      },
      get session(): EmbedSession | null {
        return sessionRef.current;
      },
    }),
    [],
  );

  return (
    <iframe
      ref={iframeRef}
      title={props.title}
      data-testid={props.testId}
      className={props.className}
      style={props.style}
      sandbox={props.sandbox}
    />
  );
});

export default EmbedFrame;

/**
 * WSS 通道客户端(Compose 拓扑集成测试专用;WP-7)。
 *
 * 载体:Node ≥ 22 全局 WebSocket(undici,支持非标准 `headers` 握手选项)——
 * 会话凭证只经 Cookie 呈递(D-API-12),浏览器式 WebSocket 不支持自定义
 * 握手头,undici 的 headers 选项补足这一点且保持 RFC 6455 语义
 * (自动掩码 / 自动 pong / close 帧),零额外依赖。
 */

export interface WssClientOptions {
  /** 完整 ws(s) URL,如 ws://127.0.0.1:13000/sessions/channel。 */
  readonly url: string;
  /** 会话凭证 Cookie(`name=value` 形态)。 */
  readonly cookie: string;
}

export class WssChannelClient {
  readonly messages: string[] = [];
  readonly closes: { code: number }[] = [];

  readonly #ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      this.messages.push(String(event.data));
    });
    ws.addEventListener("close", (event) => {
      this.closes.push({ code: event.code });
    });
  }

  /** 建立升级连接(Cookie 呈递会话凭证);失败(非 101)即抛错。 */
  static async connect(options: WssClientOptions): Promise<WssChannelClient> {
    const ws = new WebSocket(options.url, {
      headers: { cookie: options.cookie },
    } as unknown as string[]);
    const opened = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket 握手超时")), 10_000);
      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket 升级失败(认证或传输层拒绝)"));
      }, { once: true });
    });
    await opened;
    return new WssChannelClient(ws);
  }

  /** 发送文本帧(undici 自动掩码)。 */
  sendText(text: string): void {
    this.#ws.send(text);
  }

  /** 等待消息条件成立(文本帧;JSON 解析由调用方承担)。 */
  async waitFor(predicate: (messages: readonly string[]) => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.messages)) {
      if (Date.now() > deadline) {
        throw new Error("等待 WebSocket 消息超时");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** 客户端主动关闭。 */
  close(code = 1000): void {
    try {
      this.#ws.close(code);
    } catch {
      // 已关闭形态忽略。
    }
  }
}

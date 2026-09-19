/**
 * WP-7 测试装配台(ZR-T 篡改矩阵与 13.3 条目测试共用)。
 *
 * 复用 routes/helpers/session-rig.ts 的内存同构运行时(真实路由 / 错误映射 /
 * 冻结 Schema 校验 + 假 worker);本文件只补齐 WSS 帧客户端与连接装配,
 * 避免在多个 WP-7 套件间复制帧构造细节。
 */

import { vi, expect } from "vitest";
import { SESSION_ACTION_PROTOCOL_VERSION, type WssFrame } from "@stackmaster/protocol";

import {
  buildSessionTestRig,
  type SessionRigOptions,
  type SessionTestRig,
} from "../../routes/helpers/session-rig.js";

/** WSS 客户端帧收集器(线上到达序;等待条件成立或超时)。 */
export class WssFrameCollector {
  readonly frames: WssFrame[] = [];
  readonly closes: { code: number }[] = [];

  attach(client: Awaited<ReturnType<SessionTestRig["connectChannel"]>>): void {
    client.on("message", (data: Buffer) => {
      this.frames.push(JSON.parse(data.toString("utf8")) as WssFrame);
    });
    client.on("close", (code: number) => {
      this.closes.push({ code });
    });
  }

  async waitFor(
    predicate: (frames: readonly WssFrame[]) => boolean,
    timeoutMs = 5000,
  ): Promise<void> {
    await vi.waitFor(
      () => {
        if (!predicate(this.frames)) {
          throw new Error("等待出站帧条件超时");
        }
      },
      { timeout: timeoutMs, interval: 10 },
    );
  }
}

/**
 * 入站动作帧构造(冻结信封;额外字段用于篡改矩阵的 strictObject 红灯)。
 *
 * **2026-09-19(WP-96)**:帧与载荷的 `protocolVersion` 一律取
 * `SESSION_ACTION_PROTOCOL_VERSION`。此前本助手写死 `1` —— 那是 v2 落地后
 * N-1 窗口期的合法形态,窗口关闭后 v1 帧会被通道以 unsupported version
 * 确定性拒绝(本助手的所有用例都会退化成"每帧一个错误帧")。
 */
export function actionFrame(input: {
  sessionId: string;
  seq: number;
  clientSeq?: number;
  baseRevision?: number;
  idempotencyKey: string;
  actionType?: "pause" | "write_bytes" | "step" | "undo" | "create_checkpoint" | "checkout_checkpoint" | "reset";
  bytesHex?: string;
  requestId?: string;
  extraPayloadFields?: Record<string, unknown>;
}): Record<string, unknown> {
  const actionType = input.actionType ?? "step";
  return {
    protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
    type: "action",
    sessionId: input.sessionId,
    seq: input.seq,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    payload: {
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
      sessionId: input.sessionId,
      clientSeq: input.clientSeq ?? input.seq,
      baseRevision: input.baseRevision ?? 0,
      idempotencyKey: input.idempotencyKey,
      action:
        actionType === "write_bytes"
          ? { type: "write_bytes", args: { addressHex: "0x401000", bytesHex: input.bytesHex ?? "aa" } }
          : { type: actionType, args: {} },
      ...input.extraPayloadFields,
    },
  };
}

/** 发送帧(JSON 文本)。 */
export function sendFrame(
  client: Awaited<ReturnType<SessionTestRig["connectChannel"]>>,
  frame: Record<string, unknown>,
): void {
  client.send(JSON.stringify(frame));
}

export interface ConnectedStack {
  readonly rig: SessionTestRig;
  readonly sessionId: string;
  readonly cookie: string;
  readonly client: Awaited<ReturnType<SessionTestRig["connectChannel"]>>;
  readonly collector: WssFrameCollector;
}

/** rig + 已注册题目 + 会话 + 凭证 + 已连接 WSS 通道的一次性装配。 */
export async function createConnectedStack(
  options: SessionRigOptions = {},
): Promise<ConnectedStack> {
  const rig = await buildSessionTestRig(options);
  await rig.registerChallenge();
  const { response, sessionId, cookie } = await rig.createSession();
  expect(response.statusCode).toBe(201);
  const client = await rig.connectChannel(cookie);
  const collector = new WssFrameCollector();
  collector.attach(client);
  return { rig, sessionId, cookie, client, collector };
}

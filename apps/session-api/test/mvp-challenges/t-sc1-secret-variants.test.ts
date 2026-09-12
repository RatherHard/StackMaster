/**
 * MVP 题目集 T-SC1 逐题裁定(秘密变体等价测试;清单 §10.2 落地纪律:
 * "T-SC1 对每道发布题目,针对其声明秘密生成变体,必过项")。
 *
 * 方法(§10.2 冻结流程):
 *   - 取题目语料,仅替换秘密值(flag 长度 8/16/32/64 变体 + 同长异值变体;
 *     canary 题 + 守护标记值变体;隐藏区域题 + 区域标记 / 虚拟文件内容变体),
 *     其余(布局、代码、玩家动作脚本)完全相同;
 *   - 动作脚本含探针变体:对隐藏映射地址与未映射地址的写入(I-9 统一拒绝
 *     形态同步验证);
 *   - 逐动作回放,收集每步响应;判定:全部响应经规范化序列化后字节完全相等。
 *
 * 允许差异字段注册表(I-10)默认空集:唯一剥离面 = 每响应的 requestId
 * (服务端生成的请求关联 ID,非秘密函数——§10.2"响应字节确定"语义不含
 * 进程内随机关联标识;与 compose 套件 I-4 断言的剥离面同形)。
 */
import { describe, expect, it } from "vitest";
import { canonicalize } from "@stackmaster/protocol";
import type { ActionResponse } from "@stackmaster/protocol";
import { SessionOrchestrator } from "@stackmaster/session-core";

import { MVP_CHALLENGES, type MvpChallenge } from "./corpus.js";

/** 剥离瞬态关联标识(非秘密函数;唯一允许差异面)。 */
function stripVolatile(response: ActionResponse): Record<string, unknown> {
  const clone = structuredClone(response) as Record<string, unknown>;
  delete clone["requestId"];
  return clone;
}

async function runScript(
  challenge: MvpChallenge,
  mutate?: (pair: { publicDescriptor: unknown; privateBundle: unknown }) => void,
): Promise<string> {
  const pair = challenge.buildPair();
  mutate?.(pair);
  const script = challenge.tsc1Script ?? [challenge.corpora[0]!.actions[0]!];
  const session = await SessionOrchestrator.create({
    privateBundle: pair.privateBundle,
    publicDescriptor: pair.publicDescriptor,
  });
  try {
    const responses: string[] = [];
    for (const action of script) {
      const response = await session.applyAction(action);
      responses.push(canonicalize(stripVolatile(response)));
    }
    return `[${responses.join(",")}]`;
  } finally {
    await session.closeSession();
  }
}

describe("MVP 题目集:T-SC1 秘密变体等价(确定性通道无相关性,逐题必过)", () => {
  for (const challenge of MVP_CHALLENGES) {
    const variants = challenge.secretVariants ?? [];

    it(`题目 ${challenge.meta.challengeId}:秘密变体(含探针动作)响应规范化字节全等`, async () => {
      expect(variants.length, "变体集不得为空(长度 8/16/32/64 + 同长异值)").toBeGreaterThanOrEqual(5);

      const baseline = await runScript(challenge);
      for (const variant of variants) {
        const observed = await runScript(challenge, variant.mutate);
        expect(
          observed,
          `变体 ${variant.label} 的响应序列与基线不一致(确定性通道相关性违规,T-SC1 红灯)`,
        ).toBe(baseline);
      }
    }, 180_000);
  }

  it("探针面复核:脚本确实包含不可见地址写入(I-9 统一拒绝形态在裁定脚本内)", () => {
    for (const challenge of MVP_CHALLENGES) {
      const script = challenge.tsc1Script ?? [challenge.corpora[0]!.actions[0]!];
      const probeWrites = script.filter(
        (action) =>
          action.type === "write_bytes" &&
          (action.args as { addressHex: string }).addressHex === "0x12340000",
      );
      expect(
        probeWrites.length,
        `${challenge.meta.challengeId} 的 T-SC1 脚本缺探针写`,
      ).toBeGreaterThanOrEqual(1);
    }
  });
});

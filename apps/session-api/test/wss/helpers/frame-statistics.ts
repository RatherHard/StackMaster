/**
 * ZR-P4 时序统计面的帧分布比较器(T-SC3 承接;阶段二移交 §六.4)。
 *
 * 统计口径(任务分解 WP-6 第 4 条):同题目同脚本在不同秘密变体下,通道上
 * 的响应**帧长分布**与帧序列**无可区分差异**。本层是编排器通道级的兜底统计
 * ——恒定成本的不变式由引擎 T-SC2(ZR-P7)在执行域内保证,通道级统计捕获
 * "执行域产物之外的通道行为差异"(投影形态、事件聚合、错误面、帧化节奏)。
 *
 * 抗-flaky 设计(任务分解 WP-6 完成标准):
 *  - 主断言 = 帧长分布逐位置断言(确定性,零时钟参与);
 *  - 序列断言 = 帧类型 / 判别字段有序性断言(零时钟参与);
 *  - 时序断言只做**次数与有序性**断言(帧到达次序 = 服务端录制序,单调时钟),
 *    不做任何响应时间分位数 / 绝对时长断言,避免 CI 时钟抖动红灯;
 *  - 归一化视图剥离会话标识与服务端关联值(requestId 是服务端每次签发的
 *    关联值,D-API-5:不承载确定性语义),其余字段参与逐字节比较。
 */
import type { WssFrame } from "@stackmaster/protocol";

/** 归一化帧视图(剥离会话标识与服务端 requestId;其余逐字节保留)。 */
export function canonicalFrameView(frame: WssFrame): string {
  const clone = JSON.parse(JSON.stringify(frame)) as Record<string, unknown> & {
    payload: Record<string, unknown>;
  };
  clone.sessionId = "<sessionId>";
  if (typeof clone.payload?.requestId === "string") {
    clone.payload.requestId = "<requestId>";
  }
  return JSON.stringify(clone);
}

/** 帧长分布(线上 JSON 字节长度,逐位置;含会话标识的固定宽度差异面)。 */
export function frameLengths(frames: readonly WssFrame[]): number[] {
  return frames.map((frame) => Buffer.byteLength(JSON.stringify(frame), "utf8"));
}

/** 首个差异位置(归一化视图比较;完全一致返回 -1)。 */
export function firstDivergence(a: readonly WssFrame[], b: readonly WssFrame[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const frameA = a[i];
    const frameB = b[i];
    if (frameA === undefined || frameB === undefined) {
      return i;
    }
    if (canonicalFrameView(frameA) !== canonicalFrameView(frameB)) {
      return i;
    }
  }
  return a.length === b.length ? -1 : n;
}

/**
 * 无可区分差异断言(统计面的主断言;任一维度失败即以具体差异位置报错):
 *  1. 帧数一致(次数断言);
 *  2. 帧类型序列一致(有序性断言);
 *  3. 帧长逐位置一致(帧长分布逐字节断言——主断言);
 *  4. 归一化视图逐位置一致(载荷逐字节断言)。
 */
export function assertIndistinguishable(a: readonly WssFrame[], b: readonly WssFrame[], label: string): void {
  if (a.length !== b.length) {
    throw new Error(
      `${label}: 帧数可区分(${a.length} vs ${b.length})——通道行为随变体差异泄露`,
    );
  }
  for (let i = 0; i < a.length; i += 1) {
    const frameA = a[i];
    const frameB = b[i];
    if (frameA === undefined || frameB === undefined || frameA.type !== frameB.type) {
      throw new Error(
        `${label}: 帧类型序列在第 ${i} 帧可区分(${frameA?.type ?? "<none>"} vs ${frameB?.type ?? "<none>"})`,
      );
    }
  }
  const lengthsA = frameLengths(a);
  const lengthsB = frameLengths(b);
  for (let i = 0; i < a.length; i += 1) {
    const lengthA = lengthsA[i] ?? -1;
    const lengthB = lengthsB[i] ?? -2;
    if (lengthA !== lengthB) {
      throw new Error(
        `${label}: 帧长分布在第 ${i} 帧可区分(${lengthA}B vs ${lengthB}B)——长度侧信道`,
      );
    }
  }
  const divergence = firstDivergence(a, b);
  if (divergence !== -1) {
    throw new Error(`${label}: 归一化载荷在第 ${divergence} 帧可区分`);
  }
}

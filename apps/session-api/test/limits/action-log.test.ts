/**
 * action_log 落库接线(任务 B;WP-3 任务 5 的编排侧接线,D-API-56):
 *  - submit 后账本可取回:SubmitReference.actionLog(编排器账本的权威投影,
 *    仅已接受动作)增量落入 ActionLogStore,与裁决引用同锚(submissionRef);
 *  - 拒绝不入账天然成立(引用只含已接受动作);
 *  - append-only 语义:重复 submit 零重复追加(增量锚推进),历史条目不变;
 *  - 落库失败:submit 响应成功、裁决引用不回滚(权威锚),增量锚不推进——
 *    下次 submit 增量补账;细节只进受控日志;
 *  - 秘密语料扫描锚点(测试锚点而非运行时硬闸,D-API-26):落库动作日志
 *    语料零命中;红灯反例沿用 WP-3 扫描器自证。
 */
import { describe, expect, it } from "vitest";

import { TEST_TENANT_ID, buildSessionTestRig, type SessionTestRig } from "../routes/helpers/session-rig.js";
import { scanSecretCorpus } from "../../src/persistence/index.js";

const ACCEPT_WRITE = { type: "write_bytes", args: { addressHex: "0x401000", bytesHex: "c3" } } as const;
const REJECT_WRITE = { type: "write_bytes", args: { addressHex: "0x401000", bytesHex: "ff" } } as const;

async function setup(): Promise<{ rig: SessionTestRig; sessionId: string }> {
  const rig = await buildSessionTestRig();
  await rig.registerChallenge();
  const sessionId = await rig.manager.createSession({
    tenantId: TEST_TENANT_ID,
    userId: "user-42",
    challengeId: "chal-stack-escape",
    challengeVersion: "1.2.3",
    embedTokenJti: "jti-action-log",
  }).then((outcome) => outcome.sessionId);
  return { rig, sessionId };
}

describe("action_log 落库(submit 锚点接线,D-API-56)", () => {
  it("submit 后账本可取回:仅已接受动作、与裁决引用同锚、clientSeq 为编排器内部水位", async () => {
    const { rig, sessionId } = await setup();

    // 接受 → 拒绝 → 接受(内部水位 1 / 2 / 3;被拒绝动作 revision 不前进)。
    expect((await rig.manager.applyAction(sessionId, TEST_TENANT_ID, ACCEPT_WRITE)).revision).toBe(1);
    expect((await rig.manager.applyAction(sessionId, TEST_TENANT_ID, REJECT_WRITE)).revision).toBe(1);
    expect((await rig.manager.applyAction(sessionId, TEST_TENANT_ID, ACCEPT_WRITE)).revision).toBe(2);

    const result = await rig.manager.submit(sessionId, TEST_TENANT_ID);
    const submission = (await rig.submissions.findBySession(sessionId, TEST_TENANT_ID))[0];
    expect(submission?.id).toBe(result.submissionId);

    const stored = await rig.actionLog.listBySession(sessionId, TEST_TENANT_ID);
    // 拒绝不入账:账本只含 2 条已接受动作(内部 clientSeq 1 与 3;被拒绝的
    // clientSeq 2 不在账本)。
    expect(stored).toHaveLength(2);
    expect(stored.map((entry) => entry.clientSeq)).toEqual([1, 3]);
    expect(stored.map((entry) => entry.revisionAfter)).toEqual([1, 2]);
    for (const entry of stored) {
      expect(entry.action).toEqual(ACCEPT_WRITE);
      // 与 submit 引用同锚(submissionRef = submissions 行标识)。
      expect(entry.submissionRef).toBe(result.submissionId);
      expect(entry.sessionId).toBe(sessionId);
    }
    // 与裁决引用内的权威动作日志逐条同源(submissions.reference 是权威锚)。
    const reference = submission?.reference as {
      actionLog: readonly { clientSeq: number; revisionAfter: number }[];
    };
    expect(reference.actionLog.map((item) => item.clientSeq)).toEqual([1, 3]);
    expect(stored.map((entry) => entry.revisionAfter)).toEqual(
      reference.actionLog.map((item) => item.revisionAfter),
    );
  });

  it("append-only:重复 submit 零重复追加;新动作后 submit 只追加增量", async () => {
    const { rig, sessionId } = await setup();

    await rig.manager.applyAction(sessionId, TEST_TENANT_ID, ACCEPT_WRITE);
    await rig.manager.submit(sessionId, TEST_TENANT_ID);
    const afterFirst = await rig.actionLog.listBySession(sessionId, TEST_TENANT_ID);
    expect(afterFirst).toHaveLength(1);

    // 无新动作的重复 submit:零重复追加(增量锚已到账本末尾)。
    await rig.manager.submit(sessionId, TEST_TENANT_ID);
    expect(await rig.actionLog.countBySession(sessionId, TEST_TENANT_ID)).toBe(1);

    // 新动作 → 第二次 submit:只追加增量条目,以新提交引用为锚。
    await rig.manager.applyAction(sessionId, TEST_TENANT_ID, ACCEPT_WRITE);
    const second = await rig.manager.submit(sessionId, TEST_TENANT_ID);
    const stored = await rig.actionLog.listBySession(sessionId, TEST_TENANT_ID);
    expect(stored).toHaveLength(2);
    expect(stored[0]?.submissionRef).not.toBe(second.submissionId);
    expect(stored[1]?.submissionRef).toBe(second.submissionId);
    // 首条历史条目原样不变(append-only:无更新面)。
    expect(stored[0]).toEqual(afterFirst[0]);
  });

  it("落库失败:submit 响应成功、裁决引用不回滚;下次 submit 增量补账;细节只进受控日志", async () => {
    const { rig, sessionId } = await setup();
    await rig.manager.applyAction(sessionId, TEST_TENANT_ID, ACCEPT_WRITE);

    // 注入一次落库故障(存储不可用模拟)。
    const originalAppend = rig.actionLog.append.bind(rig.actionLog);
    let failed = false;
    rig.actionLog.append = async (entries) => {
      if (!failed) {
        failed = true;
        throw new Error("simulated action log store outage");
      }
      return originalAppend(entries);
    };

    // submit 响应成功(裁决引用已落库,权威锚成立);动作日志暂缺。
    const first = await rig.manager.submit(sessionId, TEST_TENANT_ID);
    expect(first.submissionId).toBeTruthy();
    expect(await rig.submissions.findBySession(sessionId, TEST_TENANT_ID)).toHaveLength(1);
    expect(await rig.actionLog.countBySession(sessionId, TEST_TENANT_ID)).toBe(0);
    // 受控日志承载失败细节(D-API-56)。
    expect(rig.capture.raw()).toContain("action log persistence failed");

    // 下次 submit:增量补账(含上次未落库条目;锚不推进是重试语义)。
    await rig.manager.applyAction(sessionId, TEST_TENANT_ID, ACCEPT_WRITE);
    const second = await rig.manager.submit(sessionId, TEST_TENANT_ID);
    const stored = await rig.actionLog.listBySession(sessionId, TEST_TENANT_ID);
    expect(stored).toHaveLength(2);
    // 补账条目锚定补账发生的提交引用(落库事实与其锚一致)。
    expect(stored.every((entry) => entry.submissionRef === second.submissionId)).toBe(true);
  });

  it("秘密语料扫描锚点:落库动作日志零秘密命中(测试锚点而非运行时硬闸)", async () => {
    const { rig, sessionId } = await setup();
    await rig.manager.applyAction(sessionId, TEST_TENANT_ID, ACCEPT_WRITE);
    await rig.manager.applyAction(sessionId, TEST_TENANT_ID, REJECT_WRITE);
    await rig.manager.applyAction(sessionId, TEST_TENANT_ID, ACCEPT_WRITE);
    await rig.manager.submit(sessionId, TEST_TENANT_ID);

    const stored = await rig.actionLog.listBySession(sessionId, TEST_TENANT_ID);
    // 落库的动作内容(玩家提交可见面 BOUNDARY,D-API-26)语料扫描零命中。
    // 扫描域 = 动作日志条目的可见载荷(clientSeq / revisionAfter / action),
    // 不含服务端元数据列(sessionId 等标识符非秘密但会与 seed 语料模式共形)。
    const visibleCorpus = JSON.stringify(
      stored.map((entry) => ({
        clientSeq: entry.clientSeq,
        revisionAfter: entry.revisionAfter,
        action: entry.action,
      })),
    );
    expect(scanSecretCorpus(visibleCorpus)).toEqual([]);
    // 红灯自证:扫描器对注入语料可检出(证明零命中是扫描有效下的结论)。
    expect(scanSecretCorpus('{"payload":"FLAG{red-light-probe}"}')).toHaveLength(1);
  });
});

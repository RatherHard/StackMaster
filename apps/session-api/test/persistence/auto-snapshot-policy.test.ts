/**
 * 周期快照策略与秘密语料扫描器测试(WP-3;D-API-25 / ZR-B4 / B6 存储面)。
 */

import { describe, expect, it } from "vitest";
import {
  AutoSnapshotPolicy,
  scanSecretCorpus,
  SnapshotCipher,
} from "../../src/persistence/index.js";
import type { SecretCorpusHit } from "../../src/persistence/index.js";

describe("AutoSnapshotPolicy(恢复点策略,D-API-25)", () => {
  it("每 N revision 触发:达到阈值触发,未达不触发", () => {
    const policy = new AutoSnapshotPolicy({ everyNRevisions: 50 });
    expect(policy.shouldAutoSnapshot(49)).toBe(false);
    expect(policy.shouldAutoSnapshot(50)).toBe(true);
    expect(policy.shouldAutoSnapshot(100)).toBe(true);
    expect(policy.revisionsUntilNextSnapshot(20)).toBe(30);
    expect(policy.revisionsUntilNextSnapshot(60)).toBe(0);
  });

  it("触发点 → origin 列值映射(显式 / 周期 / 关闭三触发点)", () => {
    const policy = new AutoSnapshotPolicy({ everyNRevisions: 50 });
    expect(policy.originOf("explicit_checkpoint")).toBe("explicit_checkpoint");
    expect(policy.originOf("periodic")).toBe("auto_periodic");
    expect(policy.originOf("session_close")).toBe("session_close");
  });

  it("非法间隔拒绝(配置在启动校验先行,此处为构造兜底)", () => {
    expect(() => new AutoSnapshotPolicy({ everyNRevisions: 0 })).toThrow();
    expect(() => new AutoSnapshotPolicy({ everyNRevisions: 2.5 })).toThrow();
  });
});

describe("scanSecretCorpus(秘密语料扫描器;测试锚点)", () => {
  const SEED_HEX = "00112233445566778899aabbccddeeff"; // D-F9 形态的合成种子样式

  it("flag 与 seed 语料命中(条目 ID 携带 ZR 清单编号)", () => {
    const payload = `{"payload":{"seedState":{"stateBytes":"${SEED_HEX}"},"note":"FLAG{lifecycle-demo}"}}`;
    const hits = scanSecretCorpus(payload);
    expect(hits.map((hit) => hit.id)).toContain("ZR-B1-flag-corpus");
    expect(hits.map((hit) => hit.id)).toContain("ZR-B6-seed-corpus");
  });

  it("无害载荷零命中(动作日志/投影形态不误报)", () => {
    const action = {
      type: "write_bytes",
      args: { addressHex: "0x20000000", bytesHex: "aa bb cc" },
    };
    expect(scanSecretCorpus(JSON.stringify(action))).toEqual([]);
    expect(scanSecretCorpus(JSON.stringify({ revision: 3, status: "running" }))).toEqual([]);
  });

  it("红灯反例:明文快照存 seed/flag 语料 → 扫描器检出(证明扫描器可检出)", () => {
    const plaintextEnvelope = JSON.stringify({
      snapshotFormatVersion: 1,
      revision: 7,
      payload: { seedState: { stateBytes: SEED_HEX } },
      leaked: "FLAG{should-never-be-stored}",
    });
    expect(scanSecretCorpus(plaintextEnvelope).length).toBeGreaterThanOrEqual(2);
  });

  it("密文落库零命中:加密后的同信封扫描零命中(密文断言的单元形态)", () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => 0xa0 + i)).toString("base64");
    const cipher = SnapshotCipher.fromBase64Key(key);
    const plaintext = Buffer.from(
      JSON.stringify({ payload: { seedState: { stateBytes: SEED_HEX } }, flag: "FLAG{cipher-check}" }),
      "utf8",
    );
    const ciphertext = cipher.encrypt(plaintext);
    // 完成标准:快照 blob 落库密文断言——明文语料扫描零命中。
    expect(scanSecretCorpus(ciphertext)).toEqual([]);
    expect(scanSecretCorpus(Buffer.from(ciphertext).toString("utf8"))).toEqual([]);
  });

  it("字节 blob 输入与字符串输入同构", () => {
    const hits: readonly SecretCorpusHit[] = scanSecretCorpus(
      Buffer.from("FLAG{x}", "utf8"),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("ZR-B1-flag-corpus");
  });
});

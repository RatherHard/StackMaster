/**
 * 快照加密静止(D-W8-11 / D-API-21 / D-API-22)单元测试。
 * 完成标准映射:快照加密密钥缺失/长度非法在 config 启动期拒绝(见
 * test/config.test.ts);密文信封形态与认证失败在此覆盖。
 */

import { describe, expect, it } from "vitest";
import {
  PersistenceError,
  SNAPSHOT_CIPHER_ENVELOPE_VERSION,
  SNAPSHOT_KEY_BYTES,
  SnapshotCipher,
} from "../../src/persistence/index.js";

const KEY_A = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64");
const KEY_B = Buffer.from(Array.from({ length: 32 }, (_, i) => 255 - i)).toString("base64");

const PLAINTEXT = Buffer.from(
  JSON.stringify({
    snapshotFormatVersion: 1,
    vmEngineVersion: "0.1.0",
    engineBuildId: "dev",
    revision: 7,
    payload: { seedState: { stateBytes: "0011223344556677" } },
  }),
  "utf8",
);

describe("SnapshotCipher(快照应用层整包加密)", () => {
  it("加解密往返逐字节还原明文", () => {
    const cipher = SnapshotCipher.fromBase64Key(KEY_A);
    const encrypted = cipher.encrypt(PLAINTEXT);
    expect(Buffer.from(cipher.decrypt(encrypted)).equals(PLAINTEXT)).toBe(true);
  });

  it("密文信封形态 = [SMEN][01][12B nonce][密文][16B authTag](D-API-22)", () => {
    const cipher = SnapshotCipher.fromBase64Key(KEY_A);
    const encrypted = Buffer.from(cipher.encrypt(PLAINTEXT));
    expect(encrypted.subarray(0, 4).toString("ascii")).toBe("SMEN");
    expect(encrypted[4]).toBe(SNAPSHOT_CIPHER_ENVELOPE_VERSION);
    expect(encrypted.byteLength).toBe(
      4 + 1 + 12 + PLAINTEXT.byteLength + 16,
    );
  });

  it("每次加密现场随机 nonce:同明文两次加密密文不同(静止存储不参与确定性断言)", () => {
    const cipher = SnapshotCipher.fromBase64Key(KEY_A);
    const first = Buffer.from(cipher.encrypt(PLAINTEXT));
    const second = Buffer.from(cipher.encrypt(PLAINTEXT));
    expect(first.equals(second)).toBe(false);
    // nonce 段(偏移 5..17)不同,authTag 段不同。
    expect(first.subarray(5, 17).equals(second.subarray(5, 17))).toBe(false);
  });

  it("密钥不符 → 认证失败确定性拒绝(snapshot_auth_failed)", () => {
    const encrypted = SnapshotCipher.fromBase64Key(KEY_A).encrypt(PLAINTEXT);
    const other = SnapshotCipher.fromBase64Key(KEY_B);
    try {
      other.decrypt(encrypted);
      expect.unreachable("密钥不符必须认证失败");
    } catch (error) {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe("snapshot_auth_failed");
    }
  });

  it("密文被篡改一位 → 认证失败(防篡改探测,红灯反例形态)", () => {
    const cipher = SnapshotCipher.fromBase64Key(KEY_A);
    const encrypted = Buffer.from(cipher.encrypt(PLAINTEXT));
    const tamperIndex = encrypted.byteLength - 20;
    encrypted[tamperIndex] = (encrypted[tamperIndex] ?? 0) ^ 0x01;
    try {
      cipher.decrypt(encrypted);
      expect.unreachable("被篡改的密文必须认证失败");
    } catch (error) {
      expect((error as PersistenceError).code).toBe("snapshot_auth_failed");
    }
  });

  it("魔数 / 版本 / 长度非法 → snapshot_ciphertext_malformed", () => {
    const cipher = SnapshotCipher.fromBase64Key(KEY_A);
    const encrypted = Buffer.from(cipher.encrypt(PLAINTEXT));
    encrypted[0] = 0x00; // 破坏魔数
    try {
      cipher.decrypt(encrypted);
      expect.unreachable("魔数非法必须拒绝");
    } catch (error) {
      expect((error as PersistenceError).code).toBe("snapshot_ciphertext_malformed");
      expect(String(error)).toContain("魔数");
    }

    const badVersion = Buffer.from(cipher.encrypt(PLAINTEXT));
    badVersion[4] = 0x7f;
    try {
      cipher.decrypt(badVersion);
      expect.unreachable("版本非法必须拒绝");
    } catch (error) {
      expect((error as PersistenceError).code).toBe("snapshot_ciphertext_malformed");
      expect(String(error)).toContain("版本");
    }

    try {
      cipher.decrypt(Uint8Array.of(1, 2, 3));
      expect.unreachable("长度非法必须拒绝");
    } catch (error) {
      expect((error as PersistenceError).code).toBe("snapshot_ciphertext_malformed");
      expect(String(error)).toContain("长度");
    }
  });

  it("密钥校验 fail-closed:长度非法 / 非 base64 拒绝构造", () => {
    expect(() => SnapshotCipher.fromBase64Key(Buffer.alloc(16, 1).toString("base64"))).toThrowError(
      new PersistenceError("snapshot_key_invalid", `快照加密密钥解码后必须恰为 ${SNAPSHOT_KEY_BYTES} 字节`),
    );
    expect(() => SnapshotCipher.fromBase64Key("!!not-base64!!")).toThrowError(PersistenceError);
    expect(() => SnapshotCipher.fromBase64Key("")).toThrowError(/缺失/);
  });
});

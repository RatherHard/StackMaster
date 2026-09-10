/**
 * 快照应用层整包加密(D-W8-11 收口;D-API-21)。
 *
 * 决策要点:
 *  - 加密层级取**应用层整包加密**(AES-256-GCM):编排器在快照落库前把
 *    快照信封整体加密为密文信封,PostgreSQL 行内只存密文字节——不依赖
 *    存储级加密的部署正确性,密文随行迁移、备份即密文;
 *  - 密钥来源 = 环境变量 SESSION_API_SNAPSHOT_ENCRYPTION_KEY(base64 编码
 *    的 32 字节),config.ts 启动校验长度,缺失 / 非法即拒绝启动
 *    (fail-closed);密钥管理服务(KMS)轮换归部署面演进;
 *  - 快照是 worker 所有的 SERVER_ONLY blob(含 seedState),编排器只存取、
 *    不解析、不派生:本模块只做"字节进、字节出"的机械加解密,零字段语义;
 *  - 每次加密现场随机 nonce(12 字节):密文字节不参与任何确定性断言
 *    (I-4 作用于响应面,不作用于静止存储形态)。
 *
 * 密文信封格式(D-API-22,`stackmaster-session-snapshot-encrypted/1`):
 *   [4B 魔数 "SMEN"][1B 格式版本 0x01][12B nonce][密文 …][16B GCM authTag]
 * 魔数仅为密文形态自识别(供机检区分密文/明文 blob),不承载任何语义。
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PersistenceError } from "./errors.js";

/** 密钥字节长度(AES-256;config.ts SNAPSHOT_ENCRYPTION_KEY_BYTES 同源)。 */
export const SNAPSHOT_KEY_BYTES = 32;

/** 密文信封格式版本(密文信封自身的演进序号,独立于快照信封版本)。 */
export const SNAPSHOT_CIPHER_ENVELOPE_VERSION = 1;

/** 密文信封魔数:"SMEN"(StackMaster Encrypted Snapshot)。 */
const MAGIC = Uint8Array.of(0x53, 0x4d, 0x45, 0x4e);

const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1;

/** 校验并解码快照加密密钥(base64 的 32 字节);非法即抛(启动期拦截)。 */
export function decodeSnapshotEncryptionKey(raw: string): Buffer {
  if (raw === "") {
    throw new PersistenceError("snapshot_key_invalid", "快照加密密钥缺失(启动校验应已拦截)");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch {
    throw new PersistenceError("snapshot_key_invalid", "快照加密密钥必须是 base64 编码的 32 字节");
  }
  if (decoded.length !== SNAPSHOT_KEY_BYTES) {
    throw new PersistenceError(
      "snapshot_key_invalid",
      `快照加密密钥解码后必须恰为 ${SNAPSHOT_KEY_BYTES} 字节`,
    );
  }
  return decoded;
}

/** 快照整包加密器(只做机械加解密,零快照字段语义)。 */
export class SnapshotCipher {
  private readonly key: Buffer;

  private constructor(key: Buffer) {
    this.key = key;
  }

  /** 从 base64 编码密钥构造;非法即抛(config 启动校验的前置同源逻辑)。 */
  static fromBase64Key(raw: string): SnapshotCipher {
    return new SnapshotCipher(decodeSnapshotEncryptionKey(raw));
  }

  /** 明文字节 → 密文信封字节。 */
  encrypt(plaintext: Uint8Array): Uint8Array {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce, { authTagLength: AUTH_TAG_BYTES });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope = Buffer.allocUnsafe(HEADER_BYTES + NONCE_BYTES + ciphertext.length + AUTH_TAG_BYTES);
    envelope.set(MAGIC, 0);
    envelope[HEADER_BYTES - 1] = SNAPSHOT_CIPHER_ENVELOPE_VERSION;
    envelope.set(nonce, HEADER_BYTES);
    envelope.set(ciphertext, HEADER_BYTES + NONCE_BYTES);
    envelope.set(tag, envelope.length - AUTH_TAG_BYTES);
    return envelope;
  }

  /** 密文信封字节 → 明文字节;形态 / 认证失败确定性抛错(fail-closed)。 */
  decrypt(blob: Uint8Array): Uint8Array {
    if (blob.byteLength < HEADER_BYTES + NONCE_BYTES + AUTH_TAG_BYTES) {
      throw new PersistenceError("snapshot_ciphertext_malformed", "快照密文信封长度非法");
    }
    const bytes = blob instanceof Uint8Array ? blob : Uint8Array.from(blob);
    for (let i = 0; i < MAGIC.length; i += 1) {
      if (bytes[i] !== MAGIC[i]) {
        throw new PersistenceError("snapshot_ciphertext_malformed", "快照密文信封魔数不符");
      }
    }
    if (bytes[HEADER_BYTES - 1] !== SNAPSHOT_CIPHER_ENVELOPE_VERSION) {
      throw new PersistenceError("snapshot_ciphertext_malformed", "快照密文信封版本不受支持");
    }
    const nonce = Buffer.from(bytes.slice(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES));
    const tag = Buffer.from(bytes.slice(bytes.byteLength - AUTH_TAG_BYTES));
    const ciphertext = Buffer.from(
      bytes.slice(HEADER_BYTES + NONCE_BYTES, bytes.byteLength - AUTH_TAG_BYTES),
    );
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (error) {
      // GCM 认证失败 = 密钥不符或密文被篡改:确定性拒绝,不区分两种原因
      // (防篡改探测面)。
      throw new PersistenceError("snapshot_auth_failed", "快照密文认证失败", { cause: error });
    }
  }
}

/**
 * 题目登记路径最小实现(WP-3;批量题目制作归 MVP 期)。
 *
 * 登记序(D-API-23):
 *  1. 双包 SHA-256 摘要计算(哈希校验面:摘要入 challenge_versions 行);
 *  2. 登记签名校验(Ed25519,base64;签名基线 = 冻结字段的确定性拼接,
 *     fail-closed:无验签公钥或验签失败一律拒绝登记);
 *  3. 双包入对象存储(私有判题包 → private-bundles;公开描述包 →
 *     public-descriptors);
 *  4. 版本行落 PostgreSQL(版本不可变,重复登记确定性拒绝)。
 * 顺序保证:先对象后元数据——注册表行存在即包可取回(读取路径不依赖
 * 跨存储事务)。
 */

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { PersistenceError } from "../errors.js";
import type {
  ChallengeBundleStore,
  ChallengeRegistry,
  ChallengeVersionRow,
} from "../ports.js";

/** 签名基线版本(登记签名覆盖面的演进序号)。 */
const REGISTRATION_FORM = "stackmaster-challenge-registration/1";

/** 签名基线(确定性拼接;字段集冻结,演进走 D-API 修订)。 */
export function registrationSignatureBasis(input: {
  challengeId: string;
  contentVersion: string;
  vmProfileVersion: string;
  privateBundleSha256: string;
  publicDescriptorSha256: string;
}): string {
  return [
    REGISTRATION_FORM,
    input.challengeId,
    input.contentVersion,
    input.vmProfileVersion,
    input.privateBundleSha256,
    input.publicDescriptorSha256,
  ].join("\n");
}

export function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface RegisterChallengeInput {
  readonly tenantId: string;
  readonly challengeId: string;
  readonly contentVersion: string;
  readonly vmProfileVersion: string;
  /** 私有判题包字节(服务端专用;只计算摘要与写桶,零日志、零台账)。 */
  readonly privateBundle: Uint8Array;
  readonly publicDescriptor: Uint8Array;
  /** 登记签名(Ed25519 over registrationSignatureBasis,base64)。 */
  readonly signature: string;
}

export interface RegisteredChallenge {
  readonly version: ChallengeVersionRow;
}

/** 验签公钥注入形态(PKey PEM / JWK / Raw base64 任一 node 支持形态)。 */
export type SigningPublicKey = KeyObject | string;

function toKeyObject(key: SigningPublicKey): KeyObject {
  if (typeof key !== "string") {
    return key;
  }
  // raw base64 形态(32 字节 Ed25519 raw public key)→ JWK 包装。
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(key) && key.length % 4 === 0) {
    const raw = Buffer.from(key, "base64");
    if (raw.length === 32) {
      return createPublicKey({
        key: {
          kty: "OKP",
          crv: "Ed25519",
          x: raw.toString("base64url"),
        },
        format: "jwk",
      });
    }
  }
  return createPublicKey(key);
}

export class ChallengeRegistrar {
  constructor(
    private readonly deps: {
      readonly bundles: ChallengeBundleStore;
      readonly registry: ChallengeRegistry;
      /** 验签公钥(信任锚;缺省无钥匙 = 登记一律拒绝,fail-closed)。 */
      readonly signingPublicKey: SigningPublicKey | null;
    },
  ) {}

  async register(input: RegisterChallengeInput): Promise<RegisteredChallenge> {
    const privateSha = sha256Hex(input.privateBundle);
    const publicSha = sha256Hex(input.publicDescriptor);
    const basis = registrationSignatureBasis({
      challengeId: input.challengeId,
      contentVersion: input.contentVersion,
      vmProfileVersion: input.vmProfileVersion,
      privateBundleSha256: privateSha,
      publicDescriptorSha256: publicSha,
    });

    if (this.deps.signingPublicKey === null) {
      throw new PersistenceError("registration_unverifiable", "登记路径未配置验签公钥(拒绝登记)");
    }
    let signatureOk: boolean;
    try {
      const key = toKeyObject(this.deps.signingPublicKey);
      signatureOk = cryptoVerify(
        null,
        Buffer.from(basis, "utf8"),
        key,
        Buffer.from(input.signature, "base64"),
      );
    } catch (error) {
      throw new PersistenceError("registration_unverifiable", "登记签名形态非法", { cause: error });
    }
    if (!signatureOk) {
      throw new PersistenceError("registration_unverifiable", "登记签名校验失败(拒绝登记)");
    }

    const privateObjectName = await this.deps.bundles.putPrivate(
      input.challengeId,
      input.contentVersion,
      input.privateBundle,
    );
    const publicObjectName = await this.deps.bundles.putPublic(
      input.challengeId,
      input.contentVersion,
      input.publicDescriptor,
    );

    await this.deps.registry.upsertChallenge({
      challengeId: input.challengeId,
      tenantId: input.tenantId,
    });
    const versionInput = {
      challengeId: input.challengeId,
      contentVersion: input.contentVersion,
      tenantId: input.tenantId,
      vmProfileVersion: input.vmProfileVersion,
      privateBundleSha256: privateSha,
      publicDescriptorSha256: publicSha,
      privateBundleObject: privateObjectName,
      publicDescriptorObject: publicObjectName,
      signature: input.signature,
      signerKeyId: "default",
    };
    await this.deps.registry.insertChallengeVersion(versionInput);
    const row = await this.deps.registry.findChallengeVersion(
      input.challengeId,
      input.contentVersion,
      input.tenantId,
    );
    if (row === null) {
      throw new PersistenceError("store_unavailable", "题目版本登记后不可读");
    }
    return { version: row };
  }
}

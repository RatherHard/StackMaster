/**
 * MinIO / S3 题目双包对象存储(WP-3;计划书 5.7 对象存储桶)。
 *
 * 桶纪律:
 *  - 私有判题包 → private-buckets 桶(SESSION_API_MINIO_BUCKET_PRIVATE,
 *    默认 private-bundles):服务端专用、最小权限(桶策略拒绝匿名读写,
 *    为 MinIO 默认)、静态加密(部署面启用 MinIO SSE-KMS / 自动加密;
 *    本地 dev compose 无 KMS,生产面归 WP-8 部署收尾);
 *  - 公开描述包 → public-descriptors 桶(SESSION_API_MINIO_BUCKET_PUBLIC):
 *    阶段三仅对象存储落点,CDN 发布与签名 URL 归阶段五。
 *
 * 对象命名:{challengeId}/{version}/{bundle|descriptor}.json;challengeId /
 * version 必须满足冻结标识符字符集(防路径注入)。
 */

import { PersistenceError } from "../errors.js";
import type { ChallengeBundleStore } from "../ports.js";

/** 最小 MinIO 客户端面(生产注入 minio Client;测试可注入内存替身)。 */
export interface MinioLike {
  bucketExists(bucket: string): Promise<boolean>;
  makeBucket(bucket: string, region: string): Promise<void>;
  putObject(
    bucket: string,
    objectName: string,
    content: Uint8Array | Buffer | string,
    size?: number,
  ): Promise<unknown>;
  getObject(bucket: string, objectName: string): Promise<NodeJS.ReadableStream>;
}

/** 冻结标识符字符集(语义文档 §2.1;challengeId 的同锚校验)。 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** 题目内容版本:semver 形态(版本策略;点号合法,禁路径穿越)。 */
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function assertIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new PersistenceError("invalid_identifier", `${label} 不满足冻结标识符字符集`);
  }
}

function assertVersion(value: string): void {
  if (!VERSION_PATTERN.test(value) || value.includes("..")) {
    throw new PersistenceError("invalid_identifier", "version 不满足题目版本字符集(禁路径穿越)");
  }
}

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (error) => reject(error));
  });
}

export interface MinioBundleStoreOptions {
  bucketPrivate: string;
  bucketPublic: string;
}

export class MinioChallengeBundleStore implements ChallengeBundleStore {
  constructor(
    private readonly client: MinioLike,
    private readonly options: MinioBundleStoreOptions,
  ) {}

  private objectName(challengeId: string, version: string, kind: "bundle" | "descriptor"): string {
    assertIdentifier(challengeId, "challengeId");
    assertVersion(version);
    return `${challengeId}/${version}/${kind}.json`;
  }

  private bucketFor(kind: "bundle" | "descriptor"): string {
    return kind === "bundle" ? this.options.bucketPrivate : this.options.bucketPublic;
  }

  private async put(challengeId: string, version: string, kind: "bundle" | "descriptor", content: Uint8Array): Promise<string> {
    const bucket = this.bucketFor(kind);
    const name = this.objectName(challengeId, version, kind);
    try {
      await this.client.putObject(bucket, name, Buffer.from(content), content.byteLength);
    } catch (error) {
      throw new PersistenceError("store_unavailable", "题目包写入对象存储失败", { cause: error });
    }
    return name;
  }

  private async get(challengeId: string, version: string, kind: "bundle" | "descriptor"): Promise<Uint8Array | null> {
    const bucket = this.bucketFor(kind);
    const name = this.objectName(challengeId, version, kind);
    let stream: NodeJS.ReadableStream;
    try {
      stream = await this.client.getObject(bucket, name);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "NotFound" || code === "NoSuchKey") {
        return null;
      }
      throw new PersistenceError("store_unavailable", "题目包读取对象存储失败", { cause: error });
    }
    return new Uint8Array(await collect(stream));
  }

  /** 幂等建桶(部署 / 测试引导;桶名来自 config,非用户输入)。 */
  async ensureBuckets(): Promise<void> {
    for (const bucket of [this.options.bucketPrivate, this.options.bucketPublic]) {
      const exists = await this.client.bucketExists(bucket).catch((error: unknown) => {
        throw new PersistenceError("store_unavailable", "对象存储不可达(fail-closed)", { cause: error });
      });
      if (!exists) {
        await this.client.makeBucket(bucket, "us-east-1");
      }
    }
  }

  putPrivate(challengeId: string, version: string, content: Uint8Array): Promise<string> {
    return this.put(challengeId, version, "bundle", content);
  }

  getPrivate(challengeId: string, version: string): Promise<Uint8Array | null> {
    return this.get(challengeId, version, "bundle");
  }

  putPublic(challengeId: string, version: string, content: Uint8Array): Promise<string> {
    return this.put(challengeId, version, "descriptor", content);
  }

  getPublic(challengeId: string, version: string): Promise<Uint8Array | null> {
    return this.get(challengeId, version, "descriptor");
  }
}

/** minio 官方客户端 → MinioLike 适配(动态 import,保持模块可测试性)。 */
export async function createMinioClient(options: {
  endpoint: string;
  port: number;
  accessKey: string;
  secretKey: string;
  useSsl?: boolean;
}): Promise<MinioLike> {
  const { Client } = await import("minio");
  return new Client({
    endPoint: options.endpoint,
    port: options.port,
    useSSL: options.useSsl ?? false,
    accessKey: options.accessKey,
    secretKey: options.secretKey,
  }) as unknown as MinioLike;
}

/**
 * MinIO / S3 登记双包只读源(WP-61;最小授权面:仅双桶 GET)。
 *
 * verifier 的对象存储凭证是独立最小权限角色(部署面经 compose 的
 * verifier-minio-init 授予 `s3:GetObject` on `private-bundles/*` 与
 * `public-descriptors/*`;与 session-api 的读写凭证不共享)。双包各归其桶
 * (001 迁移登记行的对象名语义):私有判题包 → `private-bundles`(服务端
 * 专用,零浏览器可达),公开描述包 → `public-descriptors`(玩家可达公开
 * 产物,零秘密)。对象名取自 `challenge_versions` 登记行(登记值为权威,
 * 不在本层派生命名规则);哈希完整性由 adjudicator 对登记摘要复算比对承载,
 * 不在存储层重复。
 */
import type { BundleSource } from "./ports.js";

/** 最小 MinIO 客户端面(GET-only;测试注入内存替身)。 */
export interface MinioReadonly {
  getObject(bucket: string, objectName: string): Promise<NodeJS.ReadableStream>;
}

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", (error) => reject(error));
  });
}

export class MinioRegisteredBundleSource implements BundleSource {
  constructor(
    private readonly client: MinioReadonly,
    private readonly bucketPrivate: string,
    private readonly bucketPublic: string,
  ) {}

  async getPrivate(objectName: string): Promise<Uint8Array | null> {
    return this.get(this.bucketPrivate, objectName);
  }

  async getPublic(objectName: string): Promise<Uint8Array | null> {
    return this.get(this.bucketPublic, objectName);
  }

  /** readiness 探针:探测键缺失(NotFound / NoSuchKey)= 授权可达且健康。 */
  async probe(): Promise<void> {
    try {
      await this.client.getObject(this.bucketPrivate, "__verifier_readiness_probe__");
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "NotFound" || code === "NoSuchKey" || code === "NoSuchBucket") {
        return;
      }
      throw error;
    }
  }

  /**
   * 单桶 GET:缺失(NotFound / NoSuchKey)= null(裁决侧 challenge_invalid
   * 同形);越权(AccessDenied)与不可达都是确定性拒绝方向:对象取回失败,
   * 裁决不可用 ≠ 判负(fail-closed);错误细节只进受控日志。
   */
  private async get(bucket: string, objectName: string): Promise<Uint8Array | null> {
    let stream: NodeJS.ReadableStream;
    try {
      stream = await this.client.getObject(bucket, objectName);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "NotFound" || code === "NoSuchKey") {
        return null;
      }
      throw error;
    }
    return new Uint8Array(await collect(stream));
  }
}

/** minio 官方客户端 → 只读面适配(动态 import,保持模块可测试性)。 */
export async function createMinioReadonlyClient(options: {
  endpoint: string;
  port: number;
  accessKey: string;
  secretKey: string;
  useSsl?: boolean;
}): Promise<MinioReadonly> {
  const { Client } = await import("minio");
  return new Client({
    endPoint: options.endpoint,
    port: options.port,
    useSSL: options.useSsl ?? false,
    accessKey: options.accessKey,
    secretKey: options.secretKey,
  }) as unknown as MinioReadonly;
}

/**
 * 题目双包对象存储建桶引导单元测试(MinIO 建桶 check-then-act 竞态)。
 *
 * 缺陷背景(M1 收口期实跑发现):`ensureBuckets()` 在 `bucketExists` 返回 false 后
 * 直接 `makeBucket`,不区分「桶已被**他人**刚创建」这一正常并发结果 ⇒ 全新 MinIO
 * 卷上多进程 / 多测试文件并行引导时,败者抛
 * `S3Error: Your previous request to create the named bucket succeeded and you
 * already own it`,随机打红 1 个集成文件。受控复现:全新卷 8 路并发
 * `ensureBuckets()` = `OK | ERR×7`(3/3 轮命中);桶已存在时 8/8 OK(证明窗口 = 桶缺失期)。
 *
 * 本文件用内存替身在**单元层**确定性承载该竞态与「不得过度吞错」的反例;
 * 真机面由 `minio.integration.test.ts` / `descriptor-publish.integration.test.ts`
 * 等容器门控套件承载。
 */

import { describe, expect, it } from "vitest";
import { MinioChallengeBundleStore, PersistenceError } from "../../src/persistence/index.js";
import type { MinioLike } from "../../src/persistence/index.js";

/** 内存 MinIO 替身:可注入 `bucketExists` / `makeBucket` 的行为。 */
class FakeMinio implements Pick<MinioLike, "bucketExists" | "makeBucket"> {
  readonly created: string[] = [];

  constructor(
    private readonly exists: boolean,
    private readonly makeBucketError?: { code?: string },
  ) {}

  async bucketExists(): Promise<boolean> {
    return this.exists;
  }

  async makeBucket(bucket: string): Promise<void> {
    if (this.makeBucketError !== undefined) {
      throw Object.assign(new Error("makeBucket 失败"), this.makeBucketError);
    }
    this.created.push(bucket);
  }
}

function store(client: FakeMinio): MinioChallengeBundleStore {
  return new MinioChallengeBundleStore(client as unknown as MinioLike, {
    bucketPrivate: "private-bundles",
    bucketPublic: "public-descriptors",
  });
}

describe("题目双包对象存储:建桶引导的并发竞态", () => {
  it("桶已被他人创建(S3 返回 BucketAlreadyOwnedByYou)时建桶引导不得失败", async () => {
    const client = new FakeMinio(false, { code: "BucketAlreadyOwnedByYou" });
    await expect(store(client).ensureBuckets()).resolves.toBeUndefined();
  });

  it("桶已被他人创建(另一种错误码 BucketAlreadyExists)时建桶引导同样不得失败", async () => {
    const client = new FakeMinio(false, { code: "BucketAlreadyExists" });
    await expect(store(client).ensureBuckets()).resolves.toBeUndefined();
  });

  it("其它建桶错误仍然 fail-closed(不得把权限 / 不可达类错误一并吞掉)", async () => {
    const client = new FakeMinio(false, { code: "AccessDenied" });
    await expect(store(client).ensureBuckets()).rejects.toBeInstanceOf(PersistenceError);
  });

  it("桶不存在且建桶成功时逐个创建两个桶", async () => {
    const client = new FakeMinio(false);
    await store(client).ensureBuckets();
    expect(client.created).toEqual(["private-bundles", "public-descriptors"]);
  });

  it("桶已存在时不重复建桶(幂等)", async () => {
    const client = new FakeMinio(true);
    await store(client).ensureBuckets();
    expect(client.created).toEqual([]);
  });
});

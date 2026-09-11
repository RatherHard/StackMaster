/**
 * 正式下发通道 E2E 题目登记帮手(WP-54;沿 k6/seed-challenge.mjs 的真实登记
 * 路径,公开描述包替换为 `e2e/fixtures/formal-descriptor.json` 语料——携带
 * hintLadder / publicErrorMapping / debugMode / encodingTable,供 descriptor
 * 端点正式下发驱动工作区教学面)。
 *
 * 职责与 seed-challenge.mjs 同构:
 *  - 公开描述包 = formal-descriptor.json(`challengeId` 字段以 CLI 参数的
 *    每用例唯一 ID 覆写;其余字段原样——语料本身即 Schema 校验锚,见
 *    `packages/challenge-schema/test/fixture-consistency.test.ts`);
 *  - 私有判题包 = 生命周期教学题同源形态(challengeId 同步覆写;内容全部
 *    合成占位,FLAG{lifecycle} 为引擎测试同款占位,非真实秘密);
 *  - Ed25519 每次生成临时密钥对签名登记(ChallengeRegistrar 真实验签);
 *  - 版本不可变:同一 (challengeId, version) 重复登记确定性拒绝 → 已存在即
 *    复用(与 fixtures.ts 每用例唯一 challengeId 的隔离纪律配合,复跑不残留)。
 *
 * 用法(经 spawnSync + --env-file 调用,env 缺省值见 compose/integration.env;
 * 供 e2e/fixtures.ts / descriptor.spec.ts 的 seedFormalChallenge 复用):
 *   node --env-file=compose/integration.env \
 *     e2e/helpers/seed-formal-challenge.mjs \
 *     --challenge-id <id> --tenant-id <tenant>    # cwd = apps/session-api
 *
 * 本文件为纯 JavaScript + JSDoc(.mjs 不经 TS 编译,与 issue-embed-token.mjs
 * 同纪律);session-api 产物经运行时相对路径 import(不发静态依赖边)。
 */
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/** 本文件目录(apps/plugin-dev/e2e/helpers)。 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
/** session-api 包目录(compose / integration.env / dist 相对锚点)。 */
const SESSION_API_DIR = join(HERE, "..", "..", "..", "..", "apps", "session-api");
/** 正式下发语料(challengeId 占位,CLI 参数覆写)。 */
const FORMAL_DESCRIPTOR_PATH = join(HERE, "..", "fixtures", "formal-descriptor.json");
/** 内容版本(与 E2E 题目上下文常量同值)。 */
const CONTENT_VERSION = "1.0.0";

// session-api 构建产物(真实登记路径;dist 由 pnpm build 产出)。
const persistence = await import(
  pathToFileURL(join(SESSION_API_DIR, "dist", "persistence", "index.js")).href
);

/** 正式下发题私有判题包(challengeId 覆写;生命周期教学题同源形态)。
 *  语料公开包携带 `vmProfile.encodingTable`(字节权威执行模式声明,G5/D6)
 *  ⇒ 私有包必须走字节模式:`compiledIr` 省略 + `entrypointAddressHex` 入口
 *  (XS-PROG-MODE 双程序形态恰一;入口 = 代码区首字节 0xc3 = ret)。 */
function lifecycleBundle(challengeId) {
  const A32_REGION = 4096;
  const CODE_BASE = "0x401000";
  const BUFFER_BASE = "0x20000000";
  const SECRET_BASE = "0x20001000";
  const STACK_BASE = "0x7ffff000";
  const zeroHex = (bytes) => "00".repeat(bytes);
  const codeContent = "c3" + zeroHex(A32_REGION - 1);
  return {
    schemaVersion: 1,
    challengeId,
    challengeContentVersion: CONTENT_VERSION,
    vmProfileVersion: "1.0.0",
    dslSchemaVersion: 2,
    vmEngineVersion: "0.1.0",
    declaredSeedPublicPaths: [],
    seedPolicy: { strategy: "fixed", seedHex: "00112233445566778899aabbccddeeff" },
    initialState: {
      registers: { RSP: "0x7ffff008", RBP: "0x7ffff008", RIP: "0x0", RAX: "0x0", FLAG_SYS: "0x0" },
      memoryRegions: [
        { regionId: "code", kind: "code", startAddressHex: CODE_BASE, byteLength: 4096, permissions: "rx", contentHex: codeContent, isHidden: false },
        { regionId: "buffer", kind: "heap", startAddressHex: BUFFER_BASE, byteLength: 4096, permissions: "rw", contentHex: zeroHex(4096), isHidden: false },
        { regionId: "secret", kind: "key", startAddressHex: SECRET_BASE, byteLength: 4096, permissions: "rw", contentHex: zeroHex(4096), isHidden: true },
        { regionId: "stack", kind: "stack", startAddressHex: STACK_BASE, byteLength: 4096, permissions: "rw", contentHex: zeroHex(4096), isHidden: false },
      ],
    },
    secrets: { flag: "FLAG{lifecycle}", virtualFiles: [] },
    privateObjects: [],
    judging: {
      successCondition: {
        all: [{ all: [{ predicate: { type: "register_equals", register: "RAX", valueHex: "0x41" } }] }],
      },
    },
    // 字节模式(XS-PROG-MODE:与公开 encodingTable 配对;compiledIr 省略)。
    entrypointAddressHex: CODE_BASE,
    judgingConfig: { verdictRuleVersion: "1.0.0", maxPredicateEvalSteps: 10000 },
  };
}

/** 正式下发公开描述包(语料 challengeId → 每用例唯一 ID 覆写)。 */
function formalDescriptor(challengeId) {
  const raw = readFileSync(FORMAL_DESCRIPTOR_PATH, "utf8");
  const descriptor = JSON.parse(raw);
  descriptor.challengeId = challengeId;
  return Buffer.from(JSON.stringify(descriptor), "utf8");
}

/**
 * 执行登记(真实验签路径;返回 void,失败抛错)。由 CLI 入口与
 * seedFormalChallenge(spawn 侧)共用。
 */
export async function registerFormalChallenge(challengeId, tenantId) {
  const postgresUrl = process.env["SESSION_API_POSTGRES_URL"];
  if (postgresUrl === undefined || postgresUrl === "") {
    console.error("缺少 SESSION_API_POSTGRES_URL(--env-file=compose/integration.env)");
    process.exit(1);
  }
  const pool = await persistence.createPostgresPool(postgresUrl, 3);
  try {
    const registry = new persistence.PostgresChallengeRegistry(pool);
    const minio = await persistence.createMinioClient({
      endpoint: process.env["SESSION_API_MINIO_ENDPOINT"] || "127.0.0.1",
      port: Number(process.env["SESSION_API_MINIO_PORT"] || "19000"),
      accessKey: process.env["SESSION_API_MINIO_ACCESS_KEY"] || "stackmaster-dev",
      secretKey: process.env["SESSION_API_MINIO_SECRET_KEY"] || "stackmaster-dev-secret",
    });
    const bundles = new persistence.MinioChallengeBundleStore(minio, {
      bucketPrivate: process.env["SESSION_API_MINIO_BUCKET_PRIVATE"] || "private-bundles",
      bucketPublic: process.env["SESSION_API_MINIO_BUCKET_PUBLIC"] || "public-descriptors",
    });
    await bundles.ensureBuckets();

    const privateBundle = Buffer.from(JSON.stringify(lifecycleBundle(challengeId)), "utf8");
    const publicDescriptor = formalDescriptor(challengeId);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signature = cryptoSign(
      null,
      Buffer.from(
        persistence.registrationSignatureBasis({
          challengeId,
          contentVersion: CONTENT_VERSION,
          vmProfileVersion: "1.0.0",
          privateBundleSha256: persistence.sha256Hex(privateBundle),
          publicDescriptorSha256: persistence.sha256Hex(publicDescriptor),
        }),
        "utf8",
      ),
      privateKey,
    ).toString("base64");
    try {
      await new persistence.ChallengeRegistrar({ bundles, registry, signingPublicKey: publicKey }).register({
        tenantId,
        challengeId,
        contentVersion: CONTENT_VERSION,
        vmProfileVersion: "1.0.0",
        privateBundle,
        publicDescriptor,
        signature,
      });
      console.log(`[e2e:seed-formal] 正式下发题已登记:${tenantId}/${challengeId}@${CONTENT_VERSION}`);
    } catch (error) {
      // 版本不可变:已存在即复用(存在性复核兜底;与 k6 seed 同语义)。
      const existing = await registry.findChallengeVersion(challengeId, CONTENT_VERSION, tenantId);
      if (existing !== null) {
        console.log(`[e2e:seed-formal] 正式下发题已存在,复用:${tenantId}/${challengeId}@${CONTENT_VERSION}`);
      } else {
        throw error;
      }
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * spawn 侧入口(e2e 规格夹具消费):以子进程 + --env-file 复跑本脚本 CLI,
 * 沿 compose.ts 的 seedChallenge 同款装配(env-file 提供 PG / MinIO 变量)。
 */
export function seedFormalChallenge(env) {
  // 子进程入口 = 纯绝对路径(node 直接执行 .mjs;不得传 file:// URL——会被
  // 当作相对路径拼到 cwd 下)。
  const selfPath = join(HERE, "seed-formal-challenge.mjs");
  const result = spawnSync(
    process.execPath,
    [
      `--env-file=${join(SESSION_API_DIR, "compose", "integration.env")}`,
      selfPath,
      "--challenge-id",
      env.challengeId,
      "--tenant-id",
      env.tenantId,
    ],
    {
      cwd: SESSION_API_DIR,
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
      timeout: 120_000,
    },
  );
  if (result.status !== 0 || result.error !== undefined) {
    const reason = result.error instanceof Error ? ` (${result.error.message})` : "";
    throw new Error(`seed-formal-challenge 失败:exit=${result.status ?? "n/a"}${reason}`);
  }
}

// ── CLI 入口(直接执行本文件时;被 import 时不触发)────────────────────────
const argv = process.argv.slice(2);
const invokedAsCli = argv.includes("--challenge-id");
if (invokedAsCli) {
  const optionOf = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? (argv[index + 1] ?? "") : "";
  };
  const challengeId = optionOf("--challenge-id");
  const tenantId = optionOf("--tenant-id");
  if (challengeId === "" || tenantId === "") {
    console.error("用法:seed-formal-challenge.mjs --challenge-id <id> --tenant-id <tenant>(cwd = apps/session-api)");
    process.exit(1);
  }
  try {
    await registerFormalChallenge(challengeId, tenantId);
  } catch (error) {
    process.stderr.write(`[seed-formal-challenge] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

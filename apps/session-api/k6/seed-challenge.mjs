/**
 * k6 基线题目种子(阶段三 WP-8;D-API-73)。
 *
 * 经持久化端口把 k6 基线题目(生命周期教学题,与 test/compose/helpers/
 * lifecycle-challenge.ts 同一常量面——引擎侧已验证的合法装载形态)登记进
 * compose 拓扑的 PostgreSQL / MinIO:双包入对象存储 → 版本行落库(真实验签)。
 * 内容全部为合成占位(FLAG{lifecycle} 为引擎测试同款占位,非真实秘密)。
 *
 * 用法(run-baseline.mjs 自动调用;手工):
 *   node --env-file=compose/integration.env k6/seed-challenge.mjs
 *
 * 环境变量:SESSION_API_POSTGRES_URL / SESSION_API_MINIO_ENDPOINT /
 * SESSION_API_MINIO_PORT / SESSION_API_MINIO_ACCESS_KEY / SESSION_API_MINIO_SECRET_KEY、
 * 可选 K6_CHALLENGE_ID(缺省 chal-k6-baseline)、K6_TENANT_ID(缺省 k6-tenant)。
 */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import {
  ChallengeRegistrar,
  MinioChallengeBundleStore,
  PostgresChallengeRegistry,
  createMinioClient,
  createPostgresPool,
  registrationSignatureBasis,
  sha256Hex,
} from "../dist/persistence/index.js";

const CHALLENGE_ID = process.env.K6_CHALLENGE_ID || "chal-k6-baseline";
const TENANT_ID = process.env.K6_TENANT_ID || "k6-tenant";
const CONTENT_VERSION = "1.0.0";

// ── 生命周期教学题(与 test/compose/helpers/lifecycle-challenge.ts 同源)──
const A32_REGION = 4096;
const CODE_BASE = "0x401000";
const BUFFER_BASE = "0x20000000";
const SECRET_BASE = "0x20001000";
const STACK_BASE = "0x7ffff000";

const zeroHex = (bytes) => "00".repeat(bytes);
const codeContent = "c3" + "00".repeat(A32_REGION - 1);

function lifecycleBundle() {
  return {
    schemaVersion: 1,
    challengeId: CHALLENGE_ID,
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
    compiledIr: { irFormatVersion: 2, entrypointIndex: 0, instructions: [{ op: "ret", operands: [] }], labels: [] },
    judgingConfig: { verdictRuleVersion: "1.0.0", maxPredicateEvalSteps: 10000 },
  };
}

function lifecycleDescriptor() {
  const codeWindow = "c3" + "00".repeat(255);
  return {
    schemaVersion: 1,
    challengeId: CHALLENGE_ID,
    challengeContentVersion: CONTENT_VERSION,
    vmProfileVersion: "1.0.0",
    locale: "zh-CN",
    briefing: {
      title: "k6 基线压测题",
      summary: "可观测基线首采的负载题目(生命周期教学题同源形态)。",
      learningObjectives: ["理解会话时间线"],
    },
    vmProfile: {
      registers: [{ name: "RSP" }, { name: "RBP" }, { name: "RIP" }, { name: "RAX" }],
      flagRegisterNames: ["FLAG_SYS"],
      endianness: "little",
      archBits: 32,
      pageSizeBytes: 4096,
      canary: { enabled: false },
    },
    memoryLayout: {
      regions: [
        { regionId: "code", kind: "code", startAddressHex: CODE_BASE, byteLength: 4096, permissions: "rx", publicLabel: "代码区" },
        { regionId: "buffer", kind: "heap", startAddressHex: BUFFER_BASE, byteLength: 4096, permissions: "rw", publicLabel: "缓冲区" },
        { regionId: "stack", kind: "stack", startAddressHex: STACK_BASE, byteLength: 4096, permissions: "rw", publicLabel: "栈" },
      ],
    },
    allowedActions: [
      "write_bytes", "push", "pop", "call", "ret", "step", "run_to_event",
      "pause", "undo", "checkout_checkpoint", "reset", "create_checkpoint",
    ],
    resourceLimits: {},
    hintLadder: [],
    publicErrorMapping: [],
    initialProjection: {
      visibleRegions: [
        { regionId: "code", label: "代码区", startAddressHex: CODE_BASE, byteLength: 4096, permissions: "rx", bytesHex: codeWindow, truncated: true },
        { regionId: "buffer", label: "缓冲区", startAddressHex: BUFFER_BASE, byteLength: 4096, permissions: "rw", bytesHex: zeroHex(256), truncated: true },
        { regionId: "stack", label: "栈", startAddressHex: STACK_BASE, byteLength: 4096, permissions: "rw", bytesHex: zeroHex(256), truncated: true },
      ],
      visibleRegisters: [
        { name: "RSP", valueHex: "0x7FFFF008" },
        { name: "RBP", valueHex: "0x7FFFF008" },
        { name: "RIP", valueHex: "0x0" },
        { name: "RAX", valueHex: "0x0" },
      ],
    },
  };
}

const postgresUrl = process.env.SESSION_API_POSTGRES_URL;
if (postgresUrl === undefined || postgresUrl === "") {
  console.error("缺少 SESSION_API_POSTGRES_URL(--env-file=compose/integration.env)");
  process.exit(1);
}
const pool = await createPostgresPool(postgresUrl, 3);
try {
  const registry = new PostgresChallengeRegistry(pool);
  const minio = await createMinioClient({
    endpoint: process.env.SESSION_API_MINIO_ENDPOINT || "127.0.0.1",
    port: Number(process.env.SESSION_API_MINIO_PORT || "19000"),
    accessKey: process.env.SESSION_API_MINIO_ACCESS_KEY || "stackmaster-dev",
    secretKey: process.env.SESSION_API_MINIO_SECRET_KEY || "stackmaster-dev-secret",
  });
  const bundles = new MinioChallengeBundleStore(minio, {
    bucketPrivate: process.env.SESSION_API_MINIO_BUCKET_PRIVATE || "private-bundles",
    bucketPublic: process.env.SESSION_API_MINIO_BUCKET_PUBLIC || "public-descriptors",
  });
  await bundles.ensureBuckets();

  const privateBundle = Buffer.from(JSON.stringify(lifecycleBundle()), "utf8");
  const publicDescriptor = Buffer.from(JSON.stringify(lifecycleDescriptor()), "utf8");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signature = cryptoSign(
    null,
    Buffer.from(
      registrationSignatureBasis({
        challengeId: CHALLENGE_ID,
        contentVersion: CONTENT_VERSION,
        vmProfileVersion: "1.0.0",
        privateBundleSha256: sha256Hex(privateBundle),
        publicDescriptorSha256: sha256Hex(publicDescriptor),
      }),
      "utf8",
    ),
    privateKey,
  ).toString("base64");
  try {
    await new ChallengeRegistrar({
      bundles,
      registry,
      signingPublicKey: publicKey,
    }).register({
      tenantId: TENANT_ID,
      challengeId: CHALLENGE_ID,
      contentVersion: CONTENT_VERSION,
      vmProfileVersion: "1.0.0",
      privateBundle,
      publicDescriptor,
      signature,
    });
    console.log(`[k6:seed] 题目已登记:${TENANT_ID}/${CHALLENGE_ID}@${CONTENT_VERSION}`);
  } catch (error) {
    // 版本不可变:同一 (challengeId, version) 重复登记确定性拒绝;已存在即复用
    // (双包 putPrivate / putPublic 为覆盖写,内容同源)。存在性复核兜底。
    const existing = await registry.findChallengeVersion(CHALLENGE_ID, CONTENT_VERSION, TENANT_ID);
    if (existing !== null) {
      console.log(`[k6:seed] 题目已存在,复用:${TENANT_ID}/${CHALLENGE_ID}@${CONTENT_VERSION}`);
    } else {
      throw error;
    }
  }
} finally {
  await pool.end().catch(() => undefined);
}

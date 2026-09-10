/**
 * 启动必备键的测试专用 fixture(WP-2 / WP-3 共用;与 test/config.test.ts 与
 * compose/.env.example 同值域:本地开发端口与合成密钥,非真实凭据)。
 *
 * 用途:不验证配置闸本身的测试(logging / server / boot)需要一份能通过
 * 三道闸的合法环境;必备键缺失的 fail-closed 拒绝路径由 test/config.test.ts
 * 与 boot 集成测试的失败用例独立覆盖,不因本 fixture 削弱。
 */

import { generateKeyPairSync } from "node:crypto";

/** WP-3 持久化面必备键(PostgreSQL / Redis / MinIO 端点与快照加密密钥)。 */
export const REQUIRED_STORAGE_ENV: Record<string, string> = {
  SESSION_API_POSTGRES_URL: "postgres://stackmaster:stackmaster-dev@127.0.0.1:15432/session_api",
  SESSION_API_REDIS_URL: "redis://127.0.0.1:16379/0",
  SESSION_API_MINIO_ENDPOINT: "127.0.0.1",
  SESSION_API_MINIO_ACCESS_KEY: "stackmaster-dev",
  SESSION_API_MINIO_SECRET_KEY: "stackmaster-dev-secret",
  SESSION_API_SNAPSHOT_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
};

/** WP-2 认证面必备键(Ed25519 签发私钥 PEM——进程内生成;宿主后端共享凭证)。 */
export const SIGNING_KEY_PEM: string = (() => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
})();

export const HOST_BACKEND_TOKEN = "host-backend-shared-credential-0123456789";

export const REQUIRED_AUTH_ENV: Record<string, string> = {
  SESSION_API_SIGNING_KEY: SIGNING_KEY_PEM,
  SESSION_API_HOST_BACKEND_TOKEN: HOST_BACKEND_TOKEN,
};

/** 全部启动必备键的合法 fixture(测试进程 / 注入测试共用)。 */
export const REQUIRED_ENV_FIXTURE: Record<string, string> = {
  ...REQUIRED_STORAGE_ENV,
  ...REQUIRED_AUTH_ENV,
};

#!/bin/sh
# verifier 独立 MinIO 角色治理(WP-61;信任域 4 最小授权面:仅 private-bundles GET)。
#
# 形态:compose 一次性 init 服务(minio/mc 镜像)——创建受限用户 verifier
# 并挂载 s3:GetObject-only 策略(verifier-minio-policy.json);与 session-api
# 的读写凭证不共享(D-API-87)。幂等:用户 / 策略已存在时继续(挂载重复执行
# 无害)。凭据为本地开发 / CI 专用合成值,严禁用于任何真实环境。

set -eu

 until mc alias set local "http://${MINIO_ENDPOINT:-minio}:9000" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" 2>/dev/null; do
  sleep 1
done

mc admin user add local "$VERIFIER_ACCESS_KEY" "$VERIFIER_SECRET_KEY" 2>/dev/null || \
  echo "verifier user already exists"

# minio/mc 镜像无 grep:幂等以 create 的失败容忍表达(已存在 = 继续挂载)。
mc admin policy create local verifier-private-read /policy.json 2>/dev/null || \
  echo "verifier-private-read policy already exists"

mc admin policy attach local verifier-private-read --user "$VERIFIER_ACCESS_KEY" || true

echo "verifier minio user ready (GetObject on private-bundles/* and public-descriptors/* only)"

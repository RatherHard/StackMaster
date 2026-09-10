# 阶段三 WP-7:session-api 生产镜像(多阶段;D-API-64)。
#
# 形态:
#   1. Rust 阶段:vm-engine workspace 构建 vm-worker(linux 二进制;
#      WORKER_CARGO_PROFILE 默认 debug 控制本地构建时长,CI 传 release);
#   2. Node 阶段:全 workspace pnpm install + 构建 session-api 及其
#      workspace 依赖(protocol / challenge-schema / challenge-compiler /
#      session-core);
#   3. 运行时镜像:dist + migrations + compose 资产 + /app/bin/vm-worker。
#
# 容器内 ensureWorkerBinary 的产物解析(packages/session-core worker-binary):
# STACKMASTER_WORKER_BIN 直接命中镜像内二进制(解析序第一优先),不触发
# cargo 构建。vm-worker 不是常驻服务:由编排器按会话 spawn(ADR-3 单会话
# 单进程);拓扑第五元素以"镜像内二进制 + 会话期子进程"形态交付(compose
# 中的 vm-worker 服务仅做 linux 二进制冒烟,见 compose/app.yaml)。
#
# 构建(在仓库根):
#   docker build -f apps/session-api/Dockerfile -t stackmaster/session-api:dev .
# 或经 compose:
#   docker compose -f apps/session-api/compose/deps.yaml -f apps/session-api/compose/app.yaml up -d --build --wait

# ── 1. vm-worker(linux)─────────────────────────────────────────────────────
FROM rust:1-bookworm AS worker-build
WORKDIR /build
COPY vm-engine/Cargo.toml vm-engine/Cargo.lock ./
COPY vm-engine/vm-core ./vm-core
COPY vm-engine/vm-runtime ./vm-runtime
COPY vm-engine/projection ./projection
COPY vm-engine/vm-worker ./vm-worker
# worker 契约层以 include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/..."))
# 内嵌冻结 JSON Schema——装载仓库内同批落盘文件(worker 二进制自包含)。
COPY packages/protocol/schema /packages/protocol/schema
COPY packages/challenge-schema/schema /packages/challenge-schema/schema
# WORKER_CARGO_PROFILE=debug(本地默认,控制构建时长)| release(CI)。
ARG WORKER_CARGO_PROFILE=debug
RUN if [ "$WORKER_CARGO_PROFILE" = "release" ]; then \
      cargo build -p vm-worker --release; \
    else \
      cargo build -p vm-worker; \
    fi \
    && mkdir -p /out \
    && cp $( [ "$WORKER_CARGO_PROFILE" = "release" ] \
        && echo target/release/vm-worker \
        || echo target/debug/vm-worker ) /out/vm-worker

# ── 2. TS 构建图 ─────────────────────────────────────────────────────────────
FROM node:22-bookworm AS ts-build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
# session-api 及其 workspace 依赖(拓扑序;tsc -b project references)。
RUN pnpm --filter @stackmaster/session-api... run build

# ── 3. 运行时 ────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
WORKDIR /app
# 合成 dev 密钥面仅本地 / CI 拓扑使用;真实环境密钥经编排面注入,不入镜像。
ENV SESSION_API_HOST=0.0.0.0 \
    SESSION_API_PORT=3000 \
    STACKMASTER_WORKER_BIN=/app/bin/vm-worker
COPY --from=ts-build /app ./
COPY --from=worker-build /out/vm-worker /app/bin/vm-worker
RUN chmod 0755 /app/bin/vm-worker
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s --retries=24 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/session-api/dist/index.js"]

/**
 * 容器形态 Worker 隔离集成测试(WP-66;真实镜像 + 真实 vm-worker 容器)。
 *
 * 承载:session-core `createContainerLauncherFactory` 以 **复用 session-api
 * 同一镜像**(stackmaster/session-api:dev;镜像内 /app/bin/vm-worker,§四.4
 * 同锁的结构性保证,D-API-87 verifier 先例同构)拉起每会话一容器,经既有
 * 信封协议全链路驱动。
 *
 * 门控与义务登记:
 *  - `SESSION_API_COMPOSE=1`(test:compose 入口;pnpm test 恒跳过);
 *  - 本机 `docker image inspect` 探测镜像在场 —— 镜像缺失(如 CI 尚未构建、
 *    registry 间歇不可达)则如实跳过并登记 CI 复跑义务(沿 WP-62/63/65
 *    先例:CI compose-integration job 始终完整容器拓扑,镜像由 run.mjs 构建);
 *  - 运行参数断言读真实运行中容器的 `docker inspect`(结构闸),禁网络出口
 *    另加行为级红灯语料(--network none 下出网即败)。
 *
 * 覆盖面(WP-66 完成标准逐项):
 *  ①容器形态全生命周期(会话全生命周期 + 断线恢复由 compose 全拓扑套件
 *    以进程池零回退形态承载;容器形态在此实跑关键链路);
 *  ②强制终止零残留(容器 kill + 移除;9.1"强制终止后必须清理任务状态");
 *  ③崩溃替换恢复(kill → recover,与进程池同构);
 *  ④禁网络出口红灯 + 运行参数结构闸(cgroup / 只读 / tmpfs / 最小权限);
 *  ⑤冷启动量化(容器创建到 ready 实测,登记判据面)。
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import { canonicalize } from "@stackmaster/protocol";
import {
  createContainerLauncherFactory,
  SessionOrchestrator,
  WorkerConnection,
  type ContainerWorkerSpec,
} from "@stackmaster/session-core";

import {
  COMPOSE_ENABLED,
  SKIP_REASON,
} from "./helpers/topology.js";
import {
  lifecycleBundle,
  lifecycleDescriptor,
} from "./helpers/lifecycle-challenge.js";

const exec = promisify(execFile);

/** worker 镜像(镜像策略 = 复用 session-api 同一镜像;compose 构建 / 本机已构建)。 */
const WORKER_IMAGE = process.env["SESSION_API_WORKER_CONTAINER_IMAGE"] ?? "stackmaster/session-api:dev";

/** 镜像在场探测(模块加载期一次性;缺失 = 如实跳过 + CI 复跑义务)。 */
function imageAvailable(): boolean {
  const probe = spawnSync("docker", ["image", "inspect", WORKER_IMAGE], {
    stdio: "ignore",
    windowsHide: true,
  });
  return probe.status === 0;
}

const IMAGE_READY = imageAvailable();
const SKIP_IMAGE_REASON =
  `跳过原因:worker 镜像 ${WORKER_IMAGE} 本地不在场` +
  "(docker image inspect 失败;容器形态实跑需要本机已构建镜像 —— " +
  "compose 构建:docker compose -f compose/deps.yaml -f compose/app.yaml build,或 CI 复跑义务承接)";

/** 每次运行唯一的会话 ID 域(容器名确定性派生;对残留容器免疫)。 */
const runSuffix = Math.random().toString(16).slice(2, 10);

/** 容器形态规格(真实镜像;运行参数与 config 缺省同值,D-API-105)。 */
const containerSpec: ContainerWorkerSpec = {
  image: WORKER_IMAGE,
  workerPath: "/app/bin/vm-worker",
  cpus: 1,
  memoryBytes: 268435456,
  pidsLimit: 64,
};

const createOptions = (sessionId: string) => ({
  sessionId,
  privateBundle: lifecycleBundle(`wp66-container-${runSuffix}`),
  publicDescriptor: lifecycleDescriptor(`wp66-container-${runSuffix}`),
  workerLauncherFactory: createContainerLauncherFactory(containerSpec),
});

/** 残留断言:docker ps -a 对会话容器名零命中(容器移除 = 任务状态清理的结构面)。 */
async function assertNoContainerResidue(sessionId: string): Promise<void> {
  const { stdout } = await exec("docker", [
    "ps", "-a", "--filter", `name=sm-worker-${sessionId}`, "--format", "{{.ID}}",
  ], { windowsHide: true });
  expect(stdout.trim(), `容器残留:sm-worker-${sessionId} 在 docker ps -a 命中`).toBe("");
}

/** 读取运行中容器的 inspect 面结构闸。 */
async function inspectContainer(sessionId: string): Promise<{
  HostConfig: {
    NetworkMode: string;
    ReadonlyRootfs: boolean;
    Memory: number;
    NanoCpus: number;
    PidsLimit: number;
    CapDrop: string[];
    Tmpfs: Record<string, string>;
  };
  NetworkSettings: { Networks: Record<string, unknown> };
}> {
  const { stdout } = await exec("docker", ["inspect", `sm-worker-${sessionId}`], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout)[0];
}

describe.skipIf(!COMPOSE_ENABLED || !IMAGE_READY)(
  `容器形态 Worker 隔离(真实镜像 ${WORKER_IMAGE};${COMPOSE_ENABLED ? "" : SKIP_REASON}${IMAGE_READY ? "" : SKIP_IMAGE_REASON})`,
  () => {
    it("容器形态全生命周期:ready → 动作 → checkpoint → undo → checkout → submit 引用 → 优雅关闭,容器随会话终了移除(零残留)", { timeout: 120_000 }, async () => {
      const sessionId = `sess-wp66-life-${runSuffix}`;
      const session = await SessionOrchestrator.create(createOptions(sessionId));
      expect(session.revision).toBe(0);
      expect(session.projection.visibleRegions.map((r) => r.regionId)).toEqual([
        "code", "buffer", "stack",
      ]);

      // 容器确以会话名在场(每会话一容器)。
      const inspect = await inspectContainer(sessionId);
      expect(inspect.HostConfig.NetworkMode).toBe("none");

      // 全生命周期脚本(与进程形态 integration.worker.test.ts 同构)。
      const write = await session.applyAction({
        type: "write_bytes",
        args: { addressHex: "0x20000000", bytesHex: "deadbeef" },
      });
      expect(write.status).toBe("running");
      expect(write.revision).toBe(1);

      const checkpoint = await session.applyAction({ type: "create_checkpoint", args: { label: "wp66" } });
      expect(checkpoint.revision).toBe(2);
      expect(session.listCheckpoints()).toHaveLength(1);

      await session.applyAction({ type: "write_bytes", args: { addressHex: "0x20000000", bytesHex: "11111111" } });
      const undo = await session.applyAction({ type: "undo", args: {} });
      expect(undo.revision).toBe(4);

      const checkout = await session.applyAction({
        type: "checkout_checkpoint",
        args: { checkpointId: String(session.listCheckpoints()[0]?.checkpointId) },
      });
      expect(checkout.revision).toBe(5);

      const submit = session.submit();
      expect(submit.form).toBe("stackmaster-session-submit/1");
      // 已接受动作:write / checkpoint / write / undo / checkout(拒绝不入账)。
      expect(submit.actionLog).toHaveLength(5);
      expect(submit.actionLog.map((entry) => entry.revisionAfter)).toEqual([1, 2, 3, 4, 5]);
      expect(submit.seedPolicy).toEqual({ strategy: "fixed" });

      // 优雅关闭:worker 退出码 0(graceful),--rm 即弃移除容器。
      await session.closeSession();
      expect(session.phase).toBe("closed");
      await assertNoContainerResidue(sessionId);
    });

    it("强制终止零残留:kill → forced 分类 + 容器移除(9.1 强制终止后必须清理任务状态)", { timeout: 120_000 }, async () => {
      const sessionId = `sess-wp66-kill-${runSuffix}`;
      const session = await SessionOrchestrator.create(createOptions(sessionId));
      await session.applyAction({
        type: "write_bytes",
        args: { addressHex: "0x20000000", bytesHex: "0badc0de" },
      });
      // 运行中容器在场(前置确认:断言的是"强杀后"的清理,非缺位)。
      await inspectContainer(sessionId);

      // 强制终止:waitExit 返回即含补强清理完成(docker rm -f 汇合)。
      const exit = await session.kill();
      expect(exit.kind).toBe("forced");
      await assertNoContainerResidue(sessionId);
    });

    it("崩溃替换恢复:checkpoint 快照 → 容器 kill → recover → revision 续算(容器形态语义保持)", { timeout: 180_000 }, async () => {
      const sessionId = `sess-wp66-recover-${runSuffix}`;
      const session = await SessionOrchestrator.create(createOptions(sessionId));
      await session.applyAction({ type: "write_bytes", args: { addressHex: "0x20000000", bytesHex: "0badc0de" } });
      await session.applyAction({ type: "create_checkpoint", args: { label: "wp66-crash-point" } });
      const receipt = session.listCheckpoints()[0];
      if (!receipt) throw new Error("前置失败:checkpoint 回执缺失");
      const beforeKill = session.projection;
      const revisionAtCrash = session.revision;

      const exit = await session.kill();
      expect(["forced", "crashed"]).toContain(exit.kind);
      await assertNoContainerResidue(sessionId);

      // 崩溃替换恢复:新容器承载(新会话 ID = 新容器名)+ 重新提供装载参数
      // (核心不留存私有包,零驻留)+ 最近快照。
      const recoveredId = `sess-wp66-recovered-${runSuffix}`;
      const recovered = await SessionOrchestrator.recover({
        ...createOptions(recoveredId),
        snapshot: receipt.snapshot,
      });
      expect(recovered.revision).toBe(revisionAtCrash);
      expect(canonicalize(recovered.projection)).toBe(canonicalize(beforeKill));
      expect(recovered.listCheckpoints()).toHaveLength(0);

      const next = await recovered.applyAction({
        type: "write_bytes",
        args: { addressHex: "0x20000000", bytesHex: "cafebabe" },
      });
      expect(next.revision).toBe(revisionAtCrash + 1);
      await recovered.closeSession();
      await assertNoContainerResidue(recoveredId);
    });

    it("运行参数结构闸(运行中容器 docker inspect):禁网络 + 只读 + tmpfs /tmp + cgroup 三闸 + 最小权限", { timeout: 120_000 }, async () => {
      const sessionId = `sess-wp66-args-${runSuffix}`;
      const session = await SessionOrchestrator.create(createOptions(sessionId));
      try {
        const inspect = await inspectContainer(sessionId);
        // 禁网络出口:NetworkMode = none;网络命名空间仅 loopback(无任何可
        // 用出口面 —— 结构性无出口,行为级红灯见下一条)。
        expect(inspect.HostConfig.NetworkMode).toBe("none");
        expect(Object.keys(inspect.NetworkSettings.Networks)).toEqual(["none"]);
        // 只读文件系统 + tmpfs 临时写面(仅 /tmp)。
        expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
        expect(Object.keys(inspect.HostConfig.Tmpfs ?? {})).toEqual(["/tmp"]);
        // cgroup 三闸(配置缺省值:D-API-105 量化登记)。
        expect(inspect.HostConfig.Memory).toBe(268435456);
        expect(inspect.HostConfig.NanoCpus).toBe(1_000_000_000);
        expect(inspect.HostConfig.PidsLimit).toBe(64);
        // 最小权限:全部能力移除 + 禁提权。
        expect(inspect.HostConfig.CapDrop).toContain("ALL");
      } finally {
        await session.closeSession();
        await assertNoContainerResidue(sessionId);
      }
    });

    it("禁网络出口行为级红灯:--network none 容器内出网即败(解析 / 连接失败)", { timeout: 120_000 }, async () => {
      // 行为级语料:同镜像容器在 none 网络下尝试出网 —— fetch 必然失败
      // (网络不可达 / 解析失败;AbortSignal 兜底防悬挂)。出口可用 = 红灯。
      const probe = spawnSync("docker", [
        "run", "--rm", "--network", "none", WORKER_IMAGE,
        "node", "-e",
        "fetch('http://example.com/', { signal: AbortSignal.timeout(8000) })" +
          ".then(() => process.exit(0), () => process.exit(1))",
      ], { windowsHide: true, timeout: 60_000 });
      expect(probe.status, "容器内出网必须失败(--network none 行为级红灯)").toBe(1);
    });

    it("冷启动量化登记:容器创建到 ready 时延实测(判据面:弹性切换与镜像预算登记)", { timeout: 120_000 }, async () => {
      const sessionId = `sess-wp66-cold-${runSuffix}`;
      // 冷启动 = launch(容器创建 + worker 启动)到 ready 帧到达(不含 load)。
      const startedAt = Date.now();
      const { connection, ready } = await WorkerConnection.connect(
        createContainerLauncherFactory(containerSpec)(sessionId),
      );
      const coldStartMs = Date.now() - startedAt;
      // 预算上限(判据面登记):教学规模预算 30 s 内为可用;实测值随运行
      // 输出登记(D-API-105 弹性切换判据:冷启动时延与镜像预算)。
      expect(ready.type).toBe("ready");
      expect(coldStartMs).toBeLessThan(30_000);
      process.stdout.write(
        `[wp66] 冷启动实测(容器创建 → ready):${coldStartMs} ms(预算 30000 ms;镜像 ${WORKER_IMAGE})\n`,
      );
      connection.markClosed();
      connection.kill();
      await connection.waitExit();
      await assertNoContainerResidue(sessionId);
    });
  },
);

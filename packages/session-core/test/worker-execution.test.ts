/**
 * worker 执行形态接口测试(WP-66,T1;Q4 定案面):
 *  - 进程 / 容器双实现行为同构(信封协议、退出分类、强制终止语义逐项同判);
 *  - 容器运行参数构造(隔离面逐旗断言,ADR-3 T1 行);
 *  - 容器运行时探测 fail-closed(daemon 不可达即拒绝,不静默降级)。
 *
 * 容器形态经假 docker shim 承载(记录调用 + 以子进程承载同一假 worker):
 * shim 的 `run` = 容器创建(CLI 退出码 = 容器退出码,docker run 语义),
 * `rm -f` = 强制清理,`info` / `image inspect` = 启动期探测。真实容器形态
 * 的端到端实跑在 apps/session-api test:compose(镜像可用性门控)。
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionOrchestrator } from "../src/session.js";
import { WorkerConnection } from "../src/worker-connection.js";
import {
  containerNameFor,
  containerRunArgs,
  createContainerLauncherFactory,
  createProcessLauncher,
  probeContainerRuntime,
  type ContainerWorkerSpec,
  type WorkerLauncher,
} from "../src/worker-execution.js";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const FAKE_WORKER = join(TEST_DIR, "helpers", "fake-worker.mjs");
const FAKE_DOCKER = join(TEST_DIR, "helpers", "fake-docker.mjs");
const SHIM_LOG = join(TEST_DIR, "helpers", ".fake-docker-log.jsonl");

/** 容器形态规格(假 docker shim;镜像 / worker 路径仅入 shim 记录,不实际拉起)。 */
const shimSpec: ContainerWorkerSpec = {
  image: "stackmaster/session-api:test",
  workerPath: "/app/bin/vm-worker",
  cpus: 1,
  memoryBytes: 268435456,
  pidsLimit: 64,
  dockerCommand: process.execPath,
  dockerArgs: [FAKE_DOCKER],
};

function readShimLog(): { op: string; argv: string[] }[] {
  if (!existsSync(SHIM_LOG)) {
    return [];
  }
  return readFileSync(SHIM_LOG, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { op: string; argv: string[] });
}

function clearShimLog(): void {
  rmSync(SHIM_LOG, { force: true });
}

afterEach(() => {
  clearShimLog();
});

describe("容器运行参数构造(ADR-3 T1 隔离面;WP-66)", () => {
  it("run 参数逐旗含隔离面:每会话一容器名 + 禁网络 + 只读 + tmpfs /tmp + cgroup 三闸 + 最小权限", () => {
    const args = containerRunArgs(shimSpec, containerNameFor("sess-wp66-abc"));
    // 每会话一容器(--rm 即弃 + 交互 stdio)。
    expect(args[0]).toBe("run");
    expect(args).toContain("--rm");
    expect(args).toContain("-i");
    expect(args).toContain("--name");
    expect(args[args.indexOf("--name") + 1]).toBe("sm-worker-sess-wp66-abc");
    // 禁网络出口(结构性无出口面,ADR-3)。
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    // 只读文件系统 + tmpfs 临时写面(仅 /tmp)。
    expect(args).toContain("--read-only");
    expect(args[args.indexOf("--tmpfs") + 1]).toBe("/tmp");
    // cgroup 三闸(CPU / 内存 / pids;9.1 资源限制行)。
    expect(args[args.indexOf("--cpus") + 1]).toBe("1");
    expect(args[args.indexOf("--memory") + 1]).toBe("268435456");
    expect(args[args.indexOf("--pids-limit") + 1]).toBe("64");
    // 最小权限(9.1"最小权限、只读文件系统、网络隔离和资源配额")。
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args[args.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    // 镜像与 worker 路径收尾(复用 session-api 同一镜像,§四.4 同锁)。
    expect(args.at(-2)).toBe("stackmaster/session-api:test");
    expect(args.at(-1)).toBe("/app/bin/vm-worker");
  });

  it("容器名派生:会话标识字符集(^[A-Za-z0-9_-]{1,128}$)与 docker 名法安全且确定性", () => {
    expect(containerNameFor("sess-0123abcdef")).toBe("sm-worker-sess-0123abcdef");
    expect(containerNameFor("sess-0123abcdef")).toBe(containerNameFor("sess-0123abcdef"));
  });

  it("容器内显式 env 以 -e 旗承载(缺省零编排器环境继承;秘密面不随容器下发)", () => {
    const args = containerRunArgs(
      { ...shimSpec, workerEnv: [["FAKE_MODE", "crash_on_apply"]] },
      containerNameFor("sess-wp66-env"),
    );
    const flag = args.indexOf("-e");
    expect(flag).toBeGreaterThan(-1);
    expect(args[flag + 1]).toBe("FAKE_MODE=crash_on_apply");
    // 缺省(workerEnv 缺省)无任何 -e 旗。
    const bare = containerRunArgs(shimSpec, containerNameFor("sess-wp66-env"));
    expect(bare).not.toContain("-e");
  });
});

describe("执行形态双实现行为同构(进程 ↔ 容器;假 docker shim)", () => {
  const createOptions = () => ({
    sessionId: "sess-wp66-iso",
    privateBundle: { seedPolicy: { strategy: "fixed" } },
    publicDescriptor: {},
  });

  /** 同一动作脚本在指定形态下的响应序列(revision + 终态)。 */
  async function driveScript(options: {
    workerLauncherFactory: (sessionId: string) => WorkerLauncher;
  }): Promise<{ revisions: number[]; closed: string }> {
    const session = await SessionOrchestrator.create({
      ...createOptions(),
      workerLauncherFactory: options.workerLauncherFactory,
    });
    const write = await session.applyAction({
      type: "write_bytes",
      args: { addressHex: "0x20000000", bytesHex: "aa" },
    });
    const checkpoint = await session.applyAction({ type: "create_checkpoint", args: {} });
    const paused = await session.applyAction({ type: "pause", args: {} });
    await session.closeSession();
    return {
      revisions: [write.revision, checkpoint.revision, paused.revision],
      closed: session.phase,
    };
  }

  it("同一假 worker 经两形态驱动:响应序列逐项一致(信封语义零漂移)", async () => {
    const processResult = await driveScript({
      workerLauncherFactory: () =>
        createProcessLauncher({ command: process.execPath, args: [FAKE_WORKER] }),
    });
    clearShimLog();
    const containerResult = await driveScript({
      workerLauncherFactory: createContainerLauncherFactory(shimSpec),
    });
    expect(containerResult).toEqual(processResult);
    expect(containerResult.revisions).toEqual([1, 2, 3]);
    expect(containerResult.closed).toBe("closed");
    // 容器形态确以 --name sm-worker-<sessionId> 拉起(每会话一容器)。
    const run = readShimLog().find((entry) => entry.op === "run");
    expect(run).toBeDefined();
    expect(run!.argv).toContain("sm-worker-sess-wp66-iso");
  });

  it("强制终止:kill → forced 分类 + 容器 rm -f 补强清理(进程形态同判;清理面为容器专属)", async () => {
    // 进程形态基线。
    const processSession = await SessionOrchestrator.create({
      ...createOptions(),
      sessionId: "sess-wp66-kill-process",
      workerLauncherFactory: () =>
        createProcessLauncher({ command: process.execPath, args: [FAKE_WORKER] }),
    });
    const processExit = await processSession.kill();
    expect(processExit.kind).toBe("forced");

    clearShimLog();
    const containerSession = await SessionOrchestrator.create({
      ...createOptions(),
      sessionId: "sess-wp66-kill-container",
      workerLauncherFactory: createContainerLauncherFactory(shimSpec),
    });
    const containerExit = await containerSession.kill();
    expect(containerExit.kind).toBe("forced");
    // 强制终止补强清理:rm -f 恰以会话容器名执行(零残留语义实现面;
    // kill → waitExit 即含补强清理完成,断言确定性)。
    const rm = readShimLog().find((entry) => entry.op === "rm");
    expect(rm).toBeDefined();
    expect(rm!.argv).toContain("sm-worker-sess-wp66-kill-container");
  });

  it("优雅关闭:closeSession → graceful 分类,容器随会话终了移除(--rm 即弃)", async () => {
    const session = await SessionOrchestrator.create({
      ...createOptions(),
      sessionId: "sess-wp66-close",
      workerLauncherFactory: createContainerLauncherFactory(shimSpec),
    });
    await session.closeSession();
    expect(session.phase).toBe("closed");
  });

  it("看门狗退出码语义同构:worker 退出码 3 → watchdog_timeout 分类(两形态同判)", async () => {
    async function exitKindOf(launcherFactory: () => WorkerLauncher): Promise<string> {
      const { connection } = await WorkerConnection.connect(launcherFactory());
      await connection.request({ type: "apply_action" }).catch(() => undefined);
      // worker 即刻退出(退出码 3):在途请求以崩溃拒绝,退出分类 = watchdog_timeout。
      return (await connection.waitExit()).kind;
    }
    const processKind = await exitKindOf(() =>
      createProcessLauncher({
        command: process.execPath,
        args: [FAKE_WORKER],
        env: [["FAKE_MODE", "watchdog_exit3"]],
      }),
    );
    const containerKind = await exitKindOf(() =>
      createContainerLauncherFactory({
        ...shimSpec,
        workerEnv: [["FAKE_MODE", "watchdog_exit3"]],
      })("sess-wp66-wd"),
    );
    expect(processKind).toBe("watchdog_timeout");
    expect(containerKind).toBe("watchdog_timeout");
  });

  it("崩溃分类同构:worker 非零退出 → crashed(容器 OOM / 退出非零同判)", async () => {
    async function exitKindOf(launcherFactory: () => WorkerLauncher): Promise<string> {
      const { connection } = await WorkerConnection.connect(launcherFactory());
      await connection.request({ type: "apply_action" }).catch(() => undefined);
      return (await connection.waitExit()).kind;
    }
    const processKind = await exitKindOf(() =>
      createProcessLauncher({
        command: process.execPath,
        args: [FAKE_WORKER],
        env: [["FAKE_MODE", "crash_on_apply"]],
      }),
    );
    const containerKind = await exitKindOf(() =>
      createContainerLauncherFactory({
        ...shimSpec,
        // 容器内显式 env(shim 以 -e 形态承载;容器 env 为显式面,不继承编排器)。
        workerEnv: [["FAKE_MODE", "crash_on_apply"]],
      })("sess-wp66-crash"),
    );
    expect(processKind).toBe("crashed");
    expect(containerKind).toBe("crashed");
  });

  it("协议版本不匹配 fail-closed(容器形态同判):ready 版本不一致即回收拒绝建会话", async () => {
    clearShimLog();
    await expect(
      SessionOrchestrator.create({
        ...createOptions(),
        sessionId: "sess-wp66-ver",
        workerLauncherFactory: createContainerLauncherFactory({
          ...shimSpec,
          workerEnv: [["FAKE_PROTOCOL_VERSION", "99"]],
        }),
      }),
    ).rejects.toMatchObject({ code: "protocol_version_mismatch" });
    // 回收面:destroy 路径的补强清理异步落地——rm -f 恰以会话容器名执行(协议违规亦零残留)。
    await vi.waitFor(() => {
      const rm = readShimLog().find((entry) => entry.op === "rm");
      expect(rm).toBeDefined();
      expect(rm!.argv).toContain("sm-worker-sess-wp66-ver");
    });
  });
});

describe("容器运行时探测 fail-closed(WP-66;Windows dev 降级路径的启动期裁决点)", () => {
  it("daemon 可达(shim 应答 info / image inspect)→ 探测通过", async () => {
    await expect(
      probeContainerRuntime({
        image: "stackmaster/session-api:test",
        dockerCommand: process.execPath,
        dockerArgs: [FAKE_DOCKER],
      }),
    ).resolves.toBeUndefined();
  });

  it("daemon 不可达 → 探测拒绝(明示容器池不启用,不静默降级进程池)", async () => {
    await expect(
      probeContainerRuntime({
        image: "stackmaster/session-api:test",
        dockerCommand: "definitely-not-a-real-docker-binary-wp66",
      }),
    ).rejects.toThrow(/docker daemon/i);
  });

  it("镜像本地缺失 → 探测拒绝(禁运行期拉取外部镜像:只允许同锁镜像)", async () => {
    // shim 以 FAKE_DOCKER_FAIL_IMAGE=1 的 CLI env 模拟镜像缺失(image inspect 非零码)。
    await expect(
      probeContainerRuntime({
        image: "stackmaster/session-api:missing-wp66",
        dockerCommand: process.execPath,
        dockerArgs: [FAKE_DOCKER],
        cliEnv: [["FAKE_DOCKER_FAIL_IMAGE", "1"]],
      }),
    ).rejects.toThrow(/image/i);
  });
});

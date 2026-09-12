/**
 * worker 执行形态端口与双实现(WP-66,T1;Q4 定案;ADR-3 T1 行):
 * 进程池(T0 既有形态)/ 容器池(T1 显式启用形态)行为同构。
 *
 * 抽象层级:执行形态只负责"产出承载进程 + 终止后补强清理";信封协议
 * (NDJSON 帧、seq、stop-and-wait)、ready 握手与退出分类全部留在
 * WorkerConnection 连接层 —— 两形态共享同一协议层,行为语义(信封、
 * 看门狗退出码、强制终止、崩溃分类)结构性一致(同构断言见
 * test/worker-execution.test.ts;真实容器端到端在 session-api test:compose)。
 *
 * 形态语义对照:
 *  - 进程形态:spawn vm-worker 二进制(编排器环境默认继承,既有 T0 形态);
 *  - 容器形态:每会话一容器(`docker run --rm -i`),容器 env 仅取显式
 *    `-e` 面(零编排器环境继承 = 秘密面不随容器下发);CLI 退出码 = 容器
 *    退出码(docker run 语义),worker 退出码 3(看门狗)与非零(崩溃)
 *    逐码传播,分类与进程形态同判;
 *  - 强制终止:SIGKILL 承载进程 + `docker rm -f <name>` 补强清理(容器由
 *    dockerd 管辖,仅杀 CLI 不及容器)—— 9.1"强制终止后必须清理任务状态";
 *    优雅退出由 `--rm` 即弃承载(会话终了容器移除,零跨会话残留)。
 *
 * 容器运行参数(ADR-3 T1 行逐项;缺省值登记于 session-api config,量化
 * 理由与预算接线见 D-API-105):--network none(禁网络出口)/ --read-only
 * + tmpfs /tmp(只读文件系统 + 临时写面)/ --cpus --memory --pids-limit
 * (cgroup 三闸)/ --cap-drop ALL + no-new-privileges(最小权限)。
 */

import { spawn, type ChildProcess } from "node:child_process";

import { OrchestratorError } from "./errors.js";
import type { WorkerCommandSpec } from "./worker-connection.js";
import { ensureWorkerBinary } from "./worker-binary.js";

/** 执行形态标识(受控日志与指标面;不入指标标签,D-API-71 纪律)。 */
export type WorkerExecutionKind = "process" | "container";

/** 已启动的 worker 承载体(连接层消费;进程 / 容器同构)。 */
export interface WorkerLaunch {
  /**
   * 承载进程:进程形态 = vm-worker 本体;容器形态 = docker CLI 前台
   * attach(stdio 经 CLI 透传到容器内 worker)。
   */
  readonly child: ChildProcess;
  /** 承载体描述(受控日志面;容器形态 = 容器名)。 */
  readonly descriptor: string;
  /**
   * 终止后补强清理:容器形态 = `docker rm -f <name>`(幂等,错误忽略);
   * 进程形态 = no-op(SIGKILL 已由连接层执行)。实现保证幂等且至多执行一次。
   */
  dispose(): Promise<void>;
}

/** 执行形态启动器(每会话恰一次 launch;失败即拒绝建会话)。 */
export interface WorkerLauncher {
  readonly kind: WorkerExecutionKind;
  /** 启动承载进程;连接层随后接管 stdio NDJSON 帧协议(两形态同一协议层)。 */
  launch(): Promise<WorkerLaunch>;
}

/** 启动器工厂(装配层按配置选择形态;会话 ID 供容器命名)。 */
export type WorkerLauncherFactory = (sessionId: string) => WorkerLauncher;

/** 会话 → 容器名(确定性派生;sessionId 字符集 ^[A-Za-z0-9_-]{1,128}$ 名法安全)。 */
export function containerNameFor(sessionId: string): string {
  return `sm-worker-${sessionId}`;
}

/**
 * 启动器解析(编排核心的唯一入口):工厂优先(容器池显式启用形态,由装配
 * 层注入);否则进程形态(workerCommand 或按需定位真实二进制,既有缺省路径)。
 */
export async function resolveWorkerLauncher(options: {
  readonly sessionId: string;
  readonly workerLauncherFactory?: WorkerLauncherFactory;
  readonly workerCommand?: WorkerCommandSpec;
}): Promise<WorkerLauncher> {
  if (options.workerLauncherFactory !== undefined) {
    return options.workerLauncherFactory(options.sessionId);
  }
  const command = options.workerCommand ?? { command: await ensureWorkerBinary() };
  return createProcessLauncher(command);
}

// ── 进程形态(T0 既有形态的端口化;行为零改动)────────────────────────────

/** 进程形态启动器:按命令描述 spawn vm-worker 二进制(缺省路径 = 既有语义)。 */
export function createProcessLauncher(command: WorkerCommandSpec): WorkerLauncher {
  return {
    kind: "process",
    launch: async () => {
      const child = spawn(command.command, command.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        ...(command.env === undefined
          ? {}
          : { env: { ...process.env, ...Object.fromEntries(command.env) } }),
        windowsHide: true,
      });
      return {
        child,
        descriptor: command.command,
        dispose: async () => undefined, // 进程形态无补强清理面(SIGKILL 即终止)。
      };
    },
  };
}

// ── 容器形态(T1;每会话一容器)───────────────────────────────────────────

/** 镜像内 vm-worker 路径缺省值(Dockerfile 固定布局 /app/bin/vm-worker;同镜像同路径)。 */
export const CONTAINER_WORKER_PATH_DEFAULT = "/app/bin/vm-worker";

/** 容器形态规格(装配层由 config 冻结形态构造)。 */
export interface ContainerWorkerSpec {
  /** worker 镜像(镜像策略 = 复用 session-api 同一镜像,§四.4 同锁)。 */
  readonly image: string;
  /** 镜像内 worker 可执行路径(同镜像固定布局;缺省 /app/bin/vm-worker)。 */
  readonly workerPath?: string;
  /** cgroup CPU 配额(--cpus,整核)。 */
  readonly cpus: number;
  /** cgroup 内存配额(--memory,字节)。 */
  readonly memoryBytes: number;
  /** pids 上限(--pids-limit;防 fork 炸弹,9.1"无子进程创建")。 */
  readonly pidsLimit: number;
  /** docker CLI(缺省 "docker";测试注入 shim)。 */
  readonly dockerCommand?: string;
  /** docker CLI 前置参数(测试 shim 注入形态)。 */
  readonly dockerArgs?: readonly string[];
  /** 容器内显式 env(`-e K=V`;缺省空 —— 零编排器环境继承)。 */
  readonly workerEnv?: readonly (readonly [string, string])[];
  /** CLI 进程 env 注入(探测旗标等;不影响容器 env)。 */
  readonly cliEnv?: readonly (readonly [string, string])[];
}

/**
 * docker run 参数构造(纯函数;隔离面逐旗可断言)。形态:
 * `run --rm -i --name <name> --network none --read-only --tmpfs /tmp
 *  --cpus N --memory B --pids-limit P --cap-drop ALL --security-opt
 *  no-new-privileges [-e K=V]... <image> <workerPath>`
 */
export function containerRunArgs(spec: ContainerWorkerSpec, containerName: string): string[] {
  const args = [
    "run",
    // 即弃容器(会话终了随退出移除)+ 交互态(stdio 经 CLI 透传)。
    "--rm",
    "-i",
    // 每会话一容器(确定性命名:补强清理与零残留断言的锚点)。
    "--name",
    containerName,
    // 禁网络出口(ADR-3;结构性无出口面)。
    "--network",
    "none",
    // 只读文件系统 + 临时写面(仅 /tmp;会话终了即弃)。
    "--read-only",
    "--tmpfs",
    "/tmp",
    // cgroup 三闸(9.1 资源限制行)。
    "--cpus",
    String(spec.cpus),
    "--memory",
    String(spec.memoryBytes),
    "--pids-limit",
    String(spec.pidsLimit),
    // 最小权限(9.1;全部能力移除 + 禁提权)。
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
  ];
  for (const [key, value] of spec.workerEnv ?? []) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(spec.image, spec.workerPath ?? CONTAINER_WORKER_PATH_DEFAULT);
  return args;
}

/** 容器形态启动器工厂(每会话一容器;名称确定性派生)。 */
export function createContainerLauncherFactory(spec: ContainerWorkerSpec): WorkerLauncherFactory {
  return (sessionId: string) => createContainerLauncher(spec, sessionId);
}

/** 容器形态启动器(单会话;名称由 sessionId 派生)。 */
export function createContainerLauncher(spec: ContainerWorkerSpec, sessionId: string): WorkerLauncher {
  const containerName = containerNameFor(sessionId);
  const dockerCommand = spec.dockerCommand ?? "docker";
  let disposePromise: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    // 幂等且至多一次:kill / destroy / 退出三个触发点共享同一 promise。
    disposePromise ??= new Promise<void>((resolve) => {
      const child = spawn(dockerCommand, [...(spec.dockerArgs ?? []), "rm", "-f", containerName], {
        stdio: "ignore",
        ...(spec.cliEnv === undefined
          ? {}
          : { env: { ...process.env, ...Object.fromEntries(spec.cliEnv) } }),
        windowsHide: true,
      });
      // 清理是尽力面:错误 / 非零码(容器已移除等)一律忽略 —— --rm 已承载
      // 常规移除,rm -f 只补强"CLI 被强杀后容器残留"窗口。
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    return disposePromise;
  };
  return {
    kind: "container",
    launch: async () => {
      const args = [...(spec.dockerArgs ?? []), ...containerRunArgs(spec, containerName)];
      const child = spawn(dockerCommand, args, {
        stdio: ["pipe", "pipe", "pipe"],
        ...(spec.cliEnv === undefined
          ? {}
          : { env: { ...process.env, ...Object.fromEntries(spec.cliEnv) } }),
        windowsHide: true,
      });
      return { child, descriptor: containerName, dispose };
    },
  };
}

// ── 容器运行时探测(启动期 fail-closed 闸)────────────────────────────────

/** 探测规格(daemon 可达 + 镜像本地在场;探测拒绝即启动拒绝)。 */
export interface ContainerProbeSpec {
  readonly image: string;
  readonly dockerCommand?: string;
  readonly dockerArgs?: readonly string[];
  readonly cliEnv?: readonly (readonly [string, string])[];
}

function runCli(spec: ContainerProbeSpec, args: string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.dockerCommand ?? "docker", [...(spec.dockerArgs ?? []), ...args], {
      stdio: "ignore",
      ...(spec.cliEnv === undefined
        ? {}
        : { env: { ...process.env, ...Object.fromEntries(spec.cliEnv) } }),
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("docker CLI 探测超时"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      // CLI 不可执行(ENOENT 等)= 容器运行时不可用(fail-closed 明示面)。
      reject(new Error(`docker daemon 不可达(CLI 执行失败:${error.message})`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

/**
 * 容器池启用前置探测(启动期,fail-closed):①docker daemon 可达;②worker
 * 镜像本地在场。任一失败即抛错 —— 装配层以启动拒绝明示容器池不启用,
 * 不静默降级进程池(Windows dev 降级路径的明示形态);镜像在场检查同时是
 * 供应链闸:worker 容器只允许运行同锁镜像的本地构建,禁运行期拉取外部镜像。
 */
export async function probeContainerRuntime(spec: ContainerProbeSpec): Promise<void> {
  try {
    const daemonCode = await runCli(spec, ["info"], 10_000);
    if (daemonCode !== 0) {
      throw new Error(`docker daemon 不可达(info 退出码 ${daemonCode})`);
    }
    const imageCode = await runCli(spec, ["image", "inspect", spec.image], 10_000);
    if (imageCode !== 0) {
      throw new Error(
        `worker 镜像本地缺失(image inspect 退出码 ${imageCode}):` +
          `${spec.image};容器池只允许同锁镜像的本地在场形态,禁运行期拉取`,
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OrchestratorError(
      "worker_spawn_failed",
      `容器池启用前置探测失败,启动拒绝(fail-closed,不静默降级进程池):${reason}`,
    );
  }
}

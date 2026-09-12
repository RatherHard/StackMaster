/**
 * 装配层 worker 执行形态选择(WP-66;Q4 定案,D-API-105)。
 *
 * 裁决面:
 *  - 缺省 = 进程池(`workerExecutionMode = "process"`,dev / CI 拓扑零回退
 *    —— 不探测、不建工厂,既有路径零改动);
 *  - 容器池 = 显式启用形态(`"container"`),启用前置 = MVP 验收通过(边界
 *    裁决 1,登记不翻转);启用时先经启动期 fail-closed 探测(docker daemon
 *    可达 + worker 镜像本地在场),探测失败即启动拒绝并明示 —— 不静默降级
 *    进程池(Windows dev 降级路径的明示形态);
 *  - 镜像在场检查同时是供应链闸:worker 容器只运行同锁镜像的本地构建,
 *    禁运行期拉取外部镜像(§四.4 同锁的运行时兑现)。
 *
 * 测试注入面:`injectedFactory`(集成替身直通,跳过探测)/ `probe`(假探测)
 * / `dockerCommand`(真实容器形态的 CLI 注入)。
 */
import type { WorkerLauncherFactory } from "@stackmaster/session-core";
import {
  createContainerLauncherFactory,
  probeContainerRuntime,
} from "@stackmaster/session-core";

import type { SessionApiConfig } from "../config.js";

/** 执行形态判定结果(process 形态 launcherFactory 恒缺省 = 既有路径零回退)。 */
export interface WorkerExecutionForm {
  readonly kind: "process" | "container";
  readonly launcherFactory?: WorkerLauncherFactory;
}

export async function resolveWorkerExecutionForm(options: {
  readonly config: Pick<
    SessionApiConfig,
    | "workerExecutionMode"
    | "workerContainerImage"
    | "workerContainerCpus"
    | "workerContainerMemory"
    | "workerContainerPidsLimit"
  >;
  /** 启动期探测(缺省 = session-core probeContainerRuntime;测试注入假探测)。 */
  readonly probe?: () => Promise<void>;
  /** 测试注入的启动器工厂(直通,跳过探测 —— 集成替身形态)。 */
  readonly injectedFactory?: WorkerLauncherFactory;
  /** docker CLI(缺省 "docker";真实容器集成实测注入)。 */
  readonly dockerCommand?: string;
  readonly dockerArgs?: readonly string[];
}): Promise<WorkerExecutionForm> {
  const { config } = options;

  // 测试替身直通:工厂注入即按配置形态返回,不探测。
  if (options.injectedFactory !== undefined) {
    return { kind: config.workerExecutionMode, launcherFactory: options.injectedFactory };
  }

  // 缺省 = 进程池(Q4:零探测、零工厂,dev / CI 拓扑零回退)。
  if (config.workerExecutionMode === "process") {
    return { kind: "process" };
  }

  // 显式启用容器池:启动期 fail-closed 探测(daemon 可达 + 同锁镜像本地在场)。
  const probe =
    options.probe ??
    (() =>
      probeContainerRuntime({
        image: config.workerContainerImage,
        ...(options.dockerCommand === undefined ? {} : { dockerCommand: options.dockerCommand }),
        ...(options.dockerArgs === undefined ? {} : { dockerArgs: options.dockerArgs }),
      }));
  await probe();

  return {
    kind: "container",
    launcherFactory: createContainerLauncherFactory({
      image: config.workerContainerImage,
      cpus: config.workerContainerCpus,
      memoryBytes: config.workerContainerMemory,
      pidsLimit: config.workerContainerPidsLimit,
      ...(options.dockerCommand === undefined ? {} : { dockerCommand: options.dockerCommand }),
      ...(options.dockerArgs === undefined ? {} : { dockerArgs: options.dockerArgs }),
    }),
  };
}

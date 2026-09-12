/**
 * 装配层 worker 执行形态选择测试(WP-66,Q4 定案面;D-API-105):
 *  - 缺省 process:零探测、零工厂(既有进程池路径零回退);
 *  - 显式 container:启动期探测 fail-closed(daemon / 镜像不可达即拒绝启动,
 *    不静默降级进程池——Windows dev 降级路径的明示形态);
 *  - 测试注入的工厂直通(集成替身形态,跳过探测)。
 */

import { describe, expect, it } from "vitest";

import { resolveWorkerExecutionForm } from "../../src/runtime/worker-execution.js";
import type { SessionApiConfig } from "../../src/config.js";
import type { WorkerLauncherFactory } from "@stackmaster/session-core";

/** 最小配置形态(仅执行形态面;其余字段不进入本判定)。 */
function configWith(mode: "process" | "container"): SessionApiConfig {
  return {
    workerExecutionMode: mode,
    workerContainerImage: "stackmaster/session-api:test",
    workerContainerCpus: 1,
    workerContainerMemory: 268435456,
    workerContainerPidsLimit: 64,
  } as unknown as SessionApiConfig;
}

describe("装配层执行形态选择(resolveWorkerExecutionForm;WP-66)", () => {
  it("缺省 process:返回进程形态,零容器工厂、零探测调用(dev / CI 拓扑零回退)", async () => {
    let probeCalls = 0;
    const form = await resolveWorkerExecutionForm({
      config: configWith("process"),
      probe: async () => {
        probeCalls += 1;
      },
    });
    expect(form.kind).toBe("process");
    expect(form.launcherFactory).toBeUndefined();
    expect(probeCalls).toBe(0);
  });

  it("显式 container:探测通过 → 容器工厂就位(按配置值构造)", async () => {
    let probeCalls = 0;
    const form = await resolveWorkerExecutionForm({
      config: configWith("container"),
      probe: async () => {
        probeCalls += 1;
      },
    });
    expect(probeCalls).toBe(1);
    expect(form.kind).toBe("container");
    expect(form.launcherFactory).toBeDefined();
    // 工厂按会话 ID 派生容器启动器(容器形态 kind 标识)。
    const launcher = form.launcherFactory!("sess-wp66-form");
    expect(launcher.kind).toBe("container");
  });

  it("显式 container + 探测失败:启动拒绝(fail-closed,不静默降级进程池)", async () => {
    await expect(
      resolveWorkerExecutionForm({
        config: configWith("container"),
        probe: async () => {
          throw new Error("docker daemon unreachable (fake probe)");
        },
      }),
    ).rejects.toThrow(/docker daemon|容器池/i);
  });

  it("测试注入工厂直通:跳过探测,工厂原样返回(集成替身形态)", async () => {
    let probeCalls = 0;
    const injected: WorkerLauncherFactory = () => {
      throw new Error("fake launcher");
    };
    const form = await resolveWorkerExecutionForm({
      config: configWith("container"),
      probe: async () => {
        probeCalls += 1;
      },
      injectedFactory: injected,
    });
    expect(probeCalls).toBe(0);
    expect(form.kind).toBe("container");
    expect(form.launcherFactory).toBe(injected);
  });
});

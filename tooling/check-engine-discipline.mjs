#!/usr/bin/env node
/**
 * vm-engine 确定性纪律门禁(阶段二 WP-0)。
 *
 * 条目 ID 遵守《数据分类与秘密零驻留清单》§九扫描器纪律:脚本输出、CI 步骤名、
 * 反例命名携带 ID;条目 → CI 检查项映射见 docs/develop/秘密零驻留CI检查项映射.md。
 *
 * 门禁(每条带必触发反例;配置类反例在 --self-test 中以违反样例证明可红灯,
 * lint / 构建类反例以临时反例 crate 证明 clippy / 编译器真实触发):
 *   ENG-1  全 crate `#![forbid(unsafe_code)]`(反例:缺属性样例 + unsafe 反例 crate);
 *   ENG-2  引擎三 crate(vm-core / vm-runtime / projection)`#![no_std]`——
 *          std::time / std::io / std::net / std::fs 结构性不可解析;`extern crate std`
 *          仅允许出现在 cfg(test) 行(反例:缺 no_std / 非测试 std 引用样例);
 *   ENG-3  workspace [profile.release] overflow-checks = true(运行时反例:
 *          vm-core 的 release_overflow_checks_active,cargo test --release 下红灯);
 *   ENG-4  引擎三 crate 运行时依赖 ⊆ 允许清单,并禁 rand / getrandom / chrono 等
 *          时间 / 随机源 crate(反例:rand 依赖样例);
 *   ENG-5  tooling/engine-lints/clippy.toml 引擎禁用清单存在且非空,并真实生效
 *          (反例:违规 crate 在 CLIPPY_CONF_DIR 下 clippy 红灯、无配置下绿灯);
 *   ENG-6  cargo fmt --check 与 cargo clippy --workspace --all-targets -D warnings 全绿。
 *
 * 用法:
 *   node tooling/check-engine-discipline.mjs            # 全量(配置门禁 + 自检 + fmt + clippy + 反例)
 *   node tooling/check-engine-discipline.mjs --config   # 仅配置门禁 + 自检(无 cargo,秒级)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engineRoot = join(repoRoot, "vm-engine");
const engineLintsDir = join(repoRoot, "tooling", "engine-lints");

const ENGINE_CRATES = ["vm-core", "vm-runtime", "projection"];
const ALL_CRATES = [...ENGINE_CRATES, "vm-worker"];

/** 引擎三 crate 运行时依赖允许清单(ENG-4);新增依赖须走契约变更评审并在此登记。 */
const ENGINE_RUNTIME_DEP_ALLOWLIST = {
  "vm-core": [],
  "vm-runtime": ["vm-core"],
  projection: ["vm-core"],
};
/** 引擎三 crate 测试期依赖允许清单(仅影响测试二进制,不影响生产确定性图)。 */
const ENGINE_DEV_DEP_ALLOWLIST = [];
/**
 * vm-worker 运行时依赖允许清单(进程边界层)。WP-1 契约消费面登记:
 * serde / serde_json(契约类型镜像与帧序列化)、jsonschema(冻结 JSON Schema
 * 校验)、schemars(镜像漂移比对);路径依赖 vm-core / vm-runtime / projection。
 */
const WORKER_RUNTIME_DEP_ALLOWLIST = [
  "vm-core",
  "vm-runtime",
  "projection",
  "serde",
  "serde_json",
  "jsonschema",
  "schemars",
];
/** 引擎三 crate 任何依赖位置(运行时 / 测试)都禁止的时间 / 随机源 crate(ENG-4)。 */
const FORBIDDEN_ENGINE_CRATES = [
  "rand",
  "getrandom",
  "chrono",
  "time",
  "coarsetime",
  "tokio",
  "async-std",
  "futures",
];

/** 极简 TOML 分节读取:返回 { 节名: { lines: string[] } };只服务本脚本的固定形态。 */
function parseTomlSections(text) {
  const sections = {};
  let current = { lines: [] };
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (match) {
      current = { lines: [] };
      sections[match[1]] = current;
    } else {
      current.lines.push(line);
    }
  }
  return sections;
}

function sectionDepNames(section) {
  const names = [];
  for (const line of section?.lines ?? []) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)?\s*=/);
    if (match) {
      names.push(match[1]);
    }
  }
  return names;
}

/** 读取真实仓库的受检文件;self-test 以同构的虚拟文件对象替换后复用同一批门禁函数。 */
function readRealFiles() {
  const files = { workspaceToml: readFileSync(join(engineRoot, "Cargo.toml"), "utf8"), crates: {} };
  for (const name of ALL_CRATES) {
    files.crates[name] = {
      toml: readFileSync(join(engineRoot, name, "Cargo.toml"), "utf8"),
      rootRs: readFileSync(join(engineRoot, name, "src", name === "vm-worker" ? "main.rs" : "lib.rs"), "utf8"),
    };
  }
  return files;
}

/**
 * 配置门禁(ENG-1 ~ ENG-5 的静态断言面)。输入为虚拟文件对象,真实运行与
 * self-test 共用同一实现——反例证明的是本函数组本身可红灯,不是数据凑巧。
 */
function runConfigGates(files, clippyTomlText) {
  const violations = [];

  // ENG-1:全 crate forbid(unsafe_code)。
  for (const name of ALL_CRATES) {
    if (!/^#!\[forbid\(unsafe_code\)]/m.test(files.crates[name].rootRs)) {
      violations.push({
        gate: "ENG-1",
        message: `${name} 缺少 crate 级 #![forbid(unsafe_code)]`,
      });
    }
  }

  // ENG-2:引擎三 crate no_std;extern crate std 仅允许 cfg(test) 行(同行或紧邻属性行)。
  for (const name of ENGINE_CRATES) {
    const src = files.crates[name].rootRs;
    if (!/^#!\[no_std]/m.test(src)) {
      violations.push({
        gate: "ENG-2",
        message: `${name} 缺少 #![no_std](std::time / std::io / std::net / std::fs 失去结构性禁止)`,
      });
    }
    const lines = src.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!/extern crate std/.test(lines[index])) {
        continue;
      }
      const sameLine = /cfg\(test\)/.test(lines[index]);
      const precededByAttr = index > 0 && /^\s*#\[cfg\(test\)\]\s*$/.test(lines[index - 1]);
      if (!sameLine && !precededByAttr) {
        violations.push({
          gate: "ENG-2",
          message: `${name} 出现非 cfg(test) 的 "extern crate std"(生产图引入 std)`,
        });
      }
    }
  }

  // ENG-3:workspace release profile overflow-checks = true。
  const profileRelease = parseTomlSections(files.workspaceToml)["profile.release"];
  const hasOverflowChecks = (profileRelease?.lines ?? []).some((line) =>
    /^\s*overflow-checks\s*=\s*true\s*$/.test(line),
  );
  if (!hasOverflowChecks) {
    violations.push({
      gate: "ENG-3",
      message: "vm-engine/Cargo.toml [profile.release] 缺少 overflow-checks = true",
    });
  }

  // ENG-4:依赖允许清单 + 禁止的时间 / 随机源 crate。
  const runtimeAllowlist = { ...ENGINE_RUNTIME_DEP_ALLOWLIST, "vm-worker": WORKER_RUNTIME_DEP_ALLOWLIST };
  for (const name of ALL_CRATES) {
    const sections = parseTomlSections(files.crates[name].toml);
    const runtimeDeps = sectionDepNames(sections.dependencies);
    const devDeps = name === "vm-worker" ? [] : sectionDepNames(sections["dev-dependencies"]);
    const allowlist = runtimeAllowlist[name];
    for (const dep of runtimeDeps) {
      if (!allowlist.includes(dep)) {
        violations.push({
          gate: "ENG-4",
          message: `${name} 运行时依赖 "${dep}" 不在允许清单(ENG-4;新增须评审登记)`,
        });
      }
    }
    if (name !== "vm-worker") {
      for (const dep of devDeps) {
        if (!ENGINE_DEV_DEP_ALLOWLIST.includes(dep)) {
          violations.push({
            gate: "ENG-4",
            message: `${name} 测试期依赖 "${dep}" 不在允许清单(ENG-4;新增须评审登记)`,
          });
        }
      }
      const allDeps = [...runtimeDeps, ...devDeps];
      for (const forbidden of FORBIDDEN_ENGINE_CRATES) {
        if (allDeps.includes(forbidden)) {
          violations.push({
            gate: "ENG-4",
            message: `${name} 依赖了时间 / 随机源 crate "${forbidden}"(时钟与随机源必须 trait 注入)`,
          });
        }
      }
    }
  }

  // ENG-5(静态面):引擎 clippy 禁用清单存在且两类条目非空。
  const hasTypes = /^\s*disallowed-types\s*=\s*\[[^\]]/m.test(clippyTomlText ?? "");
  const hasMethods = /^\s*disallowed-methods\s*=\s*\[[^\]]/m.test(clippyTomlText ?? "");
  if (!clippyTomlText || !hasTypes || !hasMethods) {
    violations.push({
      gate: "ENG-5",
      message: "tooling/engine-lints/clippy.toml 缺失或 disallowed-types / disallowed-methods 为空",
    });
  }

  return violations;
}

/** --self-test:每条配置门禁构造一个违反样例,断言门禁真实红灯(必触发反例纪律)。 */
function selfTest(realFiles, realClippyToml) {
  const cases = [
    {
      id: "ENG-1",
      sample: () => {
        const files = structuredClone(realFiles);
        files.crates["vm-worker"].rootRs = files.crates["vm-worker"].rootRs.replace(
          /^#!\[forbid\(unsafe_code\)]\s*$/m,
          "",
        );
        return { files, clippyToml: realClippyToml, expectGate: "ENG-1" };
      },
    },
    {
      id: "ENG-2(no_std 缺失)",
      sample: () => {
        const files = structuredClone(realFiles);
        files.crates["vm-runtime"].rootRs = files.crates["vm-runtime"].rootRs.replace(
          /^#!\[no_std]\s*$/m,
          "",
        );
        return { files, clippyToml: realClippyToml, expectGate: "ENG-2" };
      },
    },
    {
      id: "ENG-2(非测试 std 引用)",
      sample: () => {
        const files = structuredClone(realFiles);
        files.crates["projection"].rootRs = `#![no_std]\n#![forbid(unsafe_code)]\nextern crate std;\n`;
        return { files, clippyToml: realClippyToml, expectGate: "ENG-2" };
      },
    },
    {
      id: "ENG-3",
      sample: () => {
        const files = structuredClone(realFiles);
        files.workspaceToml = files.workspaceToml.replace(/^\s*overflow-checks\s*=\s*true\s*$/m, "");
        return { files, clippyToml: realClippyToml, expectGate: "ENG-3" };
      },
    },
    {
      id: "ENG-4(rand 依赖)",
      sample: () => {
        const files = structuredClone(realFiles);
        files.crates["vm-core"].toml =
          files.crates["vm-core"].toml.replace("[dependencies]", "[dependencies]\nrand = \"0.9\"");
        return { files, clippyToml: realClippyToml, expectGate: "ENG-4" };
      },
    },
    {
      id: "ENG-5",
      sample: () => ({ files: realFiles, clippyToml: "", expectGate: "ENG-5" }),
    },
  ];

  let failed = 0;
  for (const item of cases) {
    const { files, clippyToml, expectGate } = item.sample();
    const hit = runConfigGates(files, clippyToml).some((violation) => violation.gate.startsWith(expectGate));
    if (hit) {
      console.log(`[self-test] ${item.id}:反例按预期触发 ${expectGate}`);
    } else {
      console.error(`[self-test] ${item.id}:反例未触发 ${expectGate}——门禁失效,属静默绿灯`);
      failed += 1;
    }
  }
  return failed;
}

function runCargo(args, { cwd = engineRoot, env } = {}) {
  const result = spawnSync("cargo", args, {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
  });
  if (result.error) {
    return { code: 1, output: `cargo 启动失败:${result.error.message}` };
  }
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * ENG-5 / ENG-6 的 lint 面:fmt、引擎三 crate 的 clippy(带禁用清单)、
 * workspace clippy(不带清单,覆盖 vm-worker),以及三个临时反例 crate 证明
 * 禁用清单与 forbid(unsafe_code) 真实触发(必触发反例纪律)。
 */
function runLintGates() {
  const failures = [];

  // ENG-6:fmt 检查。
  const fmt = runCargo(["fmt", "--all", "--", "--check"]);
  if (fmt.code !== 0) {
    failures.push({ gate: "ENG-6", output: fmt.output, message: "cargo fmt --check 失败" });
  } else {
    console.log("[ENG-6] cargo fmt --check 通过");
  }

  // ENG-5:引擎三 crate 逐个以 CLIPPY_CONF_DIR 应用禁用清单(先跑,workspace 轮复用其结果)。
  const strictEnv = { ...process.env, CLIPPY_CONF_DIR: engineLintsDir };
  for (const name of ENGINE_CRATES) {
    const strict = runCargo(["clippy", "-p", name, "--all-targets", "--", "-D", "warnings"], {
      env: strictEnv,
    });
    if (strict.code !== 0) {
      failures.push({
        gate: "ENG-5",
        output: strict.output,
        message: `${name} 在引擎禁用清单下 clippy 失败`,
      });
    } else {
      console.log(`[ENG-5] ${name} 在引擎禁用清单下 clippy 通过`);
    }
  }

  // ENG-6:workspace 全量 clippy(覆盖 vm-worker;进程层合法使用 std,不适用禁用清单)。
  const workspace = runCargo(["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"]);
  if (workspace.code !== 0) {
    failures.push({ gate: "ENG-6", output: workspace.output, message: "workspace clippy -D warnings 失败" });
  } else {
    console.log("[ENG-6] workspace clippy -D warnings 通过");
  }

  // ENG-5 / ENG-1 必触发反例:临时反例 crate。
  const counterexample = buildCounterexamples();
  try {
    for (const item of counterexample) {
      const withConf = runCargo(["clippy", "--", "-D", "warnings"], {
        cwd: item.dir,
        env: { ...process.env, CLIPPY_CONF_DIR: engineLintsDir },
      });
      if (item.expect === "fail" && withConf.code === 0) {
        failures.push({
          gate: item.gate,
          output: withConf.output,
          message: `反例 crate "${item.name}" 未被 ${item.gate} 拒绝——${item.gate} 失效`,
        });
      }
      if (item.expect === "fail" && withConf.code !== 0) {
        const signal = item.signal.test(withConf.output)
          ? "命中预期 lint"
          : `触发但信号不匹配(预期 /${item.signal.source}/)`;
        console.log(`[${item.gate}] 反例 crate "${item.name}" 被拒绝(${signal})`);
        if (!item.signal.test(withConf.output)) {
          failures.push({
            gate: item.gate,
            output: withConf.output,
            message: `反例 crate "${item.name}" 被拒绝但未命中预期 lint 信号`,
          });
        }
      }
      if (item.expect === "pass" && withConf.code !== 0) {
        failures.push({
          gate: item.gate,
          output: withConf.output,
          message: `干净 crate "${item.name}" 被误拒(禁用清单误报)`,
        });
      }
      if (item.expect === "pass" && withConf.code === 0) {
        console.log(`[${item.gate}] 干净 crate "${item.name}" 无误报`);
      }
      // 双向对照:违规 crate 在无配置时必须绿灯,证明红灯归因于禁用清单而非代码本身。
      if (item.expect === "fail" && item.control) {
        const withoutConf = runCargo(["clippy", "--", "-D", "warnings"], { cwd: item.dir });
        if (withoutConf.code !== 0) {
          failures.push({
            gate: item.gate,
            output: withoutConf.output,
            message: `反例 crate "${item.name}" 无配置时也失败——红灯不可归因于禁用清单`,
          });
        } else {
          console.log(`[${item.gate}] 反例 crate "${item.name}" 无配置对照绿灯,红灯归因于禁用清单`);
        }
      }
    }
  } finally {
    rmSync(counterexampleRoot, { recursive: true, force: true });
  }

  return failures;
}

const counterexampleRoot = join(tmpdir(), "stackmaster-engine-discipline-ce");

function writeCounterexample(name, files) {
  const dir = join(counterexampleRoot, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "Cargo.toml"),
    `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\n`,
  );
  for (const [relativePath, content] of Object.entries(files)) {
    writeFileSync(join(dir, relativePath), content);
  }
  return dir;
}

function buildCounterexamples() {
  return [
    {
      name: "ce-std-time",
      gate: "ENG-5",
      expect: "fail",
      control: true,
      signal: /disallowed/,
      dir: writeCounterexample("ce-std-time", {
        "src/lib.rs": `use std::process::Command;\nuse std::time::Instant;\n\npub fn probe() -> u128 {\n    let start = Instant::now();\n    let _cmd = Command::new("echo");\n    start.elapsed().as_nanos()\n}\n`,
      }),
    },
    {
      name: "ce-no-std-clean",
      gate: "ENG-5",
      expect: "pass",
      dir: writeCounterexample("ce-no-std-clean", {
        "src/lib.rs": "#![no_std]\n#![forbid(unsafe_code)]\n",
      }),
    },
    {
      name: "ce-unsafe",
      gate: "ENG-1",
      expect: "fail",
      signal: /unsafe/,
      dir: writeCounterexample("ce-unsafe", {
        "src/lib.rs": "#![forbid(unsafe_code)]\n\npub fn probe() -> i32 {\n    unsafe { 42 }\n}\n",
      }),
    },
  ];
}

function main() {
  const configOnly = process.argv.includes("--config");
  const realClippyToml = existsSync(join(engineLintsDir, "clippy.toml"))
    ? readFileSync(join(engineLintsDir, "clippy.toml"), "utf8")
    : "";

  const realFiles = readRealFiles();
  const violations = runConfigGates(realFiles, realClippyToml);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`[${violation.gate}] ${violation.message}`);
    }
  } else {
    console.log("[ENG-1~5] 配置门禁通过(forbid(unsafe) / no_std / overflow-checks / 依赖允许清单 / clippy 清单)");
  }

  const selfTestFailures = selfTest(realFiles, realClippyToml);
  if (selfTestFailures === 0) {
    console.log("[self-test] 6 个配置门禁反例全部按预期触发(必触发反例纪律)");
  }

  let lintFailures = [];
  if (!configOnly) {
    lintFailures = runLintGates();
  }

  const total = violations.length + selfTestFailures + lintFailures.length;
  if (total > 0) {
    console.error(`\n引擎确定性纪律门禁失败:${total} 项`);
    for (const failure of lintFailures) {
      console.error(`\n[${failure.gate}] ${failure.message}\n${failure.output.slice(-2000)}`);
    }
    process.exit(1);
  }
  console.log(configOnly ? "\n引擎纪律配置门禁 + 自检全部通过。" : "\n引擎确定性纪律门禁全部通过(ENG-1~6)。");
}

main();

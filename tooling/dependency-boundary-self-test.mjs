#!/usr/bin/env node
/**
 * dependency-cruiser 依赖边界的必触发反例自检(阶段三 WP-1;WP-51 扩展)。
 *
 * 反例纪律(秘密零驻留 CI 检查项映射 §五):每条已接线门禁必须有至少一个
 * 反例,且反例与门禁同仓同 CI 运行;反例失效按门禁失败处理——否则 glob 写错、
 * 规则改名、扫描器失效都表现为静默绿灯,与零命中不可区分,属无效控制。
 *
 * 本脚本以真实配置(tooling/dependency-cruiser.cjs)对临时反例树做程序化
 * 扫描,断言 apps/ 与浏览器包相关规则对违反样例真实红灯、对合规样例零误报:
 *
 *   反例 1  apps/session-api → vm-engine 产物      no-ts-dependency-on-vm-engine(apps 侧覆盖)
 *   反例 2  apps/session-api → 未登记工作区包       session-api-workspace-deps-allowlist
 *   反例 3  apps/session-api → 浏览器可达包         session-api-workspace-deps-allowlist
 *                                                  + no-backend-dependency-on-browser-packages
 *   反例 4  packages/session-core → 浏览器可达包    no-backend-dependency-on-browser-packages
 *                                                  (允许清单规则不得误伤 packages 侧)
 *   反例 5  embed-runtime → vm-ui(浏览器包横向)   browser-package-cross-dependency-into-vm-ui
 *                                                  (WP-51:唯一放行边之外全红灯)
 *   反例 6  vm-ui → react-wrapper(浏览器包横向)   browser-package-cross-dependency-into-react-wrapper
 *   反例 7  apps/session-api → react-wrapper        session-api-workspace-deps-allowlist
 *                                                  + no-backend-dependency-on-browser-packages
 *   正控 8  packages/vm-ui 包内边(index → 自包子模块)浏览器包规则不得触发
 *                                                  (WP-F1:包内边经 pathNot 排除)
 *   正控 9  react-wrapper → embed-runtime / protocol 零违规
 *                                                  (WP-51 唯一放行横向边 + protocol 公开入口)
 *   对照组  apps/session-api → protocol / challenge-schema /
 *           challenge-compiler / session-core       零违规(允许清单全量,无误报)
 *
 * 运行:`pnpm lint:deps:self-test`(CI ts-gate 接线)。任何断言不过 = 退出码 1。
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { cruise } from "dependency-cruiser";

const require = createRequire(import.meta.url);
const ruleSet = require("./dependency-cruiser.cjs");

/** 反例树:文件 → 内容(路径复刻仓库结构,规则按 `^packages/` / `^apps/` 形态匹配)。 */
const FIXTURE_FILES = {
  // 合法依赖目标(空占位模块)。
  "packages/protocol/src/index.ts": "export const placeholder = true;\n",
  "packages/challenge-schema/src/index.ts": "export const placeholder = true;\n",
  "packages/challenge-compiler/src/index.ts": "export const placeholder = true;\n",
  "packages/session-core/src/index.ts": "export const placeholder = true;\n",
  "packages/vm-ui/src/index.ts": "export const placeholder = true;\n",
  "packages/embed-runtime/src/index.ts": "export const placeholder = true;\n",
  // 未登记进 session-api 允许清单、也不属浏览器面的假想工作区包。
  "packages/telemetry-extra/src/index.ts": "export const placeholder = true;\n",
  // 浏览器包包内结构:positive control(包内边不得触发浏览器包规则)。
  "packages/vm-ui/src/ui/inner.ts": "export const placeholder = true;\n",
  "packages/vm-ui/src/index.ts": 'export * from "./ui/inner";\n',
  "vm-engine/dist/index.ts": "export const placeholder = true;\n",

  // 正控 9:react-wrapper → embed-runtime(WP-51 唯一放行横向边)+ protocol。
  "packages/react-wrapper/src/index.ts": [
    'export * from "../../../packages/embed-runtime/src/index";',
    'export * from "../../../packages/protocol/src/index";',
    "",
  ].join("\n"),

  // 反例 1:apps → vm-engine 产物(TS 构建图红线,ADR-3 / ADR-8)。
  "apps/session-api/src/ce-vm-engine.ts":
    'export * from "../../../vm-engine/dist/index";\n',
  // 反例 2:apps → 未登记工作区包。
  "apps/session-api/src/ce-foreign-package.ts":
    'export * from "../../../packages/telemetry-extra/src/index";\n',
  // 反例 3:apps → 浏览器可达包(双规则同边触发)。
  "apps/session-api/src/ce-browser-package.ts":
    'export * from "../../../packages/vm-ui/src/index";\n',
  // 反例 4:packages 侧 → 浏览器可达包(反向依赖禁令覆盖 packages)。
  "packages/session-core/src/ce-browser-package.ts":
    'export * from "../../../packages/embed-runtime/src/index";\n',
  // 反例 5:embed-runtime → vm-ui(浏览器包横向依赖,WP-51 收紧)。
  "packages/embed-runtime/src/ce-browser-import.ts":
    'export * from "../../../packages/vm-ui/src/ui/inner";\n',
  // 反例 6:vm-ui → react-wrapper(任何包 → react-wrapper 均禁止)。
  "packages/vm-ui/src/ce-react-wrapper.ts":
    'export * from "../../../packages/react-wrapper/src/index";\n',
  // 反例 7:apps → react-wrapper(双规则同边触发)。
  "apps/session-api/src/ce-react-wrapper.ts":
    'export * from "../../../packages/react-wrapper/src/index";\n',
  // 对照组:允许清单全量(必须零违规)。
  "apps/session-api/src/clean-allowlist.ts": [
    'export * from "../../../packages/protocol/src/index";',
    'export * from "../../../packages/challenge-schema/src/index";',
    'export * from "../../../packages/challenge-compiler/src/index";',
    'export * from "../../../packages/session-core/src/index";',
    "",
  ].join("\n"),
};

/** 入口文件(相对反例树根)。 */
const ENTRY_FILES = Object.keys(FIXTURE_FILES).filter(
  (file) =>
    file.startsWith("apps/session-api/src/") ||
    file === "packages/session-core/src/ce-browser-package.ts" ||
    file === "packages/vm-ui/src/index.ts" ||
    file === "packages/vm-ui/src/ce-react-wrapper.ts" ||
    file === "packages/embed-runtime/src/ce-browser-import.ts" ||
    file === "packages/react-wrapper/src/index.ts",
);

/** 逐边期望:from 以 fromSuffix(可选)且 to 以 edgeSuffix 结尾的依赖边必须/不得触发的规则。
 *  后缀用正斜杠字面量——dependency-cruiser 输出路径恒为 / 分隔。
 *  fromSuffix 用于区分"同目标、不同来源"的边(如包内边正控 vs 横向边反例)。 */
const EDGE_EXPECTATIONS = [
  {
    label: "反例1 apps→vm-engine",
    edgeSuffix: "vm-engine/dist/index.ts",
    expect: ["no-ts-dependency-on-vm-engine"],
    reject: [],
  },
  {
    label: "反例2 apps→未登记包",
    edgeSuffix: "telemetry-extra/src/index.ts",
    expect: ["session-api-workspace-deps-allowlist"],
    reject: ["no-backend-dependency-on-browser-packages"],
  },
  {
    label: "反例3 apps→浏览器包(双规则)",
    edgeSuffix: "vm-ui/src/index.ts",
    fromSuffix: "apps/session-api/src/ce-browser-package.ts",
    expect: [
      "session-api-workspace-deps-allowlist",
      "no-backend-dependency-on-browser-packages",
    ],
    reject: [],
  },
  {
    label: "反例4 packages→浏览器包",
    edgeSuffix: "embed-runtime/src/index.ts",
    fromSuffix: "packages/session-core/src/ce-browser-package.ts",
    expect: ["no-backend-dependency-on-browser-packages"],
    reject: ["session-api-workspace-deps-allowlist", "browser-package-cross-dependency-into-embed-runtime"],
  },
  {
    label: "反例5 embed-runtime→vm-ui(横向)",
    edgeSuffix: "vm-ui/src/ui/inner.ts",
    fromSuffix: "packages/embed-runtime/src/ce-browser-import.ts",
    expect: ["browser-package-cross-dependency-into-vm-ui"],
    reject: [
      "browser-packages-only-depend-on-protocol",
      "no-backend-dependency-on-browser-packages",
    ],
  },
  {
    label: "反例6 vm-ui→react-wrapper(横向)",
    edgeSuffix: "react-wrapper/src/index.ts",
    fromSuffix: "packages/vm-ui/src/ce-react-wrapper.ts",
    expect: ["browser-package-cross-dependency-into-react-wrapper"],
    reject: ["browser-packages-only-depend-on-protocol"],
  },
  {
    label: "反例7 apps→react-wrapper(双规则)",
    edgeSuffix: "react-wrapper/src/index.ts",
    fromSuffix: "apps/session-api/src/ce-react-wrapper.ts",
    expect: [
      "session-api-workspace-deps-allowlist",
      "no-backend-dependency-on-browser-packages",
    ],
    reject: [],
  },
  {
    label: "正控8 vm-ui包内边不违规",
    edgeSuffix: "vm-ui/src/ui/inner.ts",
    fromSuffix: "packages/vm-ui/src/index.ts",
    expect: [],
    reject: [
      "browser-packages-only-depend-on-protocol",
      "browser-package-cross-dependency-into-vm-ui",
    ],
  },
  {
    label: "正控9 react-wrapper→embed-runtime 放行",
    edgeSuffix: "embed-runtime/src/index.ts",
    fromSuffix: "packages/react-wrapper/src/index.ts",
    expect: [],
    reject: [
      "browser-package-cross-dependency-into-embed-runtime",
      "no-backend-dependency-on-browser-packages",
      "browser-packages-only-depend-on-protocol",
    ],
  },
  {
    label: "正控9 react-wrapper→protocol 放行",
    edgeSuffix: "protocol/src/index.ts",
    fromSuffix: "packages/react-wrapper/src/index.ts",
    expect: [],
    reject: [
      "browser-packages-only-depend-on-protocol",
      "browser-package-cross-dependency-into-embed-runtime",
    ],
  },
  {
    label: "对照组 apps→允许清单全量",
    edgeSuffix: "packages",
    expect: [],
    reject: [
      "session-api-workspace-deps-allowlist",
      "no-backend-dependency-on-browser-packages",
    ],
  },
];

async function writeFixtureTree(root) {
  for (const [file, content] of Object.entries(FIXTURE_FILES)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content, "utf8");
  }
}

/** 程序化扫描:返回 [{ from, to, rules: string[] }]。
 *  validate: true 是编程接口的关键项——CLI 默认应用 ruleSet,编程接口必须
 *  显式开启,否则规则静默不生效(正是本自检要堵住的"静默绿灯"形态)。 */
async function scanFixture(root) {
  const result = await cruise(ENTRY_FILES, {
    ruleSet,
    validate: true,
    baseDir: root,
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    moduleSystems: ["es6"],
  });
  const edges = [];
  for (const module of result.output.modules) {
    for (const dependency of module.dependencies ?? []) {
      edges.push({
        from: module.source,
        to: dependency.resolved,
        rules: (dependency.rules ?? []).map((rule) => rule.name),
      });
    }
  }
  return edges;
}

async function main() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "dep-boundary-self-test-"));
  try {
    await writeFixtureTree(fixtureRoot);
    const edges = await scanFixture(fixtureRoot);
    const failures = [];

    for (const expectation of EDGE_EXPECTATIONS) {
      const matching = edges.filter(
        (edge) =>
          edge.to.endsWith(expectation.edgeSuffix) &&
          (expectation.fromSuffix === undefined ||
            edge.from.endsWith(expectation.fromSuffix)),
      );
      if (matching.length === 0) {
        // 对照组的边以 packages/ 开头的四条目标分别断言。
        if (expectation.label.startsWith("对照组")) {
          const cleanEdges = edges.filter((edge) =>
            edge.from.endsWith("clean-allowlist.ts"),
          );
          const triggered = cleanEdges.flatMap((edge) => edge.rules);
          if (cleanEdges.length < 4 || triggered.length > 0) {
            failures.push(
              `${expectation.label}:对照组边数 ${cleanEdges.length},触发规则 [${triggered.join(", ")}]——允许清单存在误报或反例树失效`,
            );
          } else {
            console.log(`[self-test] ${expectation.label}:零违规(允许清单全量,无误报)`);
          }
          continue;
        }
        failures.push(
          `${expectation.label}:依赖边缺失——反例树或入口清单失效(glob 写错式静默绿灯)`,
        );
        continue;
      }
      const triggered = [...new Set(matching.flatMap((edge) => edge.rules))];
      for (const rule of expectation.expect) {
        if (!triggered.includes(rule)) {
          failures.push(`${expectation.label}:反例未触发 ${rule}——门禁失效,属静默绿灯`);
        }
      }
      for (const rule of expectation.reject) {
        if (triggered.includes(rule)) {
          failures.push(`${expectation.label}:误触发 ${rule}——规则作用域过宽`);
        }
      }
      if (!failures.some((failure) => failure.startsWith(expectation.label))) {
        console.log(
          `[self-test] ${expectation.label}:反例按预期触发 [${triggered.join(", ")}]`,
        );
      }
    }

    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(`[self-test] ${failure}`);
      }
      console.error(
        "[self-test] 依赖边界反例自检失败——dependency-cruiser 规则与反例必须同修(映射文档 §五:反例失效按门禁失败处理)",
      );
      process.exitCode = 1;
      return;
    }
    console.log("[self-test] 依赖边界反例自检全绿:11 组边期望全部满足");
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

await main();

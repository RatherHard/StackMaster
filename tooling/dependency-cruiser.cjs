/**
 * dependency-cruiser 依赖边界配置(计划书 5.5,CI 强制)。
 *
 * 从仓库根目录运行:`pnpm lint:deps`。
 *
 * 规则编码 5.5 的 TS 侧依赖方向:
 *  - protocol 是所有 TS 包唯一可依赖的跨域共享面,自身不得依赖任何工作区包;
 *  - challenge-schema 是 Schema 叶子包,只被 challenge-compiler、session-api、verifier 依赖;
 *  - 浏览器侧包(vm-ui、web-component、embed-runtime、react-wrapper)只依赖 protocol;
 *  - 任何 TS 包不得引用 vm-engine 产物——TS 与 Rust 只通过进程边界
 *    (spawn + JSON 协议)通信(ADR-3/ADR-8,安全红线)。
 *
 * apps/(session-api、verifier、admin、plugin-dev)自阶段二起搭建;
 * 规则中一并纳入,避免后续补规则时出现窗口期。
 *
 * 阶段三 WP-1(2026-09-09):apps/session-api 工程载体落地,规则从两个方向
 * 接线 apps/——
 *  - 三个"后端消费者白名单"规则的 pathNot 增补 ^apps/ 形态(此前只排除
 *    ^packages/session-api 等,apps 同名包会被误伤);
 *  - 新增 session-api 工作区依赖允许清单与"浏览器可达包禁反向依赖"两条规则;
 *  - 必触发反例自检:tooling/dependency-boundary-self-test.mjs(pnpm
 *    lint:deps:self-test),以本配置对临时反例树做程序化扫描,证明每条
 *    apps/ 相关规则真实可红灯。
 *
 * 路径形态注记:pnpm workspace 依赖经 realpath 解析,规则按
 * `^packages/<name>/` 形态匹配(node_modules/@stackmaster/* 链接形态不出现)。
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-ts-dependency-on-vm-engine",
      severity: "error",
      comment:
        "TS 构建图不得引用 vm-engine 任何产物;跨语言只走进程边界 JSON 协议(ADR-3/ADR-8)。",
      from: { path: "^(packages|apps)/[^/]+" },
      to: { path: "vm-engine" },
    },
    {
      name: "protocol-is-leaf",
      severity: "error",
      comment: "protocol 是契约叶子包,不得依赖任何工作区包。",
      from: { path: "^packages/protocol/" },
      to: { path: "^packages/", pathNot: "^packages/protocol/" },
    },
    {
      name: "challenge-schema-is-leaf",
      severity: "error",
      comment: "challenge-schema 是 Schema 叶子包,不得依赖任何工作区包。",
      from: { path: "^packages/challenge-schema/" },
      to: { path: "^packages/", pathNot: "^packages/challenge-schema/" },
    },
    {
      name: "challenge-schema-dependents-restricted",
      severity: "error",
      comment:
        "challenge-schema 只能被后端 TS 包(challenge-compiler、session-api、verifier)依赖;浏览器侧与编排之外的应用不得依赖。排除包自身(其内部模块边不属于“依赖方”约束)。",
      from: {
        path: "^(packages|apps)/",
        pathNot: [
          "^packages/(challenge-compiler|session-api|verifier)/",
          "^apps/(session-api|verifier)/",
          "^packages/challenge-schema/",
        ],
      },
      to: { path: "^packages/challenge-schema/" },
    },
    {
      name: "challenge-compiler-dependents-restricted",
      severity: "error",
      comment:
        "challenge-compiler(WP-2)只能被后端 TS 包(session-api、verifier、会话编排核心 session-core)依赖;浏览器可达包导入即违规——装载产物含私有判题包完整状态与完整 IR,“Schema 存在不等于可下发”(WP-2;计划书 13.5 隔离扫描同约束)。排除包自身。",
      from: {
        path: "^(packages|apps)/",
        pathNot: [
          "^packages/(session-api|session-core|verifier)/",
          "^apps/(session-api|verifier)/",
          "^packages/challenge-compiler/",
        ],
      },
      to: { path: "^packages/challenge-compiler/" },
    },
    {
      name: "browser-packages-only-depend-on-protocol",
      severity: "error",
      comment:
        "浏览器侧包(vm-ui、web-component、embed-runtime、react-wrapper)对**其他工作区包**只允许依赖 protocol;浏览器包自身包内边(src/test/dist 的内部模块边)不属工作区包依赖,经 to 侧 pathNot 一并排除(WP-F1:规则原形会把任何多模块浏览器包连自身测试在内全部误伤,与本注释声明的意图相悖——浏览器包横向依赖由 browser-package-cross-dependency-* 规则族单独收紧,WP-51)。",
      from: { path: "^packages/(vm-ui|web-component|embed-runtime|react-wrapper)/" },
      to: {
        path: "^packages/",
        pathNot: [
          "^packages/protocol/",
          "^packages/(vm-ui|web-component|embed-runtime|react-wrapper)/",
        ],
      },
    },
    {
      name: "browser-package-cross-dependency-into-vm-ui",
      severity: "error",
      comment:
        "浏览器包横向依赖收紧(WP-51,Q4 配套):横向边只允许 react-wrapper → embed-runtime(薄封装消费宿主侧 SDK)。本规则族按目标包各立一条,from 侧 pathNot 排除目标包自身(包内边不属跨包依赖,WP-F1 先例);除 react-wrapper → embed-runtime 外的横向边一律禁止。",
      from: {
        path: "^packages/(vm-ui|web-component|embed-runtime|react-wrapper)/",
        pathNot: "^packages/vm-ui/",
      },
      to: { path: "^packages/vm-ui/" },
    },
    {
      name: "browser-package-cross-dependency-into-web-component",
      severity: "error",
      comment: "见 browser-package-cross-dependency-into-vm-ui(WP-51:唯一放行边 = react-wrapper → embed-runtime)。",
      from: {
        path: "^packages/(vm-ui|web-component|embed-runtime|react-wrapper)/",
        pathNot: "^packages/web-component/",
      },
      to: { path: "^packages/web-component/" },
    },
    {
      name: "browser-package-cross-dependency-into-react-wrapper",
      severity: "error",
      comment: "见 browser-package-cross-dependency-into-vm-ui(WP-51:唯一放行边 = react-wrapper → embed-runtime;任何包 → react-wrapper 均禁止)。",
      from: {
        path: "^packages/(vm-ui|web-component|embed-runtime|react-wrapper)/",
        pathNot: "^packages/react-wrapper/",
      },
      to: { path: "^packages/react-wrapper/" },
    },
    {
      name: "browser-package-cross-dependency-into-embed-runtime",
      severity: "error",
      comment: "见 browser-package-cross-dependency-into-vm-ui(WP-51:react-wrapper → embed-runtime 为唯一放行边,from 侧一并豁免 react-wrapper)。",
      from: {
        path: "^packages/(vm-ui|web-component|embed-runtime|react-wrapper)/",
        pathNot: ["^packages/embed-runtime/", "^packages/react-wrapper/"],
      },
      to: { path: "^packages/embed-runtime/" },
    },
    {
      name: "protocol-schema-generator-not-importable",
      severity: "error",
      comment:
        "protocol 的 JSON Schema 生成器(schema/)依赖 node:fs,只供生成脚本与漂移测试使用;协议包之外的任何包不得深引其模块路径——“生成器不进浏览器构建图”由 exports map 之外再加这道依赖边界兜底(WP-2 安全评审 L-8)。",
      from: { path: "^(packages|apps)/", pathNot: "^packages/protocol/" },
      to: { path: "^packages/protocol/(dist|src)/schema/" },
    },
    {
      name: "protocol-server-only-backend-consumers-only",
      severity: "error",
      comment:
        "protocol 的 server-only 子路径(ProjectionPolicy 等,WP-1 §五)只允许后端包(challenge-compiler、session-api、verifier)依赖;浏览器可达包导入即违规——“Schema 存在不等于可下发”,projection 白名单的机制面不得进入浏览器构建图(WP-3)。",
      from: {
        path: "^(packages|apps)/",
        pathNot: [
          "^packages/(challenge-compiler|session-api|verifier)/",
          "^apps/(session-api|verifier)/",
          // protocol 包自身装配该子树(生成管线与漂移测试),属可信内部边。
          "^packages/protocol/",
        ],
      },
      to: { path: "^packages/protocol/(dist|src)/server-only" },
    },
    {
      name: "session-api-workspace-deps-allowlist",
      severity: "error",
      comment:
        "session-api(信任域 2,WP-1)对工作区包只允许依赖 protocol / challenge-schema / challenge-compiler / session-core(5.5 依赖方向);其余工作区包一律禁止——新依赖进入允许清单须先过 WP-1 §1.3 契约变更评审。",
      from: { path: "^apps/session-api/" },
      to: {
        path: "^packages/",
        pathNot: "^packages/(protocol|challenge-schema|challenge-compiler|session-core)/",
      },
    },
    {
      name: "no-backend-dependency-on-browser-packages",
      severity: "error",
      comment:
        "浏览器可达包(vm-ui / web-component / embed-runtime / react-wrapper)禁反向依赖(WP-1):服务端包与应用引入浏览器面即扩大公开构建图——浏览器面只被浏览器加载,投影 / 嵌入 SDK 的机制面不进服务端。浏览器包自身的依赖方向由 browser-packages-only-depend-on-protocol 单独强制。",
      from: {
        path: "^(packages|apps)/",
        pathNot: "^packages/(vm-ui|web-component|embed-runtime|react-wrapper)/",
      },
      to: { path: "^packages/(vm-ui|web-component|embed-runtime|react-wrapper)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
  },
};

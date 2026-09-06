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
          "^packages/challenge-compiler/",
        ],
      },
      to: { path: "^packages/challenge-compiler/" },
    },
    {
      name: "browser-packages-only-depend-on-protocol",
      severity: "error",
      comment:
        "浏览器侧包(vm-ui、web-component、embed-runtime、react-wrapper)对工作区包只允许依赖 protocol。",
      from: { path: "^packages/(vm-ui|web-component|embed-runtime|react-wrapper)/" },
      to: { path: "^packages/", pathNot: "^packages/protocol/" },
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
          // protocol 包自身装配该子树(生成管线与漂移测试),属可信内部边。
          "^packages/protocol/",
        ],
      },
      to: { path: "^packages/protocol/(dist|src)/server-only" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
  },
};

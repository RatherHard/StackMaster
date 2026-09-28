/**
 * M3 遗留移交清单第 5 项 ③:`debugMode` 缺省语义(opt-out,**缺省 = 启用**)的
 * 跨包恒等机检。
 *
 * ## 形态沿革(2026-09-19,WP-96 物理删除退役面)
 *
 * 本文件原取证**三个定义点**,其中第二个是开发壳夹具通道:
 *  1. 正式通道归一化:`packages/vm-ui/src/descriptor/challenge-descriptor.ts`
 *     (`debugMode: input["debugMode"] === undefined ? true : value`);
 *  2. ~~开发壳夹具通道:`apps/plugin-dev/src/main.ts`~~
 *     (`export const DEBUG_MODE_DEFAULT = true` + `debugMode ?? DEBUG_MODE_DEFAULT`);
 *  3. 服务端调试通道门控:`apps/session-api/src/debug/debug-channel-orchestrator.ts`
 *     (仅 `descriptor.debugMode === false` 判否)。
 *
 * **`apps/plugin-dev` 已随 WP-96 物理删除** ⇒ 原「两通道对比」前提消失。
 * **现行唯一通道** = 公开描述包 `debugMode` opt-out(缺省启用)+
 * `apps/page-app/src/boot.ts` 取包后注入工作区:
 *
 * ```
 * workspace.debugModeAvailable = view["debugMode"] !== false;
 * ```
 *
 * 故第 2 个定义点**改述为 page-app 引导注入点**(`boot.ts`);它与 vm-ui 归一化
 * 口径、session-api 门控 MUST 同口径。**纪律不变**(D-API-144 定案 = **保留重复 +
 * 跨包恒等机检**,不选物理共享 / 不选「单点权威 + 引用」):任何一处**独立漂移**
 * (例如某个定义点回退到「按 `=== true` 判真 = 缺省关闭」的 WP-75#9 前缺陷形态)
 * 本文件即红灯。
 *
 * 为什么不做物理共享(理由见 `docs/develop/decisions-m3/遗留-5.md` D-API-144;
 * 见 `docs/develop/权威API语义规约.md` §D-API-144):
 *   - `apps/page-app` / `apps/plugin-dev`(退役前)**禁止**静态导入
 *     `@stackmaster/vm-ui`(dependency-cruiser 边界;page-app 只按 URL 动态取产物);
 *   - `packages/vm-ui` **禁止**依赖 `challenge-schema`
 *     (`challenge-schema-dependents-restricted`);`protocol` 是唯一跨域共享面,
 *     但该席位文件锁不含 `packages/protocol`(并发在改)。
 *
 * 本文件导出的纯机检函数供**反例自检**复用(见文末「机检器自检」组):机检器对
 * 合成反例必须判红,否则恒等断言本身可能是「永远绿」的空壳。
 *
 * 路径锚定:Vitest 下 `import.meta.url` 不保证 `file:` scheme(实测抛
 * `TypeError: The URL must be of scheme file`),故与 `test/theming/theme.test.ts`
 * 同法以 cwd 向上探测仓库根(兼容「包内跑」与「仓库根聚合跑」两形态)。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseDescriptorView } from "../../src/descriptor/challenge-descriptor.js";

// ── 三处定义点的物理路径(以仓库根锚定)────────────────────────────────────

/** 定位仓库根(`pnpm-workspace.yaml` 为锚)。 */
function resolveRepoRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("未定位到仓库根(pnpm-workspace.yaml 缺席):跨包恒等机检无法取证");
}

const REPO_ROOT = resolveRepoRoot();
const VM_UI_DESCRIPTOR = join(REPO_ROOT, "packages/vm-ui/src/descriptor/challenge-descriptor.ts");
const VM_UI_SRC_DIR = join(REPO_ROOT, "packages/vm-ui/src");
/**
 * 现行取包注入点(**取代已删除的 `apps/plugin-dev/src/main.ts`**)。
 *
 * 沿革:开发壳曾以本地夹具描述包注入,该应用已随 WP-96 物理删除;
 * 现行形态 = 独立页面 `apps/page-app` 经 `fetchChallengeDescriptor` 取公开描述包后,
 * 按 opt-out 口径把 `debugModeAvailable` 注入 `<sm-workspace>`。
 */
const PAGE_APP_BOOT = join(REPO_ROOT, "apps/page-app/src/boot.ts");
const SESSION_API_GATE = join(
  REPO_ROOT,
  "apps/session-api/src/debug/debug-channel-orchestrator.ts",
);

/** 读取源文件文本(UTF-8;缺席即抛错,不静默跳过)。 */
function readSource(path: string): string {
  return readFileSync(path, "utf8");
}

// ── 机检器:逐定义点的口径断言纯函数(返回发现清单,空 = 合规)──────────────

/** 正式通道(vm-ui):`debugMode === undefined ? true : value`(opt-out 缺省启用)。 */
export function vmUiDescriptorFindings(source: string): string[] {
  const findings: string[] = [];
  if (!/debugMode:\s*input\["debugMode"\]\s*===\s*undefined\s*\?\s*true\s*:/.test(source)) {
    findings.push(
      '正式通道归一化不再是 opt-out 缺省启用(期望 `debugMode: input["debugMode"] === undefined ? true : …`)',
    );
  }
  if (/debugMode\s*===\s*true/.test(source)) {
    findings.push("正式通道出现 `debugMode === true`:缺省语义会翻转为「缺省关闭」");
  }
  return findings;
}

/**
 * 现行取包注入点(page-app 引导):仅显式 `false` 关闭(`!== false` 形态)。
 *
 * 沿革:本机检器原为 `devShellFindings()`(开发壳 `DEBUG_MODE_DEFAULT` 常量 +
 * `??` 归一化);开发壳删除后,同一口径的现行载体 = page-app 取包注入。
 */
export function pageAppBootFindings(source: string): string[] {
  const findings: string[] = [];
  if (!/workspace\.debugModeAvailable\s*=\s*view\["debugMode"\]\s*!==\s*false;/.test(source)) {
    findings.push(
      'page-app 引导不再是 `debugMode !== false` 形态(期望 `workspace.debugModeAvailable = view["debugMode"] !== false;`)',
    );
  }
  if (/debugMode["\]]*\s*===\s*true/.test(source)) {
    findings.push("page-app 引导出现 `debugMode === true`:缺省语义会翻转为「缺省关闭」");
  }
  return findings;
}

/** 服务端调试通道门控(session-api):仅显式 `false` 判否(缺省启用)。 */
export function sessionApiFindings(source: string): string[] {
  const findings: string[] = [];
  if (!/debugMode === false/.test(source)) {
    findings.push("session-api 门控未按 `debugMode === false` 判否(缺省启用的唯一合法形态)");
  }
  if (/debugMode\s*!==\s*true/.test(source) || /debugMode === true/.test(source)) {
    findings.push("session-api 门控出现 `=== true` / `!== true` 判真:缺省语义与正式通道相反");
  }
  return findings;
}

/** 从正式通道源码提取**缺省档字面值**(无法提取时返回 null)。 */
export function vmUiDefaultLiteral(source: string): boolean | null {
  const match = /debugMode:\s*input\["debugMode"\]\s*===\s*undefined\s*\?\s*(true|false)\s*:/.exec(
    source,
  );
  return match === null ? null : match[1] === "true";
}

/**
 * 从 page-app 引导源码**反推缺省档字面值**(无法提取时返回 null)。
 *
 * 判据 = 把 `undefined` 代入该比较式的真值(`===` / `!==` 与字面量无关地决定
 * 缺省档):`!== …` ⇒ 缺省**启用**;`=== …` ⇒ 缺省**关闭**。这是把「注入点口径」
 * 与「归一化口径」钉在一起的关键字面面。
 */
export function pageAppImpliedDefault(source: string): boolean | null {
  const match = /view\["debugMode"\]\s*(!==|===)\s*(true|false)/.exec(source);
  if (match === null) {
    return null;
  }
  const [, operator] = match;
  // undefined !== X ⇒ true(缺省启用);undefined === X ⇒ false(缺省关闭)。
  return operator === "!==";
}

/**
 * 服务端门控语义的等价谓词模拟:仅显式 `false` 关闭。
 * (与 session-api 源码中的 `=== false` 判否同口径;与 page-app 的 `!== false` 同值。)
 */
export function sessionApiEnables(declared: boolean | undefined): boolean {
  return declared !== false;
}

/** 现行取包注入点的行为谓词(与 page-app 源码 `!== false` 同口径)。 */
export function pageAppEnables(declared: boolean | undefined): boolean {
  return declared !== false;
}

/** 缺省语义字面量形态(命中即视为一处「定义点」)。 */
const NORMALIZATION_PATTERN = /debugMode["\]]*\s*===\s*undefined\s*\?\s*(?:true|false)/;

/** vm-ui `src/**` 内的定义点集合(**必须恰一处** = vm-ui 侧零重复)。 */
export function vmUiDefinitionSites(): string[] {
  const sites: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts") && NORMALIZATION_PATTERN.test(readFileSync(full, "utf8"))) {
        sites.push(full.slice(REPO_ROOT.length + 1).replaceAll("\\", "/"));
      }
    }
  };
  walk(VM_UI_SRC_DIR);
  return sites.sort();
}

// ── 恒等断言 ───────────────────────────────────────────────────────────────

/**
 * 不含 `debugMode` 声明的公开描述包(缺省面);
 * 语料逐字段对齐 `challenge-descriptor.test.ts#makeDescriptor`(同一套最小合法面)。
 */
function descriptorWithoutDebugMode(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    challengeId: "challenge-debug-mode-default",
    challengeContentVersion: "1.0.0",
    vmProfileVersion: "1.0.0",
    locale: "zh-CN",
    briefing: {
      title: "debugMode 缺省语义机检语料",
      summary: "跨包恒等机检用公开描述包(占位数据,零秘密)。",
      learningObjectives: ["锁定 debugMode opt-out 缺省语义"],
    },
    vmProfile: {
      registers: [{ name: "RAX" }, { name: "RSP" }],
      flagRegisterNames: ["FLAG0"],
      endianness: "little",
      archBits: 64,
      pageSizeBytes: 4096,
      canary: { enabled: true, sizeBytes: 8 },
      encodingTable: [
        { tokenHex: "0xc3", op: "ret" },
        { tokenHex: "0x50", op: "push", operands: [{ kind: "register", name: "RAX" }] },
      ],
    },
    memoryLayout: {
      regions: [
        {
          regionId: "code",
          kind: "code",
          startAddressHex: "0x400000",
          byteLength: 4096,
          permissions: "rx",
          publicLabel: "代码段",
        },
      ],
    },
    allowedActions: ["write_bytes", "step"],
    resourceLimits: {},
    hintLadder: [
      { order: 1, revealPolicy: "on_request", hintText: "机检提示一" },
      { order: 2, revealPolicy: "after_n_failures", failureThreshold: 2, hintText: "机检提示二" },
    ],
    publicErrorMapping: [
      { errorCode: "inaccessible_address", teachingNote: "机检教学注解" },
    ],
    randomizationNotice: "固定布局,无随机化面。",
    initialProjection: {
      visibleRegions: [
        {
          regionId: "code",
          label: "代码段",
          startAddressHex: "0x400000",
          byteLength: 4096,
          permissions: "rx",
          bytesHex: "c390",
          truncated: true,
        },
      ],
      visibleRegisters: [
        { name: "RSP", valueHex: "0x7FFFFFF8" },
        { name: "RAX", valueHex: "0x0" },
      ],
      semanticHighlights: [
        {
          kind: "buffer_start",
          targetRegionId: "code",
          startAddressHex: "0x400000",
          byteLength: 16,
          label: "输入缓冲区(占位)",
        },
      ],
    },
  };
}

function parsedDebugMode(debugMode: boolean | undefined): boolean {
  const input = descriptorWithoutDebugMode();
  if (debugMode !== undefined) {
    input["debugMode"] = debugMode;
  }
  const parsed = parseDescriptorView(input);
  expect(parsed, "描述包夹具必须可解析(否则恒等断言在空值上假绿)").not.toBeNull();
  return parsed?.debugMode === true;
}

describe("M3 遗留-5 ③:debugMode 缺省语义跨包恒等机检", () => {
  it("① 正式通道(vm-ui descriptor)仍为 opt-out 缺省启用,且 vm-ui 侧无第二处定义", () => {
    expect(vmUiDescriptorFindings(readSource(VM_UI_DESCRIPTOR))).toEqual([]);
    // vm-ui 侧「定义点」唯一性:src/** 内恰一处(收敛面由机检锁定)。
    const sites = vmUiDefinitionSites();
    expect(sites, `vm-ui 侧出现多处 debugMode 缺省定义点:${sites.join(", ")}`).toEqual([
      "packages/vm-ui/src/descriptor/challenge-descriptor.ts",
    ]);
  });

  it("② 现行取包注入点(page-app 引导)与正式通道同口径:缺省即启用、仅显式 false 关闭", () => {
    expect(pageAppBootFindings(readSource(PAGE_APP_BOOT))).toEqual([]);
  });

  it("③ 服务端调试通道门控(session-api)同口径:仅显式 false 判否", () => {
    expect(sessionApiFindings(readSource(SESSION_API_GATE))).toEqual([]);
  });

  it("四处恒等(行为面):缺省 / 显式 true / 显式 false 三档取值完全一致", () => {
    // 字面面:两处「缺省档」字面值必须同值(把归一化口径与注入点口径钉在一起)。
    const vmUiDefault = vmUiDefaultLiteral(readSource(VM_UI_DESCRIPTOR));
    const pageAppDefault = pageAppImpliedDefault(readSource(PAGE_APP_BOOT));
    expect(vmUiDefault, "vm-ui 归一化的缺省档字面值必须可提取").not.toBeNull();
    expect(pageAppDefault, "page-app 注入点的缺省档字面值必须可提取").not.toBeNull();
    expect(pageAppDefault, "两处缺省档口径必须同值(跨包恒等机检)").toBe(vmUiDefault);
    expect(vmUiDefault).toBe(true);

    // 缺省档:四处一致为「启用」(vm-ui 归一化 / page-app 注入 / session-api 门控)。
    expect(parsedDebugMode(undefined)).toBe(true);
    expect(pageAppEnables(undefined)).toBe(true);
    expect(sessionApiEnables(undefined)).toBe(true);

    // 显式 true / false 档:四处一致(仅显式 false 关闭)。
    for (const declared of [true, false] as const) {
      const vmUi = parsedDebugMode(declared);
      const pageApp = pageAppEnables(declared);
      const sessionApi = sessionApiEnables(declared);
      expect([vmUi, pageApp, sessionApi], `declared=${declared} 三处口径必须一致`).toEqual([
        declared,
        declared,
        declared,
      ]);
    }
  });
});

/**
 * 机检器自检(反例必须判红):把「红灯位置」固化成用例 —— 若机检器退化为
 * 永远绿的形态,本组即红。反例 1 就是 WP-75#9 修复前的真实缺陷形态。
 */
describe("M3 遗留-5 ③:机检器自检(合成反例必须判红)", () => {
  const counterExamples: Record<string, () => string[]> = {
    "page-app 引导回退为「按 === true 判真」(WP-75#9 前的真实缺陷形态)": () =>
      pageAppBootFindings(
        'workspace.debugModeAvailable = view["debugMode"] === true;',
      ),
    "page-app 引导改为缺省关闭(=== undefined ? false)": () =>
      pageAppBootFindings(
        'workspace.debugModeAvailable = view["debugMode"] === undefined ? false : true;',
      ),
    "page-app 引导缺 `!== false` 字面(改走真值强制转换)": () =>
      pageAppBootFindings("workspace.debugModeAvailable = Boolean(view[\"debugMode\"]);"),
    "正式通道归一化翻转为缺省关闭(=== undefined ? false)": () =>
      vmUiDescriptorFindings(
        'debugMode: input["debugMode"] === undefined ? false : (input["debugMode"] as boolean),',
      ),
    "服务端门控改为「按 === true 判真」": () =>
      sessionApiFindings("if (descriptor?.debugMode === true) { attach(); }"),
  };

  for (const [label, buildCounterExample] of Object.entries(counterExamples)) {
    it(`反例判红:${label}`, () => {
      expect(buildCounterExample().length).toBeGreaterThan(0);
    });
  }

  it("正例判绿(机检器不误报):三处合规片段零发现", () => {
    expect(
      pageAppBootFindings('workspace.debugModeAvailable = view["debugMode"] !== false;'),
    ).toEqual([]);
    expect(
      vmUiDescriptorFindings(
        'debugMode: input["debugMode"] === undefined ? true : (input["debugMode"] as boolean),',
      ),
    ).toEqual([]);
    expect(sessionApiFindings("if (descriptor?.debugMode === false) { reject(); }")).toEqual([]);
  });

  it("缺省档字面值提取器自检:反向字面必被判为漂移", () => {
    // 若两个提取器之一被改成「永远返回 true」,下面这条即红。
    expect(
      pageAppImpliedDefault('workspace.debugModeAvailable = view["debugMode"] === true;'),
    ).toBe(false);
    expect(
      vmUiDefaultLiteral('debugMode: input["debugMode"] === undefined ? false : true,'),
    ).toBe(false);
    expect(
      pageAppImpliedDefault('workspace.debugModeAvailable = view["debugMode"] !== false;'),
    ).toBe(true);
  });
});

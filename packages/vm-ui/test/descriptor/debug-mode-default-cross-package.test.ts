/**
 * M3 遗留移交清单第 5 项 ③:`debugMode` 缺省语义(opt-out,**缺省 = 启用**)的
 * 跨包恒等机检。
 *
 * 事实(取证):该语义在三个包里**各自就地声明**,物理上不共享 ——
 *  1. 正式通道归一化:`packages/vm-ui/src/descriptor/challenge-descriptor.ts`
 *     (`debugMode: input["debugMode"] === undefined ? true : value`);
 *  2. 开发壳夹具通道:`apps/plugin-dev/src/main.ts`
 *     (`export const DEBUG_MODE_DEFAULT = true` + `debugMode ?? DEBUG_MODE_DEFAULT`);
 *  3. 服务端调试通道门控:`apps/session-api/src/debug/debug-channel-orchestrator.ts`
 *     (仅 `descriptor.debugMode === false` 判否)。
 *
 * 为什么不做物理共享(理由见 `docs/develop/decisions-m3/遗留-5.md` D-API-144):
 *  - `apps/plugin-dev` **禁止**静态导入 `@stackmaster/vm-ui`
 *    (dependency-cruiser `no-backend-dependency-on-browser-packages`);
 *  - `packages/vm-ui` **禁止**依赖 `challenge-schema`
 *    (`challenge-schema-dependents-restricted`);`protocol` 是唯一跨域共享面,
 *    但该席位文件锁不含 `packages/protocol`(并发在改)。
 *  ⇒ 取「保留重复 + 机检三者恒等」:任何一处**独立漂移**(例如开发壳回退到
 *  「按 `=== true` 判真 = 缺省关闭」的 WP-75#9 前的缺陷形态)本文件即红灯。
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
const DEV_SHELL_MAIN = join(REPO_ROOT, "apps/plugin-dev/src/main.ts");
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

/** 开发壳夹具通道(plugin-dev):常量缺省值必须是 `true`,归一化必须是 `??` 形态。 */
export function devShellFindings(source: string): string[] {
  const findings: string[] = [];
  if (!/export const DEBUG_MODE_DEFAULT = true;/.test(source)) {
    findings.push("开发壳 `DEBUG_MODE_DEFAULT` 不再是 `true`(或已改名):缺省语义漂移");
  }
  if (!/return debugMode \?\? DEBUG_MODE_DEFAULT;/.test(source)) {
    findings.push("开发壳 `normalizeDebugMode` 不再是 `debugMode ?? DEBUG_MODE_DEFAULT` 形态");
  }
  if (/debugMode\s*===\s*true/.test(source)) {
    findings.push("开发壳出现 `debugMode === true`:缺省语义会翻转为「缺省关闭」");
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

/** 从开发壳源码提取常量字面值(无法提取时返回 null)。 */
export function devShellDefaultValue(source: string): boolean | null {
  const match = /export const DEBUG_MODE_DEFAULT = (true|false);/.exec(source);
  return match === null ? null : match[1] === "true";
}

/**
 * 服务端门控语义的等价谓词模拟:仅显式 `false` 关闭。
 * (与 session-api 源码中的 `=== false` 判否同口径;用于三者恒等的**行为面**比对。)
 */
export function sessionApiEnables(declared: boolean | undefined): boolean {
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

  it("② 开发壳夹具通道(plugin-dev)与正式通道同口径:缺省即启用、仅显式 false 关闭", () => {
    expect(devShellFindings(readSource(DEV_SHELL_MAIN))).toEqual([]);
  });

  it("③ 服务端调试通道门控(session-api)同口径:仅显式 false 判否", () => {
    expect(sessionApiFindings(readSource(SESSION_API_GATE))).toEqual([]);
  });

  it("三者恒等(行为面):缺省 / 显式 true / 显式 false 三档取值完全一致", () => {
    const devShellDefault = devShellDefaultValue(readSource(DEV_SHELL_MAIN));
    expect(devShellDefault, "开发壳常量字面值必须可提取").not.toBeNull();

    // 缺省档:三处一致为「启用」。
    expect(parsedDebugMode(undefined)).toBe(true);
    expect(devShellDefault).toBe(true);
    expect(sessionApiEnables(undefined)).toBe(true);

    // 显式 true / false 档:三处一致(仅显式 false 关闭)。
    for (const declared of [true, false] as const) {
      const vmUi = parsedDebugMode(declared);
      const devShell = declared; // `debugMode ?? DEBUG_MODE_DEFAULT` 对显式布尔原样返回
      const sessionApi = sessionApiEnables(declared);
      expect([vmUi, devShell, sessionApi], `declared=${declared} 三处口径必须一致`).toEqual([
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
    "开发壳回退为「按 === true 判真」(WP-75#9 前的真实缺陷形态)": () =>
      devShellFindings("export const DEBUG_MODE_DEFAULT = true;\nexport function f(d){ return d === true; }"),
    "开发壳常量翻转为缺省关闭(DEBUG_MODE_DEFAULT = false)": () =>
      devShellFindings("export const DEBUG_MODE_DEFAULT = false;\n  return debugMode ?? DEBUG_MODE_DEFAULT;"),
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
      devShellFindings(
        "export const DEBUG_MODE_DEFAULT = true;\n  return debugMode ?? DEBUG_MODE_DEFAULT;",
      ),
    ).toEqual([]);
    expect(
      vmUiDescriptorFindings(
        'debugMode: input["debugMode"] === undefined ? true : (input["debugMode"] as boolean),',
      ),
    ).toEqual([]);
    expect(sessionApiFindings("if (descriptor?.debugMode === false) { reject(); }")).toEqual([]);
  });
});

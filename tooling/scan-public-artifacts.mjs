#!/usr/bin/env node
/**
 * R8 公开构建图与产物隔离扫描(整改清单 §十)。
 *
 * 对浏览器可达包(protocol、vm-ui、web-component、embed-runtime、
 * react-wrapper;尚未落地的包自动跳过)执行:
 *   1. 从 package.json exports 的**公开入口**(排除 server-only 子路径)
 *      做 dist 产物静态依赖图 BFS;
 *   2. 可达文件禁止引用:server-only 子树、Schema 生成器(node:fs)、
 *      node 内建模块、challenge-schema / vm-engine 产物;
 *   3. 可达文件剥离注释后扫描私有面标记(私有 Schema 名、私有顶层字段、
 *      capability 前缀、CommonJS require)。
 *
 * 任何命中都以退出码 1 失败(CI 门禁,不是提示)。误报豁免:在
 * ALLOWLIST 中登记"文件 × 标记"并注明原因与复核日期,豁免条目过期
 * (EXPIRY)后自动失效即失败。
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 浏览器可达包(dist 落地后才纳入扫描;challenge-schema 刻意不在列)。 */
const PUBLIC_PACKAGES = [
  "protocol",
  "vm-ui",
  "web-component",
  "embed-runtime",
  "react-wrapper",
];

/**
 * 误报豁免(文件路径含包名,正则标记,原因,到期日 YYYY-MM-DD)。
 * 空表即当前无豁免;新增豁免必须带理由与复核期限。
 * @type {Array<{ file: string, pattern: string, reason: string, expiry: string }>}
 */
const ALLOWLIST = [];

const FORBIDDEN_CONTENT_PATTERNS = [
  { pattern: /\bprivate-bundle\b/, label: "私有判题包 Schema 名" },
  { pattern: /\bsecretSinkRegisters\b/, label: "私有顶层字段" },
  { pattern: /\bdeclaredSeedPublicPaths\b/, label: "私有顶层字段" },
  { pattern: /\bseedHex\b/, label: "私有 seed 字段" },
  { pattern: /\bhiddenTests\b/, label: "私有判题字段" },
  { pattern: /\bcontainsSecret\b/, label: "私有秘密标记" },
  { pattern: /\bisHidden\b/, label: "私有可见性标记" },
  { pattern: /\bentrypointAddressHex\b/, label: "私有程序入口" },
  { pattern: /\bjudgingConfig\b/, label: "私有判题配置" },
  { pattern: /\bcompiledIr\b/, label: "私有 IR 信封" },
  { pattern: /virtual_file:/, label: "capability 前缀" },
  { pattern: /\bchallenge-schema\b/, label: "server-only 姊妹包引用" },
  { pattern: /\bvm-engine\b|\bvm-worker\b|\bvm-core\b/, label: "VM 引擎产物引用" },
  { pattern: /\brequire\s*\(/, label: "CommonJS require(ESM 产物不应出现)" },
];

const FORBIDDEN_IMPORT_SPECIFIERS = [
  { pattern: /^node:/, label: "node 内建模块" },
  { pattern: /^fs$|^path$|^url$|^child_process$/, label: "node 内建模块(裸名)" },
  { pattern: /@stackmaster\/challenge-schema/, label: "challenge-schema 引用" },
  { pattern: /server-only/, label: "server-only 子路径" },
];

/**
 * 剥离 JS 注释(字符串感知 + 正则字面量感知状态机;产物为 tsc 输出)。
 *
 * 正则字面量启发式(R16 审查 MEDIUM-1 修复):code 态遇到 `/` 且前一有效
 * 字符是运算符 / 开括号 / 逗号等时,判定为正则字面量开头——正则态内引号
 * 不开字符串,`[` 类内 `/` 与引号均为字面量,直至非类内未转义 `/` 闭合。
 * 没有这条规则,`/["']/` 类产物会把状态机困在 string 态,后续真实内容
 * 被吞、私有面标记漏报(静默绿灯)。
 */
/** 前一有效字符属于本集 ⇒ `/` 只可能是正则字面量开头(不可能是除法)。 */
const REGEX_PRECEDING_CHARS = new Set("(,=:[!&|?{};+-*%~^<>");

function isRegexStart(code, index) {
  if (code[index + 1] === "/" || code[index + 1] === "*") {
    return false; // 行注释 / 块注释(调用方已先行排除这两种)。
  }
  let lookback = index - 1;
  while (lookback >= 0 && /\s/.test(code[lookback])) {
    lookback -= 1;
  }
  const prev = lookback >= 0 ? code[lookback] : "";
  // 语句开始(前一字符为空)或前一字符为运算符 / 开括号 / 逗号 / 分号等
  // ⇒ 除法不可能出现在该位置,判定为正则字面量。
  return prev === "" || REGEX_PRECEDING_CHARS.has(prev);
}

function stripComments(code) {
  let output = "";
  let index = 0;
  let state = "code";
  let regexInClass = false;
  while (index < code.length) {
    const char = code[index];
    const next = code[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        index += 2;
        continue;
      }
      if (char === "/" && isRegexStart(code, index)) {
        state = "regex";
        regexInClass = false;
        output += char;
        index += 1;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        state = char;
        output += char;
        index += 1;
        continue;
      }
      output += char;
      index += 1;
      continue;
    }
    if (state === "line") {
      if (char === "\n") {
        state = "code";
        output += char;
      }
      index += 1;
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        output += " ";
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (state === "regex") {
      output += char;
      if (char === "\\") {
        output += next ?? "";
        index += 2;
        continue;
      }
      if (regexInClass) {
        if (char === "]") {
          regexInClass = false;
        }
      } else if (char === "[") {
        regexInClass = true;
      } else if (char === "/") {
        state = "code";
      }
      index += 1;
      continue;
    }
    // 字符串状态:保留内容,处理转义。
    output += char;
    if (char === "\\") {
      output += next ?? "";
      index += 2;
      continue;
    }
    if (char === state) {
      state = "code";
    }
    index += 1;
  }
  return output;
}

/** 扫描器自检(R16 审查要求):剥离器与导入解析的最小行为锚,失败即拒扫。 */
function selfTest() {
  const cases = [
    // 正则字面量含引号:不得吞掉其后的真实字符串(含 // 的 URL)。
    {
      input: 'const r = /["\']+/g; const u = "https://example.invalid/a"; secretSinkRegisters;',
      expect: "secretSinkRegisters",
    },
    // 字符类内的 / 与引号均为字面量。
    {
      input: "const r = /a[\"'/]b/; secretSinkRegisters;",
      expect: "secretSinkRegisters",
    },
    // 除法不是正则:后的 // 仍是行注释。
    { input: "const q = a / b; // secretSinkRegisters\n", expect: "const q = a / b;" },
    // 相对导入解析。
    {
      input: 'import { x } from "./a.js"; export * from "./b.js"; import("./c.js");',
      expect: 'from "./a.js"',
    },
  ];
  for (const item of cases) {
    const stripped = stripComments(item.input);
    if (!stripped.includes(item.expect)) {
      console.error(`扫描器自检失败:剥离结果丢失标记\n输入:${item.input}\n输出:${stripped}`);
      process.exit(1);
    }
  }
}

/** 解析 ESM 静态/动态相对导入说明符。 */
function extractRelativeImports(code) {
  const specifiers = [];
  const importPattern =
    /(?:^|[\s;}])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
  let match = importPattern.exec(code);
  while (match !== null) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
    match = importPattern.exec(code);
  }
  return specifiers;
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    join(base, "index.js"),
    join(base, "index.mjs"),
  ]) {
    if (existsSync(candidate) && /\.(js|mjs|cjs)$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** 解析 exports 条件目标:default 优先,回退 import;均不可用返回 null(调用方显式报错)。 */
function resolveExportTarget(condition) {
  if (typeof condition === "string") {
    return condition;
  }
  if (condition !== null && typeof condition === "object") {
    for (const key of ["default", "import", "node-import"]) {
      const resolved = resolveExportTarget(condition[key]);
      if (resolved !== null) {
        return resolved;
      }
    }
  }
  return null;
}

function publicEntryFiles(packageDir, packageName) {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const entries = [];
  const exportsMap = manifest.exports ?? { ".": { default: manifest.main ?? "dist/index.js" } };
  for (const [subpath, condition] of Object.entries(exportsMap)) {
    if (subpath.includes("server-only")) {
      continue;
    }
    const target = resolveExportTarget(condition);
    if (target === null) {
      // R16 审查 MEDIUM-2 修复:条件对象无可用 JS 目标时显式失败,
      // 不允许公开入口被静默跳过而退化为零覆盖。
      findings.push({
        severity: "error",
        package: packageName,
        message: `公开入口 ${subpath} 的 exports 条件不含可扫描的 JS 目标(default/import 均缺失)`,
      });
      continue;
    }
    if (target.endsWith(".js") || target.endsWith(".mjs") || target.endsWith(".cjs")) {
      entries.push({ subpath, file: join(packageDir, target) });
    } else {
      findings.push({
        severity: "error",
        package: packageName,
        message: `公开入口 ${subpath} 指向非 JS 产物 "${target}",无法纳入扫描`,
      });
    }
  }
  if (entries.length === 0) {
    throw new Error(`包 ${packageName} 的 exports 未发现可扫描的公开 JS 入口`);
  }
  return entries;
}

function scanPackage(packageName, findings) {
  const packageDir = join(repoRoot, "packages", packageName);
  const distDir = join(packageDir, "dist");
  if (!existsSync(distDir)) {
    findings.push({
      severity: "skip",
      package: packageName,
      message: "dist/ 不存在(尚未构建),跳过——落地后本扫描自动纳入",
    });
    return;
  }

  for (const entry of publicEntryFiles(packageDir, packageName)) {
    if (!existsSync(entry.file)) {
      findings.push({
        severity: "error",
        package: packageName,
        file: entry.file,
        message: `公开入口 ${entry.subpath} 声明的产物缺失(先构建再扫描)`,
      });
      continue;
    }

    // 1. 公开入口静态依赖图 BFS。
    const reachable = new Set();
    const queue = [entry.file];
    while (queue.length > 0) {
      const current = queue.pop();
      if (reachable.has(current)) {
        continue;
      }
      reachable.add(current);
      const code = stripComments(readFileSync(current, "utf8"));
      for (const specifier of extractRelativeImports(code)) {
        const resolved = resolveSpecifier(current, specifier);
        if (resolved !== null) {
          queue.push(resolved);
          continue;
        }
        if (!specifier.startsWith(".")) {
          for (const rule of FORBIDDEN_IMPORT_SPECIFIERS) {
            if (rule.pattern.test(specifier)) {
              findings.push({
                severity: "error",
                package: packageName,
                file: relative(repoRoot, current),
                message: `公开构建图引用违规模块 "${specifier}"(${rule.label})`,
              });
            }
          }
        }
      }
    }

    // 2. 可达文件内容标记扫描(注释已剥离,杜绝文档性误报)。
    for (const file of reachable) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const rule of FORBIDDEN_CONTENT_PATTERNS) {
        if (rule.pattern.test(code)) {
          const relFile = relative(repoRoot, file);
          const exempt = ALLOWLIST.some(
            (item) => item.file === relFile && item.pattern === rule.pattern.source,
          );
          findings.push({
            severity: exempt ? "allowlisted" : "error",
            package: packageName,
            file: relFile,
            message: `公开产物命中私有面标记(${rule.label}):/${rule.pattern.source}/`,
          });
        }
      }
    }
  }
}

const findings = [];
selfTest();
for (const packageName of PUBLIC_PACKAGES) {
  scanPackage(packageName, findings);
}

const allowlisted = findings.filter((item) => item.severity === "allowlisted");
const skips = findings.filter((item) => item.severity === "skip");
const errors = findings.filter((item) => item.severity === "error");

for (const item of allowlisted) {
  console.log(`[allowlisted] ${item.file}: ${item.message}`);
}
for (const item of skips) {
  console.log(`[skip] ${item.package}: ${item.message}`);
}

if (errors.length > 0) {
  console.error("\n公开构建图 / 产物隔离扫描失败:");
  for (const item of errors) {
    console.error(`  [${item.package}] ${item.file ?? "(入口)"}: ${item.message}`);
  }
  process.exit(1);
}

console.log(
  `\nR8 隔离扫描通过:${PUBLIC_PACKAGES.length - skips.length} 个公开包已扫描,` +
    `0 违规,${allowlisted.length} 条豁免。`,
);

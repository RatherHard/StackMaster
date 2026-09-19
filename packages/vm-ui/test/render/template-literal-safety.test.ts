/**
 * 模板字面量注释安全机检(2026-09-18 新增;三次真实事故的防回归)。
 *
 * 纪律:css / html **模板字面量内部的注释里一律不得出现反引号**。
 *
 * 为什么(本仓库真实事故 ×3):
 * TypeScript 5.9 的 scanner 在扫描模板字面量时,会把注释里的反引号当成模板
 * 定界符 ⇒ 模板被提前闭合 ⇒ 整个文件解析崩塌(TS1005 / TS1351 / TS1128 数十条
 * 级联),而且单元测试根本跑不到(整个包 import 即失败)。
 * 最小复现(见本文件第二条用例,已实测):模板内注释写一对反引号 ⇒ 5 条语法错误;
 * 把注释里的反引号去掉 ⇒ 0 条。
 * 已发生:src/workspace/sm-workspace.ts(两次)、src/views/byte/byte-view.ts(一次,
 * 导致整棵树门禁红)。
 *
 * 本测试的做法:对 src/** 与 test/** 的每个 .ts 文件跑 TypeScript **公开 API**
 * `ts.transpileModule(text, { reportDiagnostics: true })` 并断言诊断为空 —— 直接
 * 命中「文件级解析崩塌」这一失败模式本身,不依赖任何手写扫描器。
 * (不用 `SourceFile.parseDiagnostics`:那是 TypeScript 内部 API、不在公开 .d.ts 上;
 *  `transpileModule` 是公开面,且对本失败模式的检出已由第二条用例红灯自证。)
 *
 * 边界(如实登记):模板字面量**外部**的注释(文件头 JSDoc / 普通块注释)里的反引号
 * 无害(scanner 在注释态不产出模板 token),本测试不会因此报红 —— 与纪律一致。
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";

/** 反引号(避免本文件自身出现裸反引号,便于人工审阅)。 */
const BT = String.fromCharCode(96);

/** 语法诊断(公开 API;`reportDiagnostics: true`)。 */
function syntaxDiagnostics(text: string, fileName: string): readonly ts.Diagnostic[] {
  return (
    ts.transpileModule(text, {
      fileName,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).diagnostics ?? []
  );
}

/** 定位 vm-ui 包根(兼容「包内跑」与「仓库根聚合跑」两种形态)。 */
function resolvePackageRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    for (const candidate of [dir, join(dir, "packages", "vm-ui")]) {
      if (existsSync(join(candidate, "src", "theme", "theme-tokens.ts"))) {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("未定位到 vm-ui 包根(模板安全机检失败)");
}

/** 递归收集目录下的 .ts 文件(不含 .d.ts)。 */
function collectSources(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

describe("模板字面量注释安全(语法诊断机检)", () => {
  it("src/** 与 test/** 的每个 .ts 文件都可被 TypeScript 转译(零语法诊断)", () => {
    const root = resolvePackageRoot();
    const files = [...collectSources(join(root, "src")), ...collectSources(join(root, "test"))];
    // 防「扫描失效导致假绿」:必须真的扫到源文件。
    expect(files.length).toBeGreaterThan(80);

    const failures: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const diagnostics = syntaxDiagnostics(text, file);
      if (diagnostics.length === 0) {
        continue;
      }
      const first = diagnostics[0]!;
      const relative = file.startsWith(root) ? file.slice(root.length + 1) : file;
      const position =
        first.file === undefined || first.start === undefined
          ? null
          : first.file.getLineAndCharacterOfPosition(first.start);
      failures.push(
        `${relative}${position === null ? "" : `:${position.line + 1}`}: ` +
          ts.flattenDiagnosticMessageText(first.messageText, " "),
      );
    }
    expect(
      failures,
      "以下文件存在语法错误(最常见根因:css/html 模板字面量的注释里写了反引号 ⇒ 模板提前闭合):",
    ).toEqual([]);
  });

  it("红灯自证:模板注释内的反引号必然被本机检抓到(防「机检失效」假绿)", () => {
    const broken = [
      "const css = (s) => s;",
      "class X {",
      `  static s = css${BT}`,
      `    /* 注释里的反引号: ${BT}100dvh${BT} */`,
      `${BT};`,
      "}",
    ].join("\n");
    expect(syntaxDiagnostics(broken, "broken.ts").length).toBeGreaterThan(0);

    // 对照:把全部反引号去掉即零诊断(证明报错确由它们造成)。
    const fixed = broken.split(BT).join("");
    expect(syntaxDiagnostics(fixed, "fixed.ts").length).toBe(0);
  });
});

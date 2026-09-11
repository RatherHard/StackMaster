/**
 * 构建产物断言(dist 自包含 / 非根路径资源引用 / 插件文档页零内联脚本):
 * 受限 CSP(`script-src 'self'`)兼容性的静态自测面。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(packageRoot, "dist", "index.js");
const pluginPage = join(packageRoot, "plugin", "index.html");

describe("构建产物自包含(Q3 定案的机械断言)", () => {
  it("dist 单产物存在(单文件形态,无伴随 chunk)", () => {
    expect(existsSync(distEntry)).toBe(true);
    const code = readFileSync(distEntry, "utf8");
    // 零相对路径 chunk 导入(单产物;codeSplitting: false)。
    expect(code).not.toMatch(/from\s*["']\.\/[^"']+["']/);
    expect(code).not.toMatch(/import\s*\(\s*["']\.\/[^"']+["']/);
  });

  it("dist 零工作区外部导入(lit / vm-ui / protocol / embed-runtime 全部内联)", () => {
    const code = readFileSync(distEntry, "utf8");
    // 裸说明符导入只允许出现在被剥离无效的注释之外——静态扫描:不得出现
    // 任何 `from "<非相对>"` / `import "<非相对>"` 形态(自包含纪律)。
    const externalImports = [
      ...code.matchAll(/(?:^|[;\s}])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g),
      ...code.matchAll(/(?:^|[;\s}])import\s*["']([^"']+)["']/g),
    ]
      .map((match) => match[1])
      .filter((specifier): specifier is string => specifier !== undefined);
    const offenders = externalImports.filter((specifier) => !specifier.startsWith("."));
    expect(offenders).toEqual([]);
    // 动态导入同理(零 eval / 零远端拉取)。
    const dynamicImports = [...code.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)]
      .map((m) => m[1])
      .filter((specifier): specifier is string => specifier !== undefined);
    expect(dynamicImports.filter((specifier) => !specifier.startsWith(".")).map((s) => s)).toEqual([]);
  });

  it("dist 产物注册 pwn-memory-vm 与 sm-workspace(装配面完整)", () => {
    const code = readFileSync(distEntry, "utf8");
    expect(code).toContain("pwn-memory-vm");
    expect(code).toContain("sm-workspace");
  });
});

describe("插件文档页(部署形态;受限 CSP 兼容自测)", () => {
  it("零内联脚本(唯一 script 经相对路径 src 引用)", () => {
    const html = readFileSync(pluginPage, "utf8");
    const scriptTags = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    expect(scriptTags.length).toBe(1);
    expect(scriptTags[0]?.[1]?.trim() ?? "").toBe(""); // script 体为空 = 零内联代码。
    expect(html).toMatch(/<script[^>]+src="\.\/pwn-memory-vm\.js"/); // 相对路径(非根路径部署)。
    expect(html).not.toMatch(/\son[a-z]+\s*=/i); // 零内联事件处理器。
  });

  it("实例化 <pwn-memory-vm> 并以 attribute 注入引导端点(部署契约)", () => {
    const html = readFileSync(pluginPage, "utf8");
    expect(html).toMatch(/<pwn-memory-vm\s[^>]*bootstrap-endpoint="/);
  });
});

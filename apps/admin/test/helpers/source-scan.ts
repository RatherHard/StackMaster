/**
 * 源码机检设施(管理面零写 / 凭证独立性的**结构性**锚点)。
 *
 * 形态:把 `apps/admin/src/**\/*.ts` 读成文本、剥注释,再对**代码文本**
 * 做模式断言——这样文档里为了说明纪律而引用的关键字(例如审计账的十值
 * 封闭集、`GRANT` 面的说明)不会把断言变成假红灯,而真正的代码只要出现
 * 写语句形态就会被抓出。
 *
 * 已知边界(如实登记):剥注释用"块注释 + 行注释"两级正则,字符串里出现
 * `//` 的内容会被截断——管理面源码里不存在这类字符串(连接串只在配置与
 * compose 里),因此不构成漏判面;若将来引入,必须升级为词法级剥离。
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** 管理面源码根(apps/admin/src)。 */
export const ADMIN_SRC_DIR = fileURLToPath(new URL("../../src/", import.meta.url));

/** 递归读取源码文件(相对 apps/admin 的仓库内路径 + 文本)。 */
export async function readAdminSources(): Promise<
  { readonly path: string; readonly text: string }[]
> {
  const entries = await readdir(ADMIN_SRC_DIR, { recursive: true, withFileTypes: true });
  const files: { path: string; text: string }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }
    const absolute = `${entry.parentPath}/${entry.name}`.replaceAll("\\", "/");
    files.push({
      path: absolute.slice(absolute.indexOf("/apps/admin/") + 1),
      text: await readFile(absolute, "utf8"),
    });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** 剥注释(块注释 → 空白;行注释 → 截断到行尾)。 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** 命中给定模式的源码位置(路径 + 行号 + 行文本)。 */
export interface SourceHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** 在管理面源码里搜索模式(按行;注释已剥离)。 */
export async function findInAdminCode(pattern: RegExp): Promise<readonly SourceHit[]> {
  const hits: SourceHit[] = [];
  for (const file of await readAdminSources()) {
    const code = stripComments(file.text);
    const lines = code.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const matcher = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      if (matcher.test(line)) {
        hits.push({ path: file.path, line: index + 1, text: line.trim() });
      }
    }
  }
  return hits;
}

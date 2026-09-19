/**
 * 会话动作协议 N-1 窗口**关闭**回归机检(分发改版 WP-96;D-LT-5 四·补.3 第 1 条)。
 *
 * 本套件的前身是「窗口期两版可表达」的契约测试。**2026-09-19 窗口关闭**后,
 * 它的职责**反转**为「窗口期受理的形态现在必须被拒」——这正是本次删除的
 * 判定标准,也是防"窗口静默重开 / v1 面静默复活"的回归护栏:
 *
 * - **版本面**:`SESSION_ACTION_PROTOCOL_VERSION = 2`、受理集合 = `[2]`
 *   (单元素);`…/schemas/session-action/v2/` 是唯一命名空间;
 * - **v1 请求必须被拒**(与窗口期受理**相反**):v1 动作信封 / v1 传输帧 /
 *   v1 会话命令(四键 create_session)全部被当前冻结 Schema 拒绝,
 *   且拒绝**冻结在版本字面量那一处**(错误形态 = `protocolVersion` 不匹配,
 *   而不是"形状看起来对但被别处拒");
 * - **单版事实的结构性证据**:契约包不再导出任何 `*V1Schema` /
 *   `SESSION_ACTION_PROTOCOL_PREVIOUS_VERSION`(源码面扫描;符号消失即
 *   不可被重新依附),v1 fixture 目录(`action-request-v1` /
 *   `wss-frame-v1` / `session-command-request-v1`)已删除。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActionRequestSchema } from "../src/session-action/action-request.js";
import { SessionCommandRequestSchema } from "../src/session-command/session-command-request.js";
import { WssFrameSchema } from "../src/transport/wss-frame.js";
import {
  SESSION_ACTION_PROTOCOL_VERSION,
  SESSION_ACTION_SCHEMA_BASE_ID,
  SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS,
} from "../src/version.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures");
const PACKAGE_ROOT = join(import.meta.dirname, "..");

function loadFixture(...segments: readonly string[]): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, ...segments), "utf8")) as unknown;
}

/** 窗口期曾受理的 v1 形态(现在必须被拒)。 */
const V1_PROTOCOL_VERSION = 1;
const V2_ACTION = loadFixture("action-request", "valid", "call.json");
const V2_FRAME = loadFixture("wss-frame", "valid", "01-action-frame.json");

/** v1 会话命令请求(四键 create_session;窗口期的受理形态)。 */
const V1_SESSION_COMMAND = {
  protocolVersion: V1_PROTOCOL_VERSION,
  command: "create_session",
  payload: {
    challengeId: "stack-smash-101",
    challengeVersion: "1.0.0",
    // 窗口期 v1 载荷的第二对键:两枚都已在 v2 退场。
    embedSessionId: "3xK9mQ7pL2vN8wRtY5uB1a",
    embedToken: "header.payload.signature",
  },
} as const;

/** 只取"版本字面量不匹配"这一类 issue 的路径(冻结错误形态的定位面)。 */
function versionIssuePaths(error: { issues: readonly { path: readonly PropertyKey[] }[] }): string[] {
  return error.issues
    .filter((issue) => issue.path.includes("protocolVersion"))
    .map((issue) => issue.path.join("."));
}

describe("会话动作协议 N-1 窗口已关闭(2026-09-19,随 WP-96)", () => {
  it("版本面:v2 生效,受理集合回落**单元素 [2]**,$id 命名空间恒为 v2", () => {
    expect(SESSION_ACTION_PROTOCOL_VERSION).toBe(2);
    expect([...SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS]).toEqual([2]);
    expect(SUPPORTED_SESSION_ACTION_PROTOCOL_VERSIONS).toHaveLength(1);
    expect(SESSION_ACTION_SCHEMA_BASE_ID).toBe(
      "https://stackmaster.dev/schemas/session-action/v2",
    );
  });

  it("★ 回归:v1 动作信封被拒(窗口期曾受理 ⇒ 现必须拒),冻结错误定位在 protocolVersion", () => {
    // v2 样例只改版本字面量 ⇒ 载荷形状本身合法,拒绝的唯一来源是版本判定。
    const v1Action = { ...(V2_ACTION as Record<string, unknown>), protocolVersion: V1_PROTOCOL_VERSION };
    const result = ActionRequestSchema.safeParse(v1Action);
    expect(result.success).toBe(false);
    if (!result.success) {
      // 冻结错误形态:拒绝落在版本字面量上(不是形状漂移的副作用)。
      expect(versionIssuePaths(result.error)).toEqual(["protocolVersion"]);
    }
  });

  it("★ 回归:v1 传输帧被拒(帧与内层动作载荷都是 v1 也不行)", () => {
    const v1Frame = {
      ...(V2_FRAME as Record<string, unknown>),
      protocolVersion: V1_PROTOCOL_VERSION,
      payload: {
        ...((V2_FRAME as { payload: Record<string, unknown> }).payload),
        protocolVersion: V1_PROTOCOL_VERSION,
      },
    };
    const result = WssFrameSchema.safeParse(v1Frame);
    expect(result.success).toBe(false);
    if (!result.success) {
      // 冻结错误形态:版本 issue 只落在信封 / 内层载荷的 protocolVersion 上
      // (不是形状漂移的副作用);信封那一处必然在场。
      const paths = versionIssuePaths(result.error);
      expect(paths).toContain("protocolVersion");
      expect(paths.every((path) => path === "protocolVersion" || path === "payload.protocolVersion")).toBe(
        true,
      );
      expect(result.error.issues.length).toBe(paths.length);
    }
  });

  it("★ 回归:v1 create_session(四键载荷)被拒——窗口期它曾被 v1 冻结面受理", () => {
    const result = SessionCommandRequestSchema.safeParse(V1_SESSION_COMMAND);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(versionIssuePaths(result.error)).toEqual(["protocolVersion"]);
    }
    // 去掉版本字面量也不放行:embedSessionId / embedToken 在 v2 无表达位。
    const v2VersionWithV1Payload = SessionCommandRequestSchema.safeParse({
      ...V1_SESSION_COMMAND,
      protocolVersion: SESSION_ACTION_PROTOCOL_VERSION,
    });
    expect(v2VersionWithV1Payload.success).toBe(false);
  });

  it("★ 结构证据:契约包**代码**不再含任何 v1 冻结面符号(注释留档照旧在场)", () => {
    const rawSource = collectSourceText(join(PACKAGE_ROOT, "src"));
    const code = stripComments(rawSource);
    for (const symbol of [
      "SESSION_ACTION_PROTOCOL_PREVIOUS_VERSION",
      "ActionRequestV1Schema",
      "WssFrameV1Schema",
      "SessionCommandRequestV1Schema",
      "CreateSessionRequestPayloadV1Schema",
    ]) {
      // 代码面:符号消失 ⇒ 不可被重新依附(结构上不存在第二个版本面)。
      expect(code, `代码仍含 ${symbol}`).not.toContain(symbol);
    }
    // 留档面:决策文字**不得**随删除一起消失(可追溯性要求)——
    // 至少"上一版本常量"这一处单源命名必须在注释里留下痕迹。
    expect(rawSource).toContain("SESSION_ACTION_PROTOCOL_PREVIOUS_VERSION");
  });

  it("★ 结构证据:v1 fixture 目录已删除(窗口的 golden 锚点随之退场)", () => {
    const fixtureDirs = readdirSync(FIXTURE_DIR);
    for (const removed of [
      "action-request-v1",
      "wss-frame-v1",
      "session-command-request-v1",
      "embed-message",
      "embed-token-claims",
    ]) {
      expect(fixtureDirs).not.toContain(removed);
    }
  });
});

/** 递归拼接目录下全部 .ts 源码(结构证据:符号消失即不可被重新依附)。 */
function collectSourceText(root: string): string {
  const chunks: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      chunks.push(collectSourceText(full));
      continue;
    }
    if (entry.endsWith(".ts")) {
      chunks.push(readFileSync(full, "utf8"));
    }
  }
  return chunks.join("\n");
}

/**
 * 剥掉注释后再做符号扫描:`/* … *\/` 与 `// …` 两种形态都去掉。
 * 保留注释里的决策留档是**刻意的**(可追溯性),故"符号是否仍在代码里"
 * 必须与"符号是否仍出现在留档文字里"分开判定。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

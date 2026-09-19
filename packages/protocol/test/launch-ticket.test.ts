/**
 * 启动票据契约族测试(分发改版 WP-90;D-LT-1 ~ D-LT-3)。
 *
 * 本套件是 WP-90 的契约级红灯语料(路由实现期红灯——401 三态同形 / 404 同形 /
 * 429 逐字节 / 日志脱敏机检 / 单次消费原子性——归 session-api 的 WP-91 集成测试):
 *
 * - **键集锁定**:请求恰两键(`challengeId` / `version`),响应恰两键
 *   (`launchUrl` / `expiresAt`)——strictObject 使任何多余键在契约层不可表达;
 * - **租户不由客户端自报**:请求体无 `tenantId` 分类位(租户只由宿主凭证 ×
 *   `SESSION_API_HOST_TENANTS` 白名单派生),自报租户 / 身份 / 版本回显一律拒;
 * - **票据值只在 `launchUrl` 内**:响应无第二个承载票据的字段位(红灯 fixture:
 *   `ticket` 另回一字段即拒);
 * - **长度与形态**:`launchUrl` 为 http(s) 绝对 URL,上限 `LAUNCH_URL_MAX_LENGTH`
 *   (边界值 2048 收 / 2049 拒,在测试内合成,不依赖 fixture 的近似值);
 * - **版本面**:独立契约族版本常量为 1 且受理集合恒含当前版本(5.6),`$id`
 *   命名空间独立(`…/schemas/launch-ticket/v1`);
 * - **形态常量单源**:签发路由 / 换票路径模板 / 查询参数名 / 令牌长度在本包导出,
 *   供 WP-91 / WP-92 引用(两处写字面量 = 漂移面);
 * - **CRITICAL 结构性断言**:两份载荷的形状里**不可能表达** tenantId / userId /
 *   jti / 票据明文 / 隐藏 flag / protocolVersion —— 既非输入键,也非深挖
 *   (嵌套属性、`$ref` 分支)可推导(沿 host-scores「私有面字段在契约层不可表达」
 *   的写法,并扩展到落盘产物的全树属性名)。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE,
  DEFAULT_LAUNCH_TICKET_TTL_SECONDS,
  LAUNCH_TICKET_ISSUANCE_ROUTE,
  LAUNCH_TICKET_PROTOCOL_VERSION,
  LAUNCH_TICKET_QUERY_PARAM,
  LAUNCH_TICKET_REDEEM_PATH_TEMPLATE,
  LAUNCH_TICKET_SCHEMA_BASE_ID,
  LAUNCH_TICKET_TOKEN_LENGTH,
  LAUNCH_URL_MAX_LENGTH,
  LaunchTicketRequestSchema,
  LaunchTicketResponseSchema,
  MAX_LAUNCH_TICKET_TTL_SECONDS,
  SUPPORTED_LAUNCH_TICKET_PROTOCOL_VERSIONS,
} from "../src/index.js";

const FIXTURE_ROOT = join(import.meta.dirname, "fixtures");
const SCHEMA_DIR = join(import.meta.dirname, "..", "schema");

interface FixtureCase {
  readonly name: string;
  readonly payload: unknown;
}

function loadFixtures(family: string, kind: "valid" | "invalid"): readonly FixtureCase[] {
  const dir = join(FIXTURE_ROOT, family, kind);
  return readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => ({
      name: fileName,
      payload: JSON.parse(readFileSync(join(dir, fileName), "utf8")) as unknown,
    }));
}

function readSchemaDocument(family: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(SCHEMA_DIR, `${family}.schema.json`), "utf8"),
  ) as Record<string, unknown>;
}

/**
 * 递归收集 JSON Schema 全树中**所有 `properties` 的键名**(含嵌套、`oneOf` /
 * `allOf` 分支)——用于「深挖也推导不出私有字段」的结构性断言:若某个私有字段
 * 名出现在任何深度的属性位,本函数即可命中,断言随之变红。
 */
function collectPropertyNames(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectPropertyNames(item, out);
    }
    return out;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && value !== null && typeof value === "object") {
        for (const propertyName of Object.keys(value)) {
          out.add(propertyName);
        }
      }
      collectPropertyNames(value, out);
    }
  }
  return out;
}

const ISSUED = {
  launchUrl: "https://lab.example.edu/app/c/chal-stack-escape/1.2.3?t=8Kd2mQ4xR7vT1pLzB6nYcW",
  expiresAt: 1789200300,
} as const;

/** 合成指定长度的启动地址(长度边界断言用;形态合法,只有长度不同)。 */
function launchUrlOfLength(length: number): string {
  const prefix = "https://lab.example.edu/app/c/chal-stack-escape/1.2.3?t=8Kd2mQ4xR7vT1pLzB6nYcW&pad=";
  return prefix + "x".repeat(length - prefix.length);
}

describe("启动票据契约族(分发改版 WP-90;D-LT-1 ~ D-LT-3)", () => {
  it("版本面:独立契约族版本常量为 1 且受理集合恒含当前版本(5.6 每类契约独立版本号)", () => {
    expect(LAUNCH_TICKET_PROTOCOL_VERSION).toBe(1);
    expect(SUPPORTED_LAUNCH_TICKET_PROTOCOL_VERSIONS).toEqual([
      LAUNCH_TICKET_PROTOCOL_VERSION,
    ]);
    expect(LAUNCH_TICKET_SCHEMA_BASE_ID).toBe(
      "https://stackmaster.dev/schemas/launch-ticket/v1",
    );
  });

  it("请求键集锁定:恰两键 challengeId / version(租户无表达位)", () => {
    expect(Object.keys(LaunchTicketRequestSchema.shape).sort()).toEqual([
      "challengeId",
      "version",
    ]);
  });

  it("响应键集锁定:恰两键 launchUrl / expiresAt(无第二票据承载位)", () => {
    expect(Object.keys(LaunchTicketResponseSchema.shape).sort()).toEqual([
      "expiresAt",
      "launchUrl",
    ]);
  });

  it("题目内容版本格式复用单一来源(CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE,不复制第二份字面量)", () => {
    expect(CHALLENGE_CONTENT_VERSION_PATTERN_SOURCE).toBe("^[0-9]+\\.[0-9]+\\.[0-9]+$");
    // 从包入口可达(启动票据请求与宿主成绩同步共用它)——它只是格式常量,
    // 不是凭证解析器,故不受 server-only 导出面纪律约束。
    expect(
      LaunchTicketRequestSchema.safeParse({ challengeId: "chal-a", version: "10.20.30" })
        .success,
    ).toBe(true);
    for (const illegal of ["1.2", "v1.2.3", "1.2.3-rc1", "1.2.3.4", ""]) {
      expect(
        LaunchTicketRequestSchema.safeParse({ challengeId: "chal-a", version: illegal })
          .success,
      ).toBe(false);
    }
  });

  it.each([
    ["tenantId", "tenant-alpha"],
    ["userId", "user-01"],
    ["protocolVersion", 1],
    ["sessionId", "sess-01J9KD5EXAMPLE003"],
    ["embedToken", "opaque-token"],
  ])("请求携带未冻结字段 %s 即拒绝(strictObject:身份 / 版本回显零表达位)", (field, value) => {
    expect(
      LaunchTicketRequestSchema.safeParse({
        challengeId: "chal-stack-escape",
        version: "1.2.3",
        [field]: value,
      }).success,
    ).toBe(false);
  });

  it.each(loadFixtures("launch-ticket-request", "valid"))(
    "接受合法请求样例 $name",
    ({ payload }) => {
      expect(LaunchTicketRequestSchema.safeParse(payload).success).toBe(true);
    },
  );

  it.each(loadFixtures("launch-ticket-request", "invalid"))(
    "拒绝非法请求样例 $name",
    ({ payload }) => {
      expect(LaunchTicketRequestSchema.safeParse(payload).success).toBe(false);
    },
  );

  it.each(loadFixtures("launch-ticket-response", "valid"))(
    "接受合法响应样例 $name",
    ({ payload }) => {
      expect(LaunchTicketResponseSchema.safeParse(payload).success).toBe(true);
    },
  );

  it.each(loadFixtures("launch-ticket-response", "invalid"))(
    "拒绝非法响应样例 $name",
    ({ payload }) => {
      expect(LaunchTicketResponseSchema.safeParse(payload).success).toBe(false);
    },
  );

  it("长地址样例逼近上限但仍在界内(fixture 读数与上限常量一致)", () => {
    const long = loadFixtures("launch-ticket-response", "valid").find((item) =>
      item.name.includes("long-url"),
    );
    const launchUrl = (long?.payload as { launchUrl: string }).launchUrl;
    expect(launchUrl.length).toBeGreaterThan(1800);
    expect(launchUrl.length).toBeLessThanOrEqual(LAUNCH_URL_MAX_LENGTH);
  });
});

describe("字段形态与生命周期常量(D-LT-2)", () => {
  it("launchUrl 长度上限:界内 2048 收、超界 2049 拒(边界含端点)", () => {
    const atCap = launchUrlOfLength(LAUNCH_URL_MAX_LENGTH);
    expect(atCap.length).toBe(LAUNCH_URL_MAX_LENGTH);
    expect(
      LaunchTicketResponseSchema.safeParse({ ...ISSUED, launchUrl: atCap }).success,
    ).toBe(true);
    const overCap = launchUrlOfLength(LAUNCH_URL_MAX_LENGTH + 1);
    expect(
      LaunchTicketResponseSchema.safeParse({ ...ISSUED, launchUrl: overCap }).success,
    ).toBe(false);
  });

  it.each([
    ["相对地址", "/app/c/chal-stack-escape/1.2.3?t=8Kd2mQ4xR7vT1pLzB6nYcW"],
    ["无 scheme 伪地址", "javascript:alert(1)"],
    ["含空白", "https://lab.example.edu/a b"],
  ])("launchUrl 形态违规即拒(%s)", (_label, launchUrl) => {
    expect(
      LaunchTicketResponseSchema.safeParse({ ...ISSUED, launchUrl }).success,
    ).toBe(false);
  });

  it("expiresAt 为 Unix epoch 秒整数且非负", () => {
    expect(LaunchTicketResponseSchema.parse({ ...ISSUED, expiresAt: 0 }).expiresAt).toBe(0);
    for (const illegal of [1789200300.5, -1, "1789200300", null]) {
      expect(
        LaunchTicketResponseSchema.safeParse({ ...ISSUED, expiresAt: illegal }).success,
      ).toBe(false);
    }
  });

  it("有效期护栏:缺省 ≤ 上限,且两者与 D-LT-2 裁定值逐字一致", () => {
    expect(DEFAULT_LAUNCH_TICKET_TTL_SECONDS).toBe(300);
    expect(MAX_LAUNCH_TICKET_TTL_SECONDS).toBe(3600);
    expect(DEFAULT_LAUNCH_TICKET_TTL_SECONDS).toBeLessThanOrEqual(
      MAX_LAUNCH_TICKET_TTL_SECONDS,
    );
  });

  it("票据令牌长度 = 22(base64url 22 × 6 = 132 bit ≥ 128 bit 的最小整数长度)", () => {
    expect(LAUNCH_TICKET_TOKEN_LENGTH).toBe(22);
    expect(LAUNCH_TICKET_TOKEN_LENGTH * 6).toBeGreaterThanOrEqual(128);
    expect((LAUNCH_TICKET_TOKEN_LENGTH - 1) * 6).toBeLessThan(128);
  });

  it("形态常量单源:签发路由 / 换票路径模板 / 查询参数名(D-LT-2 裁定值)", () => {
    expect(LAUNCH_TICKET_ISSUANCE_ROUTE).toBe("/auth/launch-tickets");
    expect(LAUNCH_TICKET_REDEEM_PATH_TEMPLATE).toBe("/app/c/:challengeId/:version");
    expect(LAUNCH_TICKET_QUERY_PARAM).toBe("t");
    // 换票路径模板必须与请求体的两个导航字段同名同义(占位符 ↔ 契约键对齐)。
    for (const field of Object.keys(LaunchTicketRequestSchema.shape)) {
      expect(LAUNCH_TICKET_REDEEM_PATH_TEMPLATE).toContain(`:${field}`);
    }
  });
});

describe("schema 产物(独立 $id 命名空间 + 落盘面)", () => {
  it.each([
    ["launch-ticket-request", "LaunchTicketRequest"],
    ["launch-ticket-response", "LaunchTicketResponse"],
  ])("%s 产物存在、$id 前缀正确、自包含且严格闭合", (family, title) => {
    const document = readSchemaDocument(family);
    expect(document["$id"]).toBe(
      `${LAUNCH_TICKET_SCHEMA_BASE_ID}/${family}.schema.json`,
    );
    expect(document["title"]).toBe(title);
    expect(document["x-sm-class"]).toBe("boundary");
    expect(document["additionalProperties"]).toBe(false);
    expect(JSON.stringify(document)).not.toContain("$ref");
    expect(document["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
  });
});

describe("CRITICAL:私有面 / 身份面字段在契约层结构性不可表达", () => {
  const FORBIDDEN_FIELDS = [
    "tenantId",
    "userId",
    "jti",
    "sessionId",
    "ticket",
    "ticketValue",
    "protocolVersion",
    "flag",
    "hiddenFlag",
  ] as const;

  it("响应形状既非输入键、也非深挖可推导:落盘产物全树属性名恰为两键", () => {
    const document = readSchemaDocument("launch-ticket-response");
    expect([...collectPropertyNames(document)].sort()).toEqual([
      "expiresAt",
      "launchUrl",
    ]);
  });

  it("请求形状既非输入键、也非深挖可推导:落盘产物全树属性名恰为两键", () => {
    const document = readSchemaDocument("launch-ticket-request");
    expect([...collectPropertyNames(document)].sort()).toEqual([
      "challengeId",
      "version",
    ]);
  });

  it.each(FORBIDDEN_FIELDS)(
    "响应携带 %s 即拒(租户 / 身份 / 票据明文 / 隐藏 flag 零表达位)",
    (field) => {
      expect(
        LaunchTicketResponseSchema.safeParse({ ...ISSUED, [field]: "x" }).success,
      ).toBe(false);
      expect(Object.keys(LaunchTicketResponseSchema.shape)).not.toContain(field);
      expect([...collectPropertyNames(readSchemaDocument("launch-ticket-response"))]).not.toContain(
        field,
      );
    },
  );

  it.each(FORBIDDEN_FIELDS)(
    "请求携带 %s 即拒(strictObject;自报身份 / 票据 / 版本回显零表达位)",
    (field) => {
      expect(
        LaunchTicketRequestSchema.safeParse({
          challengeId: "chal-stack-escape",
          version: "1.2.3",
          [field]: "x",
        }).success,
      ).toBe(false);
      expect([...collectPropertyNames(readSchemaDocument("launch-ticket-request"))]).not.toContain(
        field,
      );
    },
  );

  it("签发响应不携带票据本身:票据值只在 launchUrl 内(唯一承载位)", () => {
    const parsed = LaunchTicketResponseSchema.parse(ISSUED);
    const ticket = "8Kd2mQ4xR7vT1pLzB6nYcW";
    expect(parsed.launchUrl).toContain(`${LAUNCH_TICKET_QUERY_PARAM}=${ticket}`);
    const hits = JSON.stringify(parsed).split(ticket).length - 1;
    expect(hits).toBe(1);
  });
});

/**
 * 页面应用静态托管(分发改版 WP-92;与 API **同源**的分发形态 §五 第 ① 项)。
 *
 * ## 为什么需要它
 *
 * 分发形态定案 = 「与 session-api **同源**」:页面由 session-api(或同域反代)
 * 提供,同域两路径如 `/app` 与 `/sessions`。同源正是 `create_session` 能靠
 * **启动授权凭证 Cookie**(`SameSite=Strict`)工作的前提,也是「
 * `SESSION_API_ALLOWED_ORIGINS` **不需要**为 page-app 放宽」的原因 —— 没有
 * 跨源,自然不需要白名单。
 *
 * 装配位置 = `SESSION_API_PAGE_APP_DIR`(指向 `apps/page-app/dist`)。
 * **未配置 ⇒ 不注册本路由**(该部署不提供页面),但**换票路由照常工作**:
 * 换票是**服务端语义**(票据消费 + 授权凭证签发),与"谁来托管页面"解耦 ——
 * 运维完全可以用同域反代把 `/app` 指到别的静态服务器,而不是让 session-api
 * 自己发文件。这条解耦是刻意的。
 *
 * ## 路由优先级(本模块最容易踩坏的地方)
 *
 * `GET /app/c/:challengeId/:version`(换票,**动态段**)与静态托管的
 * `/app/**`(通配段)**共享同一个前缀**。二者谁赢,决定了「打开启动地址」
 * 是换票还是拿到一个 404 页面。保证手段有两条,本实现**两条都用**:
 *
 *  1. **注册序**:本插件由 `server.ts` 在 `launchRoutes` **之后**注册。
 *     find-my-way 的路由树里,静态段(如 `/app/c/<literal>/<literal>`)与
 *     参数段分列不同节点,匹配优先级本就不靠注册序;但把序写死能让
 *     「换票先于静态」成为**装配层面的显式事实**,而不是"碰巧靠路由器算法"。
 *  2. **`wildcard: false`**:静态托管**不注册通配路由** `GET /app/*`,而是为
 *     `dist/` 里**真实存在的每个文件**注册一条精确路由。于是:
 *       · 结构上不存在一个能吞掉 `/app/c/...` 的通配处理器;
 *       · 未知路径(`/app/c/x/1.0.0/` 这类)落到框架 404(冻结 PublicError
 *         形态),不会误命中页面文件。
 *
 * 优先级由 `apps/session-api/test/launch/static-hosting.test.ts` 的集成用例
 * 锁定(换票路由仍生效 + 静态文件可取 + 未配置即不注册)。
 *
 * ## 响应头纪律(D-LT-3 ①)
 *
 * 页面响应与换票响应同族:**`Cache-Control: no-store` + `Referrer-Policy:
 * no-referrer`**。后者尤其针对"页面被从别处链接过来"的 Referer 外泄面;
 * 前者防止学习者拿到陈旧页面(启动地址是一次性的,页面本身却必须每次拉新,
 * 否则学习者会看到上一个会话的渲染残影)。
 * 例外:`/app/assets/**` 是指纹命名的静态资源,可以长缓存(内容寻址,改名即
 * 失效)—— 但仍带 `Referrer-Policy: no-referrer`。
 */
import fastifyStatic from "@fastify/static";
import type { FastifyPluginAsync, FastifyReply } from "fastify";

/** 页面应用的静态挂载前缀(与 `packages/protocol` 的换票路径模板同域)。 */
export const PAGE_APP_URL_PREFIX = "/app";

/** HTML 入口文件名(`index` 由 @fastify/static 自动承担目录索引)。 */
const PAGE_APP_INDEX_FILE = "index.html";

/** 指纹资源子目录(vite 缺省 `assets/`);只有它允许长缓存。 */
const HASHED_ASSET_SEGMENT = "assets/";

/** 长缓存窗口(秒;一年)。仅用于指纹命名资源。 */
const HASHED_ASSET_MAX_AGE_SECONDS = 31_536_000;

export interface PageAppShellDeps {
  /**
   * 页面应用构建产物目录(`apps/page-app/dist`)。
   *
   * **由装配侧(运行时)解析为绝对路径**:配置层只登记声明值(配置纪律:
   * 配置不承担路径解析),本插件也不做 `process.cwd()` 相对解析 ——
   * 相对路径会让"服务从哪个目录启动"悄悄改变托管内容。
   */
  readonly distDir: string;
}

/** 页面响应头(见文件头「响应头纪律」)。 */
function applyPageHeaders(reply: FastifyReply, filePath: string): void {
  const normalized = filePath.split("\\").join("/");
  const isHashedAsset = normalized.includes(`/${HASHED_ASSET_SEGMENT}`);
  if (isHashedAsset) {
    reply.header("Cache-Control", `public, max-age=${HASHED_ASSET_MAX_AGE_SECONDS}, immutable`);
  } else {
    reply.header("Cache-Control", "no-store");
  }
  reply.header("Referrer-Policy", "no-referrer");
}

/**
 * 构建页面托管插件。
 *
 * 前置契约:**调用方必须已注册换票路由**(见文件头「路由优先级」)。本函数
 * 不做也无法做这项校验(插件之间互不可见),故把它写进文档与装配注释,并由
 * 集成测试锁定结果。
 */
export function buildPageAppShell(deps: PageAppShellDeps): FastifyPluginAsync {
  return async function pageAppShell(fastify): Promise<void> {
    await fastify.register(fastifyStatic, {
      root: deps.distDir,
      prefix: PAGE_APP_URL_PREFIX,
      // 见文件头「路由优先级」第 2 条:不通配 ⇒ 结构上吞不掉换票路由。
      wildcard: false,
      // 目录索引:`/app/` 命中 dist/index.html(@fastify/static 的 index 缺省)。
      index: [PAGE_APP_INDEX_FILE],
      // `/app`(无尾斜杠)301 到 `/app/`(同文件,避免"目录无索引页"歧义)。
      redirect: true,
      setHeaders: (reply, filePath) => {
        applyPageHeaders(reply, filePath);
      },
    });
  };
}

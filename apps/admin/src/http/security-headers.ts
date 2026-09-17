/**
 * 管理面 HTTP 安全头(D-MP-5 分支 A;`docs/项目计划书.md:715` / `:807`)。
 *
 * ── CSP `frame-ancestors` 与插件链路**分离**(8.4)──────────────────────
 * 插件链路(信任域 1)的 CSP 由插件站点 / 宿主平台配置,`frame-ancestors`
 * 指**宿主来源白名单**——插件被设计为被嵌入。管理面(信任域 4)与之相反:
 * `frame-ancestors 'none'`,**永不被任何来源嵌入**,也永不承载嵌入协议;
 * 两条链路的来源集合零交集(管理面不入插件链路,插件页不持有管理面凭证,
 * `:715` 明文「公开 iframe 不应与管理后台共享高权限 Cookie 或管理端 API」)。
 * 同理 `default-src 'none'` + 逐项最小放行:管理面页面的自有资产只有
 * 同源三份(HTML / CSS / JS),`connect-src 'self'` 只够发自己的只读 API。
 *
 * 本模块是这些头的**唯一来源**(测试断言与运行时响应共用同一常量,
 * 杜绝"文档写一套、响应发另一套")。
 */

/**
 * 管理面 CSP。
 *
 * - `default-src 'none'`:默认全关(fail-closed 的 CSP 形态);
 * - `script-src 'self'` / `style-src 'self'`:零内联脚本、零内联样式
 *   (页面源里没有 `<script>` / `<style>` 内联块,测试机检);
 * - `connect-src 'self'`:只允许同源只读 API;
 * - `frame-ancestors 'none'`:管理面永不被嵌入(与插件链路分离);
 * - `form-action 'none'` / `base-uri 'none'` / `object-src 'none'`:
 *   无表单外发、无 `<base>` 劫持、无插件对象面。
 */
export const ADMIN_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "font-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

/** 管理面统一安全头(全部响应,含 API 与静态资产)。 */
export function adminSecurityHeaders(): Readonly<Record<string, string>> {
  return {
    "content-security-policy": ADMIN_CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    // 运营数据不得进入任何中间缓存(凭证绑定租户的作用域数据)。
    "cache-control": "no-store",
  };
}

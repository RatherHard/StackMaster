/**
 * 管理面最小只读页(静态资产;D-MP-5 分支 A;D-API-136)。
 *
 * 形态纪律:
 *  - **不进 vm-ui 交付面**:管理面是运营面,不是插件交付面。把它混进
 *    `packages/vm-ui` / `web-component` 会让运营代码进入插件包(体积、
 *    交付面、审查面三重污染)。因此这里是零依赖的三份静态资产
 *    (HTML / CSS / JS 各一份),由 admin 自己的 HTTP 面在同源下提供。
 *  - **零视觉重设计**:语义化 DOM(`main` / `h1` / `form` / `label` /
 *    `table` + `caption` / `aria-live` 状态区),无框架、无图标字体、
 *    无动画;样式表只有可读性最低限度(等宽字体、边框、间距)。
 *  - **凭证零持久化**(`docs/项目计划书.md:807`「不得使用长期 URL 参数」):
 *    凭证只存在于页面内存变量,呈递走 `Authorization` 请求头;
 *    不写 Cookie(无 CSRF 面)、不写 URL、不写 localStorage / sessionStorage。
 *  - **无障碍基线**:每个输入有 `<label for>`;状态区 `aria-live="polite"`
 *    `role="status"`;表格有 `<caption>`;按钮为原生 `<button>`;颜色对比走
 *    文本色与背景色默认值(零硬编码低对比色)。若后续新增交互,守 axe 基线。
 *  - **CSP 分离**:本应用的 CSP 由 `security-headers.ts` 统一注入,
 *    `frame-ancestors 'none'`(= 管理面永不被任何来源嵌入),与插件链路
 *    (宿主来源白名单的 iframe 嵌入)彻底分离(`docs/项目计划书.md:715`)。
 */

/** 只读页 HTML(零内联脚本 / 零内联样式:CSP 无需 'unsafe-inline')。 */
export const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>StackMaster 管理面(只读)</title>
    <link rel="stylesheet" href="/admin.css" />
    <script src="/admin.js" defer></script>
  </head>
  <body>
    <main>
      <h1>StackMaster 管理面(只读)</h1>
      <p>
        本页只读:三个查询面(题目登记列表 / 裁决查询 / 成绩导出)全部为 GET,
        无任何写入入口。凭证只保存在本页内存,呈递走请求头,不入 Cookie 与 URL。
      </p>
      <form id="admin-form">
        <p>
          <label for="admin-token">管理面凭证</label>
          <input id="admin-token" name="admin-token" type="password" autocomplete="off" required />
        </p>
        <p>
          <label for="admin-tenant">租户(可选;多租户绑定时必填,仅可在绑定集合内)</label>
          <input id="admin-tenant" name="admin-tenant" type="text" autocomplete="off" />
        </p>
        <p>
          <button type="button" id="query-challenges">题目登记列表</button>
          <button type="button" id="query-verdicts">裁决查询</button>
          <button type="button" id="query-scores">成绩导出</button>
        </p>
      </form>
      <p id="admin-status" role="status" aria-live="polite">未查询。</p>
      <table id="admin-result">
        <caption id="admin-caption">查询结果</caption>
        <thead>
          <tr id="admin-head"></tr>
        </thead>
        <tbody id="admin-body"></tbody>
      </table>
    </main>
  </body>
</html>
`;

/** 只读页样式(最低限度可读性;零视觉重设计)。 */
export const CONSOLE_CSS = `:root { color-scheme: light dark; }
body { margin: 0; padding: 1.5rem; font-family: system-ui, sans-serif; line-height: 1.5; }
main { max-width: 72rem; margin: 0 auto; }
h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
form p { margin: 0.5rem 0; }
label { display: inline-block; min-width: 12rem; }
input { font: inherit; padding: 0.25rem 0.4rem; }
button { font: inherit; padding: 0.3rem 0.8rem; margin-right: 0.5rem; }
table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
caption { text-align: left; padding-bottom: 0.4rem; }
th, td { border: 1px solid currentColor; padding: 0.25rem 0.5rem; text-align: left; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`;

/**
 * 只读页脚本(同源外链;CSP 无需放宽 script-src)。
 * 凭证只在闭包变量里;每次请求都直接呈递,不做任何持久化。
 */
export const CONSOLE_JS = `(function () {
  "use strict";
  var credential = "";
  var status = document.getElementById("admin-status");
  var caption = document.getElementById("admin-caption");
  var head = document.getElementById("admin-head");
  var body = document.getElementById("admin-body");
  var tokenInput = document.getElementById("admin-token");
  var tenantInput = document.getElementById("admin-tenant");

  function say(message) {
    if (status) { status.textContent = message; }
  }

  function render(title, rows) {
    if (caption) { caption.textContent = title; }
    if (head) { head.textContent = ""; }
    if (body) { body.textContent = ""; }
    if (rows.length === 0) {
      say(title + ":0 行。");
      return;
    }
    var columns = Object.keys(rows[0]);
    for (var i = 0; i < columns.length; i += 1) {
      var th = document.createElement("th");
      th.scope = "col";
      th.textContent = columns[i];
      if (head) { head.appendChild(th); }
    }
    for (var r = 0; r < rows.length; r += 1) {
      var tr = document.createElement("tr");
      for (var c = 0; c < columns.length; c += 1) {
        var td = document.createElement("td");
        var value = rows[r][columns[c]];
        td.textContent = value === null || value === undefined ? "" : String(value);
        tr.appendChild(td);
      }
      if (body) { body.appendChild(tr); }
    }
    say(title + ":" + rows.length + " 行。");
  }

  function request(path, onRows) {
    credential = tokenInput ? tokenInput.value : "";
    var tenant = tenantInput ? tenantInput.value.trim() : "";
    var url = path + (tenant === "" ? "" : "?tenant=" + encodeURIComponent(tenant));
    var headers = { Authorization: "Bearer " + credential };
    say("查询中…");
    fetch(url, { method: "GET", headers: headers, credentials: "omit", cache: "no-store" })
      .then(function (response) {
        return response.json().then(function (payload) {
          if (!response.ok) {
            say("查询被拒:HTTP " + response.status + " " + (payload && payload.code ? payload.code : ""));
            render("查询被拒", []);
            return;
          }
          onRows(payload);
        });
      })
      .catch(function () {
        say("网络错误:查询未完成。");
      });
  }

  function bind(id, path, onRows) {
    var button = document.getElementById(id);
    if (button) {
      button.addEventListener("click", function () { request(path, onRows); });
    }
  }

  bind("query-challenges", "/admin/challenges", function (payload) {
    render("题目登记列表", payload.items || []);
  });
  bind("query-verdicts", "/admin/verdicts", function (payload) {
    render("裁决查询", payload.items || []);
  });
  bind("query-scores", "/admin/scores", function (payload) {
    render("成绩导出(nextCursor=" + String(payload.nextCursor) + ")", payload.items || []);
  });
})();
`;

# SessionRegistry 按服务（origin）细分设计

> 2026-08-20。登录状态列表在 domain 组内按服务（origin，含端口）细分展示，子项可点击跳转完整 URL。

## 1. 问题

Cookie 的 domain 不含端口：`localhost:8080` 与 `localhost:9090` 两个独立账号体系的登录态落在同一 host 域下，列表合并为一条 `localhost`，看不出有几个服务、跳转只能猜端口、删除无法只删其一（浏览器无按端口删 cookie 的 API，物理限制）。

## 2. 关键发现：CDP sourcePort

CDP `Network.getCookies`（无参调用返回全部 cookies）在每个 cookie 上暴露浏览器原生记录的来源：

- `sourcePort`：下发该 cookie 的服务端口。JS 写 `document.cookie` 的，继承当前页面的端口（实验验证：网络下发与 JS 写入均带 sourcePort）。
- `sourceScheme`：`Secure` → https，`NonSecure` → http。

来源信息随 cookie 持久化——重启后仍在，无需自己记录导航历史或抓 Set-Cookie 响应头（零持久化、100% 覆盖）。

## 3. origin 构造

对每个 cookie：

```
host   = cookie.domain（去掉前导点）
scheme = cookie.sourceScheme === 'Secure' ? 'https' : 'http'
port   = (scheme==='https' && sourcePort!==443) || (scheme==='http' && sourcePort!==80)
         ? ':' + sourcePort : ''
origin = scheme + '://' + host + port
```

sourcePort 缺失（异常兜底）→ 端口省略，origin 仍可构造。

## 4. 分组结构（两级）

**第一级 cookie 语义分组完全不动**（现有 `_groupCookies`：domain cookie 建组、host-only 最长后缀归并、裸域折叠）。

**第二级**在组内按 cookie 的归属 origin 聚合，`list()` 返回：

```javascript
[
  { domain: 'baidu.com', cookieCount: 12,
    origins: [
      { url: 'https://www.baidu.com', cookieCount: 10 },
      { url: 'https://map.baidu.com', cookieCount: 2 }
    ] },
  { domain: 'localhost', cookieCount: 4,
    origins: [
      { url: 'http://localhost:8080', cookieCount: 3 },
      { url: 'http://localhost:9090', cookieCount: 1 }
    ] }
]
```

- `origins` 按 cookieCount 降序。
- `subDomains` 字段删除——origin URL 是其信息超集（`https://www.baidu.com` 含子域名）。
- `delete()` 不动：仍整组按 rawDomains 精确清除（cookie 无端口，物理上删不到单 origin）。

## 5. UI

条目下逐行列出 origins，每行可点击跳转完整 URL：

```
localhost · 4 cookies                       [验证] [删除]
  http://localhost:8080 · 3 cookies
  http://localhost:9090 · 1 cookie
```

- `renderSessions()` 将现有"含子域: ..."一行替换为 origins 列表行。
- `visitDomain(domain)` 替换为 `visitOrigin(url)`：直接用完整 URL 导航。原"https:// 拼接 + 管理页主机特判"逻辑删除（不再需要）。
- 删除 confirm 提示补"（含该域名下所有服务）"。

## 6. CDP 会话来源

`Network.getCookies` 是 browser 级 cookie 存储查询，与发起页面无关。`SessionRegistry` 构造参数从 `{ context }` 改为 `{ browserSession }`，内部取 `browserSession._pages` 中任意一页的 cdp 发送命令；无页面时返回空列表。getter（`src/index.js`）相应改为传 `browserSession`。

删除仍用 Playwright `context.clearCookies({ domain: raw })`（CDP 无按 domain 批量删除的等价便利命令），故 registry 同时持有 `browserSession._context` 供 delete 使用。

## 7. 影响范围

| 文件 | 变更 |
|------|------|
| `src/session/SessionRegistry.js` | 构造参数改 `browserSession`；`list()` 改用 CDP `Network.getCookies` + origin 聚合；`delete()` 数据源同步换 CDP（分组逻辑不变） |
| `src/index.js` | getter 传 `browserSession` |
| `src/public/client.html` | `renderSessions()` 显示 origins；`visitDomain` → `visitOrigin` |
| `test/session/SessionRegistry.test.js` | mock 从 `context.cookies()` 换 CDP 返回结构；新增 origin 聚合断言 |
| `test/routes/api/sessions.test.js` | 适配构造参数 |

## 8. 测试

| 测试 | 断言 |
|------|------|
| 同域不同 sourcePort | 组内分成两个 origin 子项，端口正确 |
| 默认端口省略 | https+443 / http+80 不显示端口 |
| Secure → https | sourceScheme 映射正确 |
| 现有分组用例 | domain 建组/归并/折叠行为不变（数据源换成 CDP 结构后仍通过） |
| 现有删除用例 | 整组删除、不误删 lookalike、no-op 不变 |

## 9. 不做（YAGNI）

- 按单个 origin 删除（cookie 物理删不到，浏览器无此 API）
- localStorage/IndexedDB 管理（范围外）
- Set-Cookie 抓包监听 / 导航历史记录（sourcePort 已完整覆盖来源信息）

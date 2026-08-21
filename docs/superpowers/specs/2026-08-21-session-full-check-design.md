# SessionRegistry full 验证策略设计

> 2026-08-21。后台 tab 真实访问检测登录态有效性,替代只看 cookie 存在性的 quick 策略;UI 内联状态徽章。

## 1. 背景与目标

Phase 2 的 `check('quick')` 仅检查 cookie 存在性——过期 cookie 也报 valid,无法回答"登录态是否有效"。本设计实现 full 策略:后台隐藏页访问目标站点,用重定向与密码框双信号判定。同时把验证结果落到列表内联徽章(原 Phase 2 设计图承诺的「状态: ✓ 已登录 · 最后验证: 2小时前」)。

| 验收标准 | 验证方法 |
|------|------|
| full 验证返回三态结果 | 已登录站点报 valid;未登录站点报 invalid;超时报 unknown |
| 验证页不可见 | 用户的 tab 列表、screencast、活动 tab 全程不受影响 |
| 结果内联展示 | 列表条目显示状态徽章 + 相对时间,刷新列表后仍在 |
| 防滥用 | 同 domain 10s 内重复验证返回缓存结果;并发请求去重 |

## 2. 三层结构

| 层 | 模块 | 职责 |
|------|------|------|
| 隐藏页通道 | `BrowserSession` | 提供 `openHiddenPage()`/`closeHiddenPage()`,不掺验证逻辑 |
| full 策略 | `SessionRegistry.check()` | 消费隐藏页,采集信号,判定三态,限频去重,存结果 |
| 呈现 | `client.html` | 内联徽章 + loading 态 |

## 3. BrowserSession 隐藏页通道

### 3.1 状态与 API

```js
this._hiddenPages = new Set();   // Page 对象,不进 _pages
this._pendingHidden = false;     // 竞态标记(见 3.2)

async openHiddenPage() { ... }   // 返回 Playwright Page
async closeHiddenPage(page) { ... }
```

### 3.2 竞态处理

`context.newPage()` 的 `context.on('page')` 事件可能在 Promise 返回前同步触发。顺序必须是:

```js
async openHiddenPage() {
  this._pendingHidden = true;
  try {
    const page = await this._context.newPage();
    this._hiddenPages.add(page);
    page.on('close', () => this._hiddenPages.delete(page));
    return page;
  } finally {
    this._pendingHidden = false;
  }
}
```

事件处理器开头过滤:

```js
this._context.on("page", (page) => {
  if (this._pendingHidden || this._hiddenPages.has(page)) return;
  this._registerPage(page).then(...)
});
```

### 3.3 隐藏页特性

- 不进 `_pages`:tab 列表看不到,不触发 `tabsChange`
- 不被 freeze:`_freezePage` 只作用于 `_pages` 内的页(验证页需要加载和执行 JS)
- 不影响 screencast:`startScreencast` 只看 activePageId
- `stop()` 时遍历 `_hiddenPages` 显式 close 兜底(随后 context.close() 会清理全部)

## 4. SessionRegistry full 策略

### 4.1 新增状态

```js
this._checkResults = new Map();   // domain → result
this._checkInFlight = new Map();  // domain → Promise(并发去重)
this._lastCheckAt = new Map();    // domain → timestamp(限频)
```

### 4.2 check(domain, 'full') 流程

```
限频检查(10s,命中 → 返回上次结果 + note:'rate-limited')
  → 已有 in-flight? 复用 Promise
  → 否则:
  1. 选检测 URL:组内 cookieCount 最大的 origin.url;无 origins 兜底 https://{domain}
  2. openHiddenPage()
  3. page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
  4. SPA 稳定等待:最多 5s,每 500ms 检查 URL 是否仍在变
  5. 采集信号:
     - redirectedToLogin = /login|signin|sign-in|auth|passport/i.test(finalUrl)
     - hasPasswordInput  = page.$('input[type=password]') !== null
  6. 判定:任一命中 → invalid;都没命中 → valid;超时/报错/崩溃 → unknown
  7. finally: closeHiddenPage(page)
  8. 存 _checkResults,返回
```

### 4.3 结果结构

```js
{ valid: boolean | null,   // null = unknown
  strategy: 'full' | 'quick',
  checkedAt: 1724280000000,
  finalUrl: 'https://github.com/login',   // full 才有
  signals: { redirectedToLogin, hasPasswordInput },  // full 才有
  note?: 'rate-limited' | 'browser-not-running' | 'timeout' }
```

### 4.4 边界

- 浏览器未运行(`_context` null)→ `{ valid: null, note: 'browser-not-running' }`;启动浏览器由 route 层 `ensureBrowserStarted()` 负责(对齐 `GET /` 现有模式),registry 不掺启动逻辑
- quick 策略逻辑不动,但结果同样写 `_checkResults`(内联徽章对两种策略生效)
- 限频命中返回 HTTP 200(有答案,不是错误)

### 4.5 list() 联动

每个 domain 条目增加 `lastCheck` 字段(从 `_checkResults` 取,无则无此字段):

```js
{ domain: 'github.com', cookieCount: 12, origins: [...],
  lastCheck: { valid: true, strategy: 'full', checkedAt: 1724280000000 } }
```

## 5. API 变更

`src/routes/api/sessions.js`:

- `POST /:domain/check` 的 `strategy` 默认值 `'quick'` → `'full'`
- 浏览器未运行时先 `ensureBrowserStarted()` 再取 registry(对齐 `GET /` 行为)
- 响应即 `check()` 返回值

## 6. UI 变更

### 6.1 状态徽章

条目域名下新增状态行:

```
github.com                        [详情] [验证] [删除]
  ✓ 已登录 · full · 2小时前
  https://github.com · 10 cookies
```

- 三态:`✓ 已登录`(绿)/ `✗ 已失效`(红)/ `? 未知`(灰),`valid: null` → 未知
- 相对时间:刚刚 / N分钟前 / N小时前 / N天前
- 无 `lastCheck` 不显示状态行

### 6.2 验证按钮

- loading 态:验证期间禁用、文字「验证中…」(full 最长 ~20s,无反馈会被当卡死)
- `checkDomain()` 不再传 strategy(默认 full)
- 结果落内联徽章,移除成功 alert;网络错/503 保留 alert
- `note: 'rate-limited'` 正常更新徽章,不额外提示

## 7. 影响范围

| 文件 | 变更 |
|------|------|
| `src/browser/BrowserSession.js` | `_hiddenPages`/`_pendingHidden` 状态、`openHiddenPage()`/`closeHiddenPage()`、事件过滤器、`stop()` 兜底清理 |
| `src/session/SessionRegistry.js` | 三个 Map、full 策略实现、quick 写结果、`list()` 加 `lastCheck` |
| `src/routes/api/sessions.js` | check 默认 full、未运行时 `ensureBrowserStarted()` |
| `src/public/client.html` | 状态徽章、相对时间、按钮 loading 态、alert 调整 |

## 8. 测试

| 测试 | 断言 |
|------|------|
| 隐藏页不进 tab 列表 | `openHiddenPage()` 后 `getTabsState().pages` 不变、`tabsChange` 不触发 |
| 隐藏页不被 freeze | 不调用 `Emulation.setScriptExecutionDisabled`(对隐藏页) |
| 竞态 | `openHiddenPage()` 期间 `context.on('page')` 不注册该页 |
| full 判定 invalid | 最终 URL 含 login 关键词 / 存在密码框 |
| full 判定 valid | 无信号命中 |
| full 判定 unknown | goto 超时;`valid` 为 null,`note: 'timeout'` |
| 检测 URL 选择 | 有 origins 取最大 origin;无 origins 兜底 https://{domain} |
| 限频 | 10s 内二次调用返回上次结果 + `note: 'rate-limited'` |
| 并发去重 | 同 domain 并发两次只开一个隐藏页(in-flight 复用) |
| quick 写结果 | `check(domain, 'quick')` 后 `list()` 条目含 `lastCheck` |
| API 默认策略 | POST check 不带 body → strategy full |
| 页面用完即关 | 验证结束(含异常)`_hiddenPages` 为空 |

## 9. 不做(YAGNI)

- custom 策略(`session-rules.json` 规则体系)——留待后续,full 的信号采集是它的基座
- 验证结果持久化到磁盘——结果有时效性,Node 内存足够
- 全局验证队列/批量"全部验证"——风控风险,单 domain 粒度足够
- HTTP 401/403 状态码信号——需开 Network 域监听,双信号已覆盖主流场景
- localStorage/IndexedDB 管理(per-origin 设计已明确排除)

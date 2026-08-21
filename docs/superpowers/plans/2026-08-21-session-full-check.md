# SessionRegistry full 验证策略 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 后台隐藏页真实访问目标站点,用重定向+密码框双信号判定登录态三态(valid/invalid/unknown),结果内联展示在登录状态列表。

**Architecture:** 三层——`BrowserSession` 提供 `openHiddenPage()`/`closeHiddenPage()` 隐藏页通道(不进 tab 列表、不被 freeze、不抢 screencast);`SessionRegistry.check()` 实现 full 策略(选 URL、导航、采信号、判三态、限频去重、存内存);`client.html` 渲染状态徽章 + loading 态。

**Tech Stack:** Node ESM、Playwright(CDP + Page API)、Hono、`node:test`。

**Spec:** `docs/superpowers/specs/2026-08-21-session-full-check-design.md`

## Global Constraints

- ESM,import 带 `.js` 扩展名,无构建步骤
- 运行时依赖仅 4 个:`playwright`、`ws`、`hono`、`@hono/node-server`,不得新增
- 日志只记关键控制点,格式 `[Module] message`,无 debug 日志
- 测试用 `node --test`(单独跑:`node --test test/xxx.test.js`);改动 `process.env` 的测试必须 `finally` 清理
- 常量:goto 超时 `15_000`ms;SPA 稳定等待最长 `5_000`ms、每 `500`ms 轮询;限频间隔 `10_000`ms
- 登录关键词正则:`login|signin|sign-in|auth|passport`,大小写不敏感,只测 finalUrl
- 三态映射:任一信号命中 → `invalid`;都没命中 → `valid`;超时/报错/崩溃 → `valid: null`(unknown)
- 结果结构字段名:`{ valid, strategy, checkedAt, finalUrl, signals, note }`,`note` 可选

---

### Task 1: BrowserSession 隐藏页通道

**Files:**
- Modify: `src/browser/BrowserSession.js`(constructor 状态、`start()` 事件过滤器、`stop()` 清理、新方法)
- Test: `test/browser/BrowserSession.hidden-page.test.js`(新建)

**Interfaces:**
- Consumes: 无(基础层)
- Produces:
  - `async openHiddenPage() → Page|null`(`_context` 为 null 时返回 null;成功返回 Playwright Page,不在 `_pages` 中)
  - `async closeHiddenPage(page)`(null 安全;从 `_hiddenPages` 移除并关闭)
  - `session._hiddenPages: Set<Page>`、`session._pendingHidden: boolean`(测试观察用)

- [ ] **Step 1: Write the failing tests**

```js
// test/browser/BrowserSession.hidden-page.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserSession } from "../../src/browser/BrowserSession.js";

const HELLO_HTML = `<!DOCTYPE html><html><body><h1>hello</h1></body></html>`;

async function startSite() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HELLO_HTML);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

test("BrowserSession hidden page: not in tab list, no tabsChange, screencast untouched", async () => {
  const { server, url } = await startSite();
  let session = null;
  try {
    session = new BrowserSession({ url, width: 400, height: 300 });
    let tabsChanges = 0;
    session.onTabsChange = () => { tabsChanges++; };
    await session.start();
    const pagesBefore = session.getTabsState().pages.length;
    const activeBefore = session.getTabsState().activeId;
    const baseline = tabsChanges;

    const page = await session.openHiddenPage();
    assert.ok(page, "returns a Page");
    await page.goto(url);
    await session.openHiddenPage();  // second hidden page at once

    assert.equal(session.getTabsState().pages.length, pagesBefore, "tab list unchanged");
    assert.equal(session.getTabsState().activeId, activeBefore, "active tab unchanged");
    assert.equal(tabsChanges, baseline, "no tabsChange fired");
    assert.equal(session._hiddenPages.size, 2);
    assert.equal(session._pages.size, pagesBefore, "_pages unchanged");

    await session.closeHiddenPage(page);
    assert.equal(session._hiddenPages.size, 1);
    assert.equal(page.isClosed(), true, "page closed");
  } finally {
    if (session) await session.stop().catch(() => {});
    server.close();
  }
});

test("BrowserSession hidden page: executes JS (not frozen), stop() cleans up", async () => {
  const { server, url } = await startSite();
  let session = null;
  try {
    session = new BrowserSession({ url, width: 400, height: 300, freezeBackground: true });
    await session.start();
    const page = await session.openHiddenPage();
    await page.goto(url);
    // A frozen page can't run timers — script execution must stay enabled.
    const probe = await page.evaluate(() =>
      new Promise(resolve => setTimeout(() => resolve("alive"), 50)));
    assert.equal(probe, "alive", "hidden page JS runs while user tab is active");

    await session.stop();
    assert.equal(page.isClosed(), true, "stop() closes hidden pages");
    assert.equal(session._hiddenPages.size, 0);
  } finally {
    if (session && session._context) await session.stop().catch(() => {});
    server.close();
  }
});

test("BrowserSession hidden page: openHiddenPage returns null when stopped", async () => {
  const session = new BrowserSession({ url: "about:blank", width: 400, height: 300 });
  assert.equal(await session.openHiddenPage(), null);
  await session.closeHiddenPage(null); // must not throw
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/browser/BrowserSession.hidden-page.test.js`
Expected: FAIL — `session.openHiddenPage is not a function`

- [ ] **Step 3: Implement**

`src/browser/BrowserSession.js` constructor(`this._newPageInProgress = false;` 之后)加:

```js
    this._hiddenPages = new Set();  // background utility pages (checks, probes):
    // never in _pages, never frozen, never switch targets — invisible to the user.
    this._pendingHidden = false;    // openHiddenPage() in flight: context.on('page')
    // may fire before newPage() resolves, so the filter needs this flag too.
```

`start()` 中,把现有 `this._context.on("page", (page) => {` 的回调体开头加过滤(在 `_registerPage` 调用之前):

```js
    this._context.on("page", (page) => {
      if (this._pendingHidden || this._hiddenPages.has(page)) return;
      this._registerPage(page).then(id => {
```

(回调其余部分不变。)

`_createBlankPage()` 方法后加两个公开方法:

```js
  // Public: open a hidden utility page — usable for background checks.
  // Not registered in _pages: absent from the tab list, never frozen,
  // never steals the active page or screencast. Null when not started.
  async openHiddenPage() {
    if (!this._context) return null;
    this._pendingHidden = true;
    try {
      const page = await this._context.newPage();
      this._hiddenPages.add(page);
      page.on("close", () => this._hiddenPages.delete(page));
      return page;
    } finally {
      this._pendingHidden = false;
    }
  }

  // Public: close a page opened by openHiddenPage(). Null-safe.
  async closeHiddenPage(page) {
    if (!page) return;
    this._hiddenPages.delete(page);
    try { await page.close(); } catch {}
  }
```

`stop()` 中,`for (const entry of this._pages.values())` 循环后加:

```js
    for (const page of this._hiddenPages) {
      try { await page.close(); } catch {}
    }
    this._hiddenPages.clear();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/browser/BrowserSession.hidden-page.test.js`
Expected: 3 PASS

- [ ] **Step 5: Run the full browser test suite for regressions**

Run: `node --test test/browser/`
Expected: all PASS(重点确认 tabs/freeze/persistent 用例不受事件过滤器影响)

- [ ] **Step 6: Commit**

```bash
git add src/browser/BrowserSession.js test/browser/BrowserSession.hidden-page.test.js
git commit -m "Add BrowserSession hidden page channel"
```

---

### Task 2: SessionRegistry full 策略核心(检测 URL + 三态判定)

**Files:**
- Modify: `src/session/SessionRegistry.js`(新状态 Map、`check()` full 分支、`_pickCheckUrl()`)
- Test: `test/session/SessionRegistry.test.js`(追加)

**Interfaces:**
- Consumes: Task 1 的 `browserSession.openHiddenPage()`/`closeHiddenPage()`(通过 stub 提供,mock 记录调用)
- Produces:
  - `check(domain, 'full') → { valid: boolean|null, strategy: 'full', checkedAt: number, finalUrl: string, signals: { redirectedToLogin: boolean, hasPasswordInput: boolean }, note?: string }`;异常路径 `{ valid: null, strategy: 'full', checkedAt, note: 'timeout' | 'nav-error' }`
  - `check(domain, 'quick')` 返回同样结构(无 `finalUrl`/`signals`),并写入 `_checkResults`
  - `_pickCheckUrl(group) → string`(组内 cookieCount 最大的 origin.url;无 origins 兜底 `https://{domain}`)

- [ ] **Step 1: Write the failing tests**

追加到 `test/session/SessionRegistry.test.js`(文件顶部 `test` 导入行已有;需补 `deepStrictEqual` 或直接用 `ok`):

```js
// ===== full check strategy =====
// Local HTTP sites serve deterministic login/logged-in pages; the hidden
// page is a real Playwright page (hidden channel itself is tested in
// test/browser/BrowserSession.hidden-page.test.js).
import http from 'node:http';

function serveCheckSite(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Registry whose browserSession stub wraps a real context so hidden pages
// are real pages; records hidden-page opens for assertions.
async function launchCheckRegistry() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  let hiddenOpened = 0;
  const browserSession = {
    _context: context,
    _pages: new Map([[1, { page, cdp }]]),
    openHiddenPage: async () => {
      hiddenOpened++;
      return context.newPage();
    },
    closeHiddenPage: async (p) => { await p.close(); }
  };
  return { browser, context, browserSession, hiddenOpens: () => hiddenOpened };
}

test('SessionRegistry.check full reports invalid on redirect to login URL', async () => {
  const { server, url } = await serveCheckSite((req, res) => {
    if (req.url === '/') {
      res.writeHead(302, { location: `${url}/login` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>sign in</body></html>');
  });
  const { browser, context, browserSession } = await launchCheckRegistry();
  try {
    await context.addCookies([{ name: 'sid', value: '1', domain: '127.0.0.1', path: '/' }]);
    const registry = new SessionRegistry({ browserSession });
    const result = await registry.check('127.0.0.1', 'full');

    strictEqual(result.valid, false);
    strictEqual(result.strategy, 'full');
    strictEqual(result.signals.redirectedToLogin, true);
    ok(result.checkedAt > 0);
    ok(result.finalUrl.includes('/login'));
  } finally {
    await context.close(); await browser.close(); server.close();
  }
});

test('SessionRegistry.check full reports invalid on password input', async () => {
  const { server, url } = await serveCheckSite((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><input type="password" name="pwd"></body></html>');
  });
  const { browser, context, browserSession } = await launchCheckRegistry();
  try {
    await context.addCookies([{ name: 'sid', value: '1', domain: '127.0.0.1', path: '/' }]);
    const registry = new SessionRegistry({ browserSession });
    const result = await registry.check('127.0.0.1', 'full');

    strictEqual(result.valid, false);
    strictEqual(result.signals.redirectedToLogin, false);
    strictEqual(result.signals.hasPasswordInput, true);
  } finally {
    await context.close(); await browser.close(); server.close();
  }
});

test('SessionRegistry.check full reports valid when no signal fires', async () => {
  const { server, url } = await serveCheckSite((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><h1>dashboard</h1></body></html>');
  });
  const { browser, context, browserSession } = await launchCheckRegistry();
  try {
    await context.addCookies([{ name: 'sid', value: '1', domain: '127.0.0.1', path: '/' }]);
    const registry = new SessionRegistry({ browserSession });
    const result = await registry.check('127.0.0.1', 'full');

    strictEqual(result.valid, true);
    strictEqual(result.signals.redirectedToLogin, false);
    strictEqual(result.signals.hasPasswordInput, false);
  } finally {
    await context.close(); await browser.close(); server.close();
  }
});

test('SessionRegistry.check full reports unknown on navigation timeout', async () => {
  const { server, url } = await serveCheckSite((req, res) => {
    // Never respond: goto times out.
    setTimeout(() => {}, 60000);
  });
  const { browser, context, browserSession } = await launchCheckRegistry();
  try {
    await context.addCookies([{ name: 'sid', value: '1', domain: '127.0.0.1', path: '/' }]);
    const registry = new SessionRegistry({ browserSession });
    const result = await registry.check('127.0.0.1', 'full');

    strictEqual(result.valid, null);
    strictEqual(result.note, 'timeout');
    // 超时用的 goto timeout 参数是 15s,本测试真实等 15s 太久——见 Step 3:
    // check 接受内部可注入的 timeout,测试传小值。此处先按 15s 默认写,
    // Step 3 实现时 check(domain, strategy, { timeoutMs }) 第三参支持小超时。
  } finally {
    await context.close(); await browser.close(); server.close();
  }
});

test('SessionRegistry.check full closes hidden page even on failure', async () => {
  const closed = [];
  let opened = null;
  const browserSession = {
    _context: { cookies: async () => [{ name: 's', value: '1', domain: 'example.com', path: '/' }] },
    _pages: new Map([[1, { cdp: { send: async () => ({ cookies: [{ name: 's', value: '1', domain: 'example.com', path: '/', sourcePort: 443, sourceScheme: 'Secure' }] }) } }]]),
    openHiddenPage: async () => {
      opened = { goto: async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); }, $: async () => null, url: () => 'https://example.com', close: async () => {} };
      return opened;
    },
    closeHiddenPage: async (p) => { closed.push(p); await p.close(); }
  };
  const registry = new SessionRegistry({ browserSession });
  const result = await registry.check('example.com', 'full');

  strictEqual(result.valid, null);
  strictEqual(closed.length, 1);
  strictEqual(closed[0], opened);
});

test('SessionRegistry.check picks highest-cookieCount origin URL, falls back to https://domain', async () => {
  const fakeCdp = {
    send: async () => ({
      cookies: [
        { name: 'a', value: '1', domain: '127.0.0.1', path: '/', sourcePort: 8080, sourceScheme: 'NonSecure' },
        { name: 'b', value: '2', domain: '127.0.0.1', path: '/', sourcePort: 8080, sourceScheme: 'NonSecure' },
        { name: 'c', value: '3', domain: '127.0.0.1', path: '/', sourcePort: 9090, sourceScheme: 'NonSecure' },
      ]
    })
  };
  const contextStub = {
    cookies: async () => [
      { name: 'a', value: '1', domain: '127.0.0.1', path: '/' },
      { name: 'b', value: '2', domain: '127.0.0.1', path: '/' },
      { name: 'c', value: '3', domain: '127.0.0.1', path: '/' },
    ],
  };
  const navs = [];
  const browserSession = {
    _context: contextStub,
    _pages: new Map([[1, { cdp: fakeCdp }]]),
    openHiddenPage: async () => ({ goto: async (u) => { navs.push(u); }, $: async () => null, url: () => navs[navs.length - 1], close: async () => {} }),
    closeHiddenPage: async (p) => { await p.close(); }
  };
  const registry = new SessionRegistry({ browserSession });
  await registry.check('127.0.0.1', 'full');
  strictEqual(navs[0], 'http://127.0.0.1:8080', '2-cookie origin beats 1-cookie origin');

  // No origins (CDP returns nothing usable) → https://{domain} fallback.
  const fallbackCdp = { send: async () => ({ cookies: [] }) };
  const fallbackSession = {
    _context: { cookies: async () => [] },
    _pages: new Map([[1, { cdp: fallbackCdp }]]),
    openHiddenPage: async () => ({ goto: async (u) => { navs.push(u); }, $: async () => null, url: () => navs[navs.length - 1], close: async () => {} }),
    closeHiddenPage: async (p) => { await p.close(); }
  };
  const registry2 = new SessionRegistry({ browserSession: fallbackSession });
  const r2 = await registry2.check('example.com', 'full');
  strictEqual(navs[1], 'https://example.com');
  ok(r2);
});
```

注意超时测试的真实写法(替换上面第 4 个测试的注释版):

```js
test('SessionRegistry.check full reports unknown on navigation timeout', async () => {
  const { server, url } = await serveCheckSite((req, res) => {
    setTimeout(() => {}, 60000);  // never respond
  });
  const { browser, context, browserSession } = await launchCheckRegistry();
  try {
    await context.addCookies([{ name: 'sid', value: '1', domain: '127.0.0.1', path: '/' }]);
    const registry = new SessionRegistry({ browserSession });
    const result = await registry.check('127.0.0.1', 'full', { timeoutMs: 1500 });

    strictEqual(result.valid, null);
    strictEqual(result.note, 'timeout');
    strictEqual(result.strategy, 'full');
  } finally {
    await context.close(); await browser.close(); server.close();
  }
});
```

(`check` 第三参 `{ timeoutMs }` 只为测试注入;生产路径不传,用默认 15s。)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/session/SessionRegistry.test.js`
Expected: FAIL — full 分支返回 `{ valid: false, details: { message: 'Not implemented' } }` 之类,断言不匹配

- [ ] **Step 3: Implement**

`src/session/SessionRegistry.js`:

constructor 加:

```js
    this._checkResults = new Map();   // domain → last check result (memory only)
    this._checkInFlight = new Map();  // domain → in-flight check Promise
    this._lastCheckAt = new Map();    // domain → ms timestamp (rate limiting)
```

类顶部(模块级,logger 导入后)加常量:

```js
const CHECK_GOTO_TIMEOUT_MS = 15_000;  // single-domain full check budget
const CHECK_STABLE_POLL_MS = 500;      // SPA redirect-chain settle poll interval
const CHECK_STABLE_MAX_MS = 5_000;     // max settle wait
const CHECK_RATE_LIMIT_MS = 10_000;    // same-domain re-check cooldown
const LOGIN_URL_RE = /login|signin|sign-in|auth|passport/i;
```

`check()` 整体替换为:

```js
  /**
   * 验证登录态
   * quick: cookie 存在性。full: 隐藏页访问 + 重定向/密码框信号 → 三态。
   * @param {string} domain
   * @param {string} strategy - 'quick' | 'full' | 'custom'
   * @param {{timeoutMs?: number}} [opts] - 测试注入(生产用默认 15s)
   * @returns {Promise<{valid: boolean|null, strategy: string, checkedAt: number, finalUrl?: string, signals?: object, note?: string}>}
   */
  async check(domain, strategy = 'quick', { timeoutMs = CHECK_GOTO_TIMEOUT_MS } = {}) {
    if (strategy === 'quick') {
      const cookies = await this._fetchCookies();
      const hasCookies = cookies.some(c => c.domain.includes(domain));
      return this._recordCheck(domain, { valid: hasCookies, strategy });
    }
    if (strategy === 'full') {
      return this._fullCheck(domain, timeoutMs);
    }
    return this._recordCheck(domain, { valid: null, strategy, note: 'not-implemented' });
  }

  // Internal: store result and stamp the rate-limit clock.
  _recordCheck(domain, result) {
    const entry = { ...result, checkedAt: Date.now() };
    this._checkResults.set(domain, entry);
    this._lastCheckAt.set(domain, entry.checkedAt);
    return entry;
  }

  // Internal: full strategy — hidden page visit, two signals, three states.
  async _fullCheck(domain, timeoutMs) {
    const inFlight = this._checkInFlight.get(domain);
    if (inFlight) return inFlight;

    const lastAt = this._lastCheckAt.get(domain) ?? 0;
    if (Date.now() - lastAt < CHECK_RATE_LIMIT_MS) {
      const prev = this._checkResults.get(domain);
      if (prev) return { ...prev, note: 'rate-limited' };
    }

    const promise = this._doFullCheck(domain, timeoutMs)
      .finally(() => this._checkInFlight.delete(domain));
    this._checkInFlight.set(domain, promise);
    return promise;
  }

  async _doFullCheck(domain, timeoutMs) {
    const browserSession = this._browserSession;
    if (!browserSession._context) {
      return this._recordCheck(domain, { valid: null, strategy: 'full', note: 'browser-not-running' });
    }
    const cookies = await this._fetchCookies();
    const group = this._groupCookies(cookies).get(domain);
    const checkUrl = this._pickCheckUrl(group, domain);

    const page = await browserSession.openHiddenPage();
    if (!page) {
      return this._recordCheck(domain, { valid: null, strategy: 'full', note: 'browser-not-running' });
    }
    try {
      let finalUrl = await this._gotoStable(page, checkUrl, timeoutMs);
      const redirectedToLogin = LOGIN_URL_RE.test(finalUrl);
      const hasPasswordInput = await page.$('input[type=password]').then(el => el !== null);
      return this._recordCheck(domain, {
        valid: !(redirectedToLogin || hasPasswordInput),
        strategy: 'full',
        finalUrl,
        signals: { redirectedToLogin, hasPasswordInput },
      });
    } catch (err) {
      const timedOut = /Timeout .*exceeded/i.test(String(err?.message));
      return this._recordCheck(domain, {
        valid: null, strategy: 'full',
        note: timedOut ? 'timeout' : 'nav-error',
      });
    } finally {
      await browserSession.closeHiddenPage(page);
    }
  }

  // Internal: navigate, then wait out SPA redirect chains — poll until the
  // URL stops changing (or the settle budget runs out).
  async _gotoStable(page, url, timeoutMs) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    let last = page.url();
    const deadline = Date.now() + CHECK_STABLE_MAX_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, CHECK_STABLE_POLL_MS));
      const current = page.url();
      if (current === last) break;
      last = current;
    }
    return last;
  }

  // Internal: best origin to probe — most cookies carried; else scheme-guess.
  _pickCheckUrl(group, domain) {
    if (group && group.origins && group.origins.size > 0) {
      let bestUrl = null, bestCount = -1;
      for (const [url, count] of group.origins) {
        if (count > bestCount) { bestUrl = url; bestCount = count; }
      }
      return bestUrl;
    }
    return `https://${domain}`;
  }
```

**已核实**(现有 `src/session/SessionRegistry.js:81-123`):`_groupCookies()` 返回的 group 本身就带 `origins: Map<url, count>`——`_pickCheckUrl` 直接用 `group.origins` 取最大项即可,无需重构聚合逻辑:

```js
  // Internal: best origin to probe — most cookies carried; else scheme-guess.
  _pickCheckUrl(group, domain) {
    if (group && group.origins && group.origins.size > 0) {
      let bestUrl = null, bestCount = -1;
      for (const [url, count] of group.origins) {
        if (count > bestCount) { bestUrl = url; bestCount = count; }
      }
      return bestUrl;
    }
    return `https://${domain}`;
  }
```

(用上面这段替换 Step 3 代码块里的 `_pickCheckUrl` reduce 版本——`origins` 是 Map 不是数组,reduce 不可用。)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/session/SessionRegistry.test.js`
Expected: all PASS(新增 6 个 + 原有全部)

- [ ] **Step 5: Commit**

```bash
git add src/session/SessionRegistry.js test/session/SessionRegistry.test.js
git commit -m "Implement full check strategy with hidden-page visit"
```

---

### Task 3: list() 返回 lastCheck + 限频/去重测试

**Files:**
- Modify: `src/session/SessionRegistry.js`(`list()` 加 `lastCheck` 字段)
- Test: `test/session/SessionRegistry.test.js`(追加)

**Interfaces:**
- Consumes: Task 2 的 `_checkResults`(同文件)
- Produces: `list()` 条目新增可选字段 `lastCheck: { valid, strategy, checkedAt }`(无结果时字段不存在;只带三字段,不带 finalUrl/signals/note——UI 只需要这些)

- [ ] **Step 1: Write the failing tests**

```js
test('SessionRegistry.list carries lastCheck after a check', async () => {
  const { browser, context, browserSession } = await launchRegistry();
  await context.addCookies([{ name: 'sid', value: '1', domain: 'example.com', path: '/' }]);
  try {
    const registry = new SessionRegistry({ browserSession });
    await registry.check('example.com', 'quick');
    const sessions = await registry.list();

    const example = sessions.find(s => s.domain === 'example.com');
    ok(example.lastCheck, 'lastCheck present');
    strictEqual(example.lastCheck.valid, true);
    strictEqual(example.lastCheck.strategy, 'quick');
    ok(example.lastCheck.checkedAt > 0);
    strictEqual(Object.keys(example.lastCheck).length, 3, 'only valid/strategy/checkedAt');
  } finally {
    await context.close(); await browser.close();
  }
});

test('SessionRegistry.list omits lastCheck when never checked', async () => {
  const { browser, context, browserSession } = await launchRegistry();
  await context.addCookies([{ name: 'sid', value: '1', domain: 'example.com', path: '/' }]);
  try {
    const registry = new SessionRegistry({ browserSession });
    const sessions = await registry.list();
    const example = sessions.find(s => s.domain === 'example.com');
    ok(!('lastCheck' in example), 'no lastCheck key at all');
  } finally {
    await context.close(); await browser.close();
  }
});

test('SessionRegistry.check rate-limits repeat full checks within 10s', async () => {
  let opens = 0;
  const browserSession = {
    _context: { cookies: async () => [{ name: 's', value: '1', domain: 'example.com', path: '/' }] },
    _pages: new Map([[1, { cdp: { send: async () => ({ cookies: [{ name: 's', value: '1', domain: 'example.com', path: '/', sourcePort: 443, sourceScheme: 'Secure' }] }) } }]]),
    openHiddenPage: async () => {
      opens++;
      return { goto: async () => {}, $: async () => null, url: () => 'https://example.com', close: async () => {} };
    },
    closeHiddenPage: async (p) => { await p.close(); }
  };
  const registry = new SessionRegistry({ browserSession });
  const first = await registry.check('example.com', 'full');
  strictEqual(first.valid, true);
  strictEqual(opens, 1);

  const second = await registry.check('example.com', 'full');
  strictEqual(opens, 1, 'no second hidden page within 10s');
  strictEqual(second.note, 'rate-limited');
  strictEqual(second.valid, true, 'rate-limited returns previous verdict');
});

test('SessionRegistry.check dedupes concurrent full checks on same domain', async () => {
  let opens = 0;
  let releaseGoto;
  const gate = new Promise(r => { releaseGoto = r; });
  const browserSession = {
    _context: { cookies: async () => [{ name: 's', value: '1', domain: 'example.com', path: '/' }] },
    _pages: new Map([[1, { cdp: { send: async () => ({ cookies: [{ name: 's', value: '1', domain: 'example.com', path: '/', sourcePort: 443, sourceScheme: 'Secure' }] }) } }]]),
    openHiddenPage: async () => {
      opens++;
      return {
        goto: async () => { await gate; },   // hold first check open
        $: async () => null,
        url: () => 'https://example.com',
        close: async () => {}
      };
    },
    closeHiddenPage: async (p) => { await p.close(); }
  };
  const registry = new SessionRegistry({ browserSession });
  const p1 = registry.check('example.com', 'full');
  const p2 = registry.check('example.com', 'full');
  releaseGoto();
  const [r1, r2] = await Promise.all([p1, p2]);

  strictEqual(opens, 1, 'both calls share one hidden page');
  strictEqual(r1.valid, true);
  strictEqual(r2.valid, true);
  strictEqual(r1.checkedAt, r2.checkedAt, 'same recorded result');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/session/SessionRegistry.test.js`
Expected: lastCheck 两个用例 FAIL(字段不存在);rate-limit/dedup 可能已通过(Task 2 已实现)——若已通过也保留作回归

- [ ] **Step 3: Implement**

`list()` 中,构造返回条目的地方(现有 `sessions.push(...)` 或 map 处)加:

```js
      const lastCheckResult = this._checkResults.get(domain);
      const item = { domain, cookieCount: ..., origins: ... };
      if (lastCheckResult) {
        item.lastCheck = {
          valid: lastCheckResult.valid,
          strategy: lastCheckResult.strategy,
          checkedAt: lastCheckResult.checkedAt,
        };
      }
```

现有 `list()`(src/session/SessionRegistry.js:56-69)是 `.map(([domain, g]) => ({...}))` 单表达式。改为 map 回调里先构造 `item`、追加 `lastCheck`、再 return:

```js
    return [...groups.entries()]
      .map(([domain, g]) => {
        const item = {
          domain,
          cookieCount: g.cookieCount,
          origins: [...g.origins.entries()]
            .map(([url, count]) => ({ url, cookieCount: count }))
            .sort((a, b) => b.cookieCount - a.cookieCount)
        };
        const lastCheckResult = this._checkResults.get(domain);
        if (lastCheckResult) {
          item.lastCheck = {
            valid: lastCheckResult.valid,
            strategy: lastCheckResult.strategy,
            checkedAt: lastCheckResult.checkedAt,
          };
        }
        return item;
      })
      .sort((a, b) => b.cookieCount - a.cookieCount);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/session/SessionRegistry.test.js`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/session/SessionRegistry.js test/session/SessionRegistry.test.js
git commit -m "Carry lastCheck in list and enforce check rate limit"
```

---

### Task 4: API 默认 full + ensureBrowserStarted

**Files:**
- Modify: `src/routes/api/sessions.js`(check 路由)
- Test: `test/routes/api/sessions.test.js`(追加)

**Interfaces:**
- Consumes: `ensureBrowserStarted` 依赖(已由 `createSessionsRoute({ getSessionRegistry, ensureBrowserStarted })` 注入)
- Produces: `POST /api/sessions/:domain/check` 无 body 或无 strategy 时调用 `registry.check(domain, 'full')`;浏览器未运行时先 `ensureBrowserStarted()` 再取 registry(仍 null → 503)

- [ ] **Step 1: Write the failing tests**

追加到 `test/routes/api/sessions.test.js`:

```js
test('POST /api/sessions/:domain/check defaults to full strategy', async () => {
  let seenStrategy = null;
  const registry = {
    check: async (domain, strategy) => {
      strictEqual(domain, 'example.com');
      seenStrategy = strategy;
      return { valid: true, strategy };
    }
  };
  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({ getSessionRegistry: () => registry }));

  const res = await app.request('/api/sessions/example.com/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})          // no strategy → full
  });
  strictEqual(res.status, 200);
  strictEqual(seenStrategy, 'full');
  strictEqual((await res.json()).valid, true);
});

test('POST /api/sessions/:domain/check starts browser when not running', async () => {
  let registry = null;
  let started = 0;
  const makeRegistry = () => ({
    check: async () => ({ valid: true, strategy: 'full', checkedAt: 1 })
  });
  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({
    getSessionRegistry: () => registry,
    ensureBrowserStarted: async () => { started++; registry = makeRegistry(); }
  }));

  const res = await app.request('/api/sessions/example.com/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  strictEqual(res.status, 200);
  strictEqual(started, 1, 'ensureBrowserStarted called once');
  strictEqual((await res.json()).valid, true);
});

test('POST /api/sessions/:domain/check returns 503 when browser cannot start', async () => {
  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({
    getSessionRegistry: () => null,
    ensureBrowserStarted: async () => {}
  }));
  const res = await app.request('/api/sessions/example.com/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  strictEqual(res.status, 503);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/routes/api/sessions.test.js`
Expected: defaults-to-full FAIL(seenStrategy 为 'quick');503 用例可能已通过(现有代码就有 503,但没走 ensureBrowserStarted 的路径差异要看断言)

- [ ] **Step 3: Implement**

`src/routes/api/sessions.js` 的 check 路由替换为:

```js
  // 验证登录态(默认 full:隐藏页访问;quick 仅 cookie 存在性)
  app.post('/:domain/check', async (c) => {
    let sessionRegistry = getSessionRegistry();
    if (!sessionRegistry) {
      // Full check needs a live browser (hidden page); start it like GET / does.
      if (ensureBrowserStarted) {
        await ensureBrowserStarted();
        sessionRegistry = getSessionRegistry();
      }
      if (!sessionRegistry) {
        return c.json({ error: 'Session registry not available' }, 503);
      }
    }
    const domain = c.req.param('domain');
    const body = await c.req.json().catch(() => ({}));
    const strategy = body.strategy || 'full';
    const result = await sessionRegistry.check(domain, strategy);
    return c.json(result);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/routes/api/sessions.test.js`
Expected: all PASS(含原有 quick 显式传参用例——body 传 `strategy: 'quick'` 仍然直达)

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/sessions.js test/routes/api/sessions.test.js
git commit -m "Default check endpoint to full strategy with browser autostart"
```

---

### Task 5: UI 内联状态徽章 + loading 态

**Files:**
- Modify: `src/public/client.html`(CSS 徽章样式、`renderSessions()` 状态行、`checkDomain()` loading、`formatRelativeTime()`)

**Interfaces:**
- Consumes: Task 3/4 的 `lastCheck` 字段与 check 响应结构 `{ valid, strategy, checkedAt, note? }`
- Produces: 无 JS 模块导出(页面内函数);`renderSessions` 渲染状态徽章;`checkDomain(domain, btn)` 接收按钮引用管理 loading

**说明**:client.html 无 JS 单测基建(现有测试全是 Node 侧);验证方式为 `node --test` 全量回归 + 手动验收。徽章渲染逻辑简单(纯字符串模板),风险低。

- [ ] **Step 1: Add CSS**

`.session-origin:hover` 规则后追加:

```css
    .session-status {
      font-size: 12px;
      margin-top: 4px;
    }
    .session-status .badge-valid   { color: #52c41a; font-weight: 500; }
    .session-status .badge-invalid { color: #f56c6c; font-weight: 500; }
    .session-status .badge-unknown { color: #8892b0; font-weight: 500; }
    .session-status .badge-meta    { color: #8892b0; }
```

- [ ] **Step 2: Add helpers + render status line**

`formatExpires` 函数前加:

```js
    function formatRelativeTime(ts) {
      const diff = Date.now() - ts;
      if (diff < 60_000) return '刚刚';
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
      return `${Math.floor(diff / 86_400_000)}天前`;
    }

    function renderStatusLine(lastCheck) {
      if (!lastCheck) return '';
      const { valid, strategy, checkedAt } = lastCheck;
      const badge = valid === null || valid === undefined
        ? '<span class="badge-unknown">? 未知</span>'
        : valid
          ? '<span class="badge-valid">✓ 已登录</span>'
          : '<span class="badge-invalid">✗ 已失效</span>';
      return `<div class="session-status">${badge}<span class="badge-meta"> · ${strategy} · ${formatRelativeTime(checkedAt)}</span></div>`;
    }
```

`renderSessions()` 里 `session-domain` 行后插入状态行(现有 origins map 之前):

```js
          <div>
            <div class="session-domain">${session.domain}</div>
            ${renderStatusLine(session.lastCheck)}
            <div class="session-stats">Cookies: ${session.cookieCount || 0}</div>
```

验证按钮改为传 this:

```html
<button onclick="checkDomain('${session.domain}', this)">验证</button>
```

- [ ] **Step 3: Rewrite checkDomain with loading state**

现有 `checkDomain(domain)` 整体替换为:

```js
    async function checkDomain(domain, btn) {
      if (btn) { btn.disabled = true; btn.textContent = '验证中…'; }
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(domain)}/check`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await response.json();         // result lands in the badge via reload
        await loadSessions();          // refresh list — lastCheck now present
      } catch (err) {
        console.error('[Sessions] Check failed:', err);
        alert('验证失败');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '验证'; }
      }
    }
```

- [ ] **Step 4: Verify no regressions + manual smoke**

Run: `node --test`
Expected: all PASS(client.html 不进测试,全量跑确认没碰坏别的)

手动验收(可选,需用户配合):`npm start` → 登录 → 登录状态面板 → 点「验证」→ 按钮变「验证中…」→ 数秒后条目出现「✓ 已登录 · full · 刚刚」,期间远程画面不受打扰。

- [ ] **Step 5: Commit**

```bash
git add src/public/client.html
git commit -m "Render inline check status badge with loading state"
```

---

### Task 6: 全量回归 + spec 对照收尾

**Files:**
- 无新文件;验证性任务

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all PASS

- [ ] **Step 2: Spec 对照清单(逐条核对)**

| Spec 条目 | 对应实现 |
|------|------|
| 隐藏页不进 tab 列表/不触发 tabsChange | Task 1 测试 1 |
| 隐藏页不被 freeze | Task 1 测试 2(JS 探针) |
| 竞态(context.on('page') 先于 newPage resolve) | Task 1 `_pendingHidden` 标记 |
| stop() 兜底清理隐藏页 | Task 1 测试 2 |
| full invalid:URL 关键词 | Task 2 测试 1(302 → /login) |
| full invalid:密码框 | Task 2 测试 2 |
| full valid:无信号 | Task 2 测试 3 |
| full unknown:超时 | Task 2 测试 4 |
| 异常也关页 | Task 2 测试 5 |
| URL 选择:最大 origin / https 兜底 | Task 2 测试 6 |
| 限频 10s + note:'rate-limited' | Task 3 测试 3 |
| 并发去重 | Task 3 测试 4 |
| quick 也写结果 | Task 3 测试 1 |
| list() 带 lastCheck(仅 3 字段) | Task 3 测试 1/2 |
| API 默认 full | Task 4 测试 1 |
| 未运行先 ensureBrowserStarted | Task 4 测试 2/3 |
| 徽章三态 + 相对时间 | Task 5 |
| loading 态 | Task 5 |
| alert 仅错误保留 | Task 5 |

发现缺口 → 补实现/补测试,再回归。

- [ ] **Step 3: Final commit(如有收尾改动)**

```bash
git add -A
git commit -m "Polish full check per spec review"
```

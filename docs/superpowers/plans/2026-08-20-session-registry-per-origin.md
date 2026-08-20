# SessionRegistry 按服务（origin）细分实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录状态列表在 domain 组内按服务（origin，含端口）细分展示，每个 origin 子项可点击跳转完整 URL。

**Architecture:** `SessionRegistry` 读取 cookies 改为两步——Playwright `context.cookies()` 枚举全部 cookie 的 domain，再用任意页面 CDP session 的 `Network.getCookies({ urls })` 批量取回带 `sourcePort`/`sourceScheme` 的完整数据（实验验证：无参调用只返回当前页面 URL 关联的 cookie，必须传 urls）。第一级 cookie 语义分组（`_groupCookies`）不动，第二级在组内按构造出的 origin 聚合。UI 的 `visitDomain` 替换为 `visitOrigin(url)`。

**Tech Stack:** Playwright BrowserContext cookies API + CDP `Network.getCookies`，无新增依赖

## Global Constraints

- 运行时依赖：仅 playwright, ws, hono, @hono/node-server（本次不新增）
- ESM 模块，显式 `.js` 扩展名
- 日志格式：`[Module] message`，仅关键控制点
- 代码风格：`_` 前缀表示私有字段
- 测试文件命名：`test/**/*.test.js`（npm test 只匹配该模式）
- origin 构造规则（spec §3）：`scheme = sourceScheme === 'Secure' ? 'https' : 'http'`；端口仅在非默认（https≠443 / http≠80）时显示；sourcePort 缺失则省略端口
- `delete()` 保持 Playwright `context.clearCookies({ domain: raw })`，整组按 rawDomains 精确清除（CDP 只用于读取）

---

## File Structure

| 文件 | 职责 |
|------|------|
| `src/session/SessionRegistry.js` | 修改：构造参数 `{ browserSession }`；`_fetchCookies()` 两步取数；`_cookieOrigin()` 构造 origin；`list()` 组内聚合 origins |
| `src/index.js` | 修改：getter 传 `browserSession`（60-70 行） |
| `src/public/client.html` | 修改：`renderSessions()` 显示 origins 列表；`visitDomain` → `visitOrigin`（约 897-935 行） |
| `test/session/SessionRegistry.test.js` | 修改：新增 origin 聚合测试；现有测试断言从 `subDomains` 换 `origins` |
| `test/routes/api/sessions.test.js` | 不动（mock registry 不经过真实构造） |

---

### Task 1: SessionRegistry 数据源切换与 origin 聚合

**Files:**
- Modify: `src/session/SessionRegistry.js`
- Test: `test/session/SessionRegistry.test.js`

**Interfaces:**
- Consumes: `browserSession._context`（Playwright BrowserContext，`context.cookies()` / `context.clearCookies()`）；`browserSession._pages`（Map，pageId → `{ page, cdp, title, url }`，`cdp.send()` 可用）
- Produces: `new SessionRegistry({ browserSession })`（构造参数改名）；`list()` 返回 `Array<{domain: string, cookieCount: number, origins: Array<{url: string, cookieCount: number}>}>`（`subDomains` 字段删除，`origins` 按 cookieCount 降序）

- [ ] **Step 1: 写失败测试**

在 `test/session/SessionRegistry.test.js` 中，先把现有测试的构造方式改掉。测试文件顶部所有 `new SessionRegistry({ context })` 需要一个带 pages 的 browserSession mock。在文件顶部（import 之后）加：

```javascript
// Build a SessionRegistry over a real Playwright context, mirroring how
// src/index.js passes browserSession (context + pages with CDP sessions).
async function launchRegistry() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const browserSession = {
    _context: context,
    _pages: new Map([[1, { page, cdp }]])
  };
  return { browser, context, browserSession };
}
```

然后把现有每个测试的 `const browser = await chromium.launch(); const context = await browser.newContext();` 与 `new SessionRegistry({ context })` 改为：

```javascript
  const { browser, context, browserSession } = await launchRegistry();
  // ...
  const registry = new SessionRegistry({ browserSession });
```

收尾的 `await context.close(); await browser.close();` 不变（多出的 page 随 context 关闭）。

注意：现有测试里 `addCookies` 不带 `sourcePort`（Playwright API 不接受该字段），真实数据里 sourcePort 由 CDP 查询补上。断言从 `subDomains` 改为 `origins`：

- "merges host-only subdomain" 测试（61-82 行）：

```javascript
  strictEqual(sessions[0].origins.length, 1);
  ok(sessions[0].origins[0].url.startsWith('http://www.baidu.com'));
```

（addCookies 写入的 cookie 无网络来源，sourcePort 可能缺失或为 0——端口省略，url 为 `http://www.baidu.com` 形态；用 startsWith 断言避免端口实现细节 brittle。）

- "folds bare-domain" 测试（106-126 行）：`strictEqual(sessions[0].subDomains.length, 0);` 改为：

```javascript
  ok(Array.isArray(sessions[0].origins));
```

- "joins longest matching group" 测试（128-155 行）：

```javascript
  strictEqual(sub.origins.filter(o => o.url.includes('x.sub.example.com')).length, 1);
  strictEqual(top.origins.length, 0);
```

`top.origins` 断言说明：`.example.com` 与 `.sub.example.com` 都是 addCookies 写入（无页面访问记录），但 cookie 存在就要归到某个 origin 下——origin 用 cookie 自身 domain 构造（见 Step 3），所以 `top` 组含 `.example.com` 1 条 cookie，`origins.length` 为 1。**修正**：改为

```javascript
  strictEqual(sub.origins.filter(o => o.url.includes('x.sub.example.com')).length, 1);
  strictEqual(top.origins.filter(o => o.url.includes('sub.example.com')).length, 1);
```

再在文件末尾追加三个新测试：

```javascript
test('SessionRegistry.list splits same-host cookies into per-origin entries', async () => {
  const { browser, context, browserSession } = await launchRegistry();
  const page = browserSession._pages.get(1).page;

  // Two HTTP servers on different ports, same host 127.0.0.1.
  const http = await import('node:http');
  const mkServer = (cookieName) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Set-Cookie', `${cookieName}=1; Path=/`);
      res.end('ok');
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
  };
  const srvA = await mkServer('aaa');
  const srvB = await mkServer('bbb');
  const portA = srvA.address().port;
  const portB = srvB.address().port;

  await page.goto(`http://127.0.0.1:${portA}/`);
  await page.goto(`http://127.0.0.1:${portB}/`);

  const registry = new SessionRegistry({ browserSession });
  const sessions = await registry.list();

  strictEqual(sessions.length, 1);
  strictEqual(sessions[0].domain, '127.0.0.1');
  strictEqual(sessions[0].cookieCount, 2);
  const urls = sessions[0].origins.map(o => o.url).sort();
  strictEqual(urls[0], `http://127.0.0.1:${portA}`);
  strictEqual(urls[1], `http://127.0.0.1:${portB}`);

  srvA.close(); srvB.close();
  await context.close();
  await browser.close();
});

test('SessionRegistry.list omits default ports and maps Secure scheme', async () => {
  const { browser, context, browserSession } = await launchRegistry();

  // Inject cookies through the registry's own code path shape: raw CDP-style
  // cookies with sourcePort/sourceScheme, via a stub _pages entry.
  const fakeCdp = {
    send: async (method, params) => {
      strictEqual(method, 'Network.getCookies');
      ok(Array.isArray(params.urls));
      return {
        cookies: [
          { name: 's', value: '1', domain: 'secure.example.com', path: '/', sourcePort: 443, sourceScheme: 'Secure' },
          { name: 'p', value: '1', domain: 'plain.example.com', path: '/', sourcePort: 80, sourceScheme: 'NonSecure' },
          { name: 'q', value: '1', domain: 'odd.example.com', path: '/', sourcePort: 8443, sourceScheme: 'Secure' },
        ]
      };
    }
  };
  const contextStub = {
    cookies: async () => [
      { name: 's', value: '1', domain: 'secure.example.com', path: '/' },
      { name: 'p', value: '1', domain: 'plain.example.com', path: '/' },
      { name: 'q', value: '1', domain: 'odd.example.com', path: '/' },
    ],
    clearCookies: async () => {}
  };
  const registry = new SessionRegistry({
    browserSession: { _context: contextStub, _pages: new Map([[1, { cdp: fakeCdp }]]) }
  });
  const sessions = await registry.list();

  const byDomain = Object.fromEntries(sessions.map(s => [s.domain, s]));
  strictEqual(byDomain['secure.example.com'].origins[0].url, 'https://secure.example.com');
  strictEqual(byDomain['plain.example.com'].origins[0].url, 'http://plain.example.com');
  strictEqual(byDomain['odd.example.com'].origins[0].url, 'https://odd.example.com:8443');

  await context.close();
  await browser.close();
});

test('SessionRegistry.list omits port when sourcePort missing', async () => {
  const fakeCdp = {
    send: async () => ({
      cookies: [
        { name: 'x', value: '1', domain: 'unknown.example.com', path: '/' },
      ]
    })
  };
  const contextStub = {
    cookies: async () => [{ name: 'x', value: '1', domain: 'unknown.example.com', path: '/' }],
    clearCookies: async () => {}
  };
  const registry = new SessionRegistry({
    browserSession: { _context: contextStub, _pages: new Map([[1, { cdp: fakeCdp }]]) }
  });
  const sessions = await registry.list();

  strictEqual(sessions.length, 1);
  strictEqual(sessions[0].origins[0].url, 'http://unknown.example.com');
});
```

（第二个新测试从 launchRegistry 借真实 browser 是为了保持文件模式统一，实际断言走 stub——可以简化为不启动 browser，直接用 stub；实现者按上面第三个测试的纯 stub 模式写第二个测试亦可。）

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/session/SessionRegistry.test.js
```

Expected: 构造参数不匹配导致现有测试大量失败（`this._context` 为 undefined 等），新增测试失败（无 origins 字段 / `_fetchCookies` 不存在）。

- [ ] **Step 3: 实现**

`src/session/SessionRegistry.js` 整体替换为：

```javascript
// src/session/SessionRegistry.js
import { logger } from '../utils/logger.js';

/**
 * SessionRegistry - 管理已保存的登录状态
 *
 * 读：Playwright 枚举 cookie domains + CDP Network.getCookies 取
 * sourcePort/sourceScheme（cookie 无端口号，CDP 记录了下发来源）。
 * 删：Playwright clearCookies 按 domain 组精确清除。
 */
export class SessionRegistry {
  constructor({ browserSession }) {
    this._browserSession = browserSession;
  }

  // Internal: any page's CDP session works — Network.getCookies is a
  // storage-level query; urls param selects which cookies come back.
  get _cdp() {
    const entry = this._browserSession._pages.values().next().value;
    return entry ? entry.cdp : null;
  }

  // Internal: fetch all cookies with sourcePort/sourceScheme. Two steps:
  // Playwright context.cookies() enumerates every cookie's domain, then one
  // batched CDP query with those URLs returns the CDP fields. (A no-arg CDP
  // call only returns cookies tied to the querying page's URLs.)
  async _fetchCookies() {
    const context = this._browserSession._context;
    const cdp = this._cdp;
    if (!context || !cdp) return [];
    const base = await context.cookies();
    if (base.length === 0) return [];
    const urls = [...new Set(base.map(c => `http://${c.domain.replace(/^\./, '')}/`))];
    const { cookies } = await cdp.send('Network.getCookies', { urls });
    return cookies;
  }

  // Internal: build the origin URL a cookie belongs to.
  // sourcePort missing/0 → omit port. Default ports (443/80) omitted.
  _cookieOrigin(cookie) {
    const scheme = cookie.sourceScheme === 'Secure' ? 'https' : 'http';
    const host = cookie.domain.replace(/^\./, '');
    const port = cookie.sourcePort && cookie.sourcePort !== 443 && cookie.sourcePort !== 80
      ? `:${cookie.sourcePort}` : '';
    return `${scheme}://${host}${port}`;
  }

  /**
   * 获取所有 domain 分组及其统计（组内按 origin 细分）
   * @returns {Promise<Array<{domain: string, cookieCount: number, origins: Array<{url: string, cookieCount: number}>}>>}
   */
  async list() {
    const cookies = await this._fetchCookies();
    const groups = this._groupCookies(cookies);

    return [...groups.entries()]
      .map(([domain, g]) => ({
        domain,
        cookieCount: g.cookieCount,
        origins: [...g.origins.entries()]
          .map(([url, count]) => ({ url, cookieCount: count }))
          .sort((a, b) => b.cookieCount - a.cookieCount)
      }))
      .sort((a, b) => b.cookieCount - a.cookieCount);
  }

  // Internal: group cookies into domain-keyed entries (level 1: cookie
  // semantics) with per-origin counts (level 2).
  //
  // Domain cookies (".baidu.com") become group keys ("baidu.com") — the site
  // declares its subdomains share login state. Host-only cookies join the
  // longest matching group key, fold into a same-key group, or form their
  // own group when no domain cookie claims them.
  //
  // rawDomains keeps the cookie domains verbatim (leading dot preserved) so
  // delete() can clear each exact value without substring-matching collateral.
  _groupCookies(cookies) {
    const groups = new Map(); // key -> { cookieCount, origins: Map, rawDomains: Set }

    const bucket = (key) => {
      let g = groups.get(key);
      if (!g) { g = { cookieCount: 0, origins: new Map(), rawDomains: new Set() }; groups.set(key, g); }
      return g;
    };
    const tally = (g, cookie) => {
      g.cookieCount += 1;
      g.rawDomains.add(cookie.domain);
      const url = this._cookieOrigin(cookie);
      g.origins.set(url, (g.origins.get(url) || 0) + 1);
    };

    // Pass 1: domain cookies (leading dot) establish shared groups.
    for (const cookie of cookies) {
      if (!cookie.domain.startsWith('.')) continue;
      tally(bucket(cookie.domain.slice(1)), cookie);
    }

    // Pass 2: host-only cookies join the longest matching shared group.
    for (const cookie of cookies) {
      if (cookie.domain.startsWith('.')) continue;
      let target = null;
      for (const key of groups.keys()) {
        if (cookie.domain.endsWith('.' + key) && (!target || key.length > target.length)) {
          target = key;
        }
      }
      if (target) {
        tally(groups.get(target), cookie);
      } else if (groups.has(cookie.domain)) {
        // Bare-domain host-only cookie alongside ".example.com" — same site.
        tally(groups.get(cookie.domain), cookie);
      } else {
        tally(bucket(cookie.domain), cookie);
      }
    }

    return groups;
  }

  /**
   * 删除指定 domain 分组的全部 cookies（组键 domain cookie + 所有子域）
   * 按组内 cookie 的原始 domain 值（保留前导点）逐个清除，
   * 不使用组键子串匹配，避免误删相似后缀域名。
   * @param {string} domain - 组键（list() 返回的 domain 字段）
   */
  async delete(domain) {
    const context = this._browserSession._context;
    if (!context) return;
    const cookies = await this._fetchCookies();
    const group = this._groupCookies(cookies).get(domain);
    if (!group) return;
    for (const raw of group.rawDomains) {
      await context.clearCookies({ domain: raw });
    }
    logger.log(`[SessionRegistry] Deleted cookie group: ${domain} (${group.rawDomains.size} domains)`);
  }

  /**
   * 验证登录态（quick 策略：仅检查 cookie 存在性）
   * @param {string} domain
   * @param {string} strategy - 'quick' | 'full' | 'custom'
   * @returns {Promise<{valid: boolean, details: object}>}
   */
  async check(domain, strategy = 'quick') {
    if (strategy === 'quick') {
      const cookies = await this._fetchCookies();
      const hasCookies = cookies.some(c => c.domain.includes(domain));
      return {
        valid: hasCookies,
        details: { strategy: 'quick', cookieFound: hasCookies }
      };
    }
    // full 和 custom 策略在后续任务中实现
    return { valid: false, details: { strategy, message: 'Not implemented' } };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/session/SessionRegistry.test.js
```

Expected: 全部通过（13 个改造后测试 + 3 个新增）。若 "splits same-host" 测试里 `sessions[0].domain` 断言失败（出现 `localhost` 与 `127.0.0.1` 两组），说明 goto 用了 `localhost`——测试统一用 `127.0.0.1`。

- [ ] **Step 5: 提交**

```bash
git add src/session/SessionRegistry.js test/session/SessionRegistry.test.js
git commit -m "feat: break session groups down into per-origin entries

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: getter 接线与 UI origins 展示

**Files:**
- Modify: `src/index.js:60-70`
- Modify: `src/public/client.html`（`renderSessions` / `visitDomain`，约 897-935 行）

**Interfaces:**
- Consumes: Task 1 的 `new SessionRegistry({ browserSession })` 与 `list()` 返回的 `origins: Array<{url, cookieCount}>`
- Produces: 前端全局函数 `visitOrigin(url)`（替代 `visitDomain`）；`checkDomain`/`deleteDomain` 不变

- [ ] **Step 1: 修改 index.js getter**

将 `src/index.js` 60-70 行：

```javascript
// SessionRegistry needs context, which is available only after browserSession.start()
// Returns a getter function to delay instantiation
function createSessionRegistryGetter({ browserSession }) {
  return {
    getRegistry: () => {
      const context = browserSession._context;
      if (!context) return null;
      return new SessionRegistry({ context });
    }
  };
}
```

替换为：

```javascript
// SessionRegistry needs context + pages with CDP sessions, available only
// after browserSession.start(). Returns a getter function to delay instantiation.
function createSessionRegistryGetter({ browserSession }) {
  return {
    getRegistry: () => {
      if (!browserSession._context || browserSession._pages.size === 0) return null;
      return new SessionRegistry({ browserSession });
    }
  };
}
```

- [ ] **Step 2: 修改 client.html**

将 `renderSessions` 内的条目模板（约 903-914 行）：

```javascript
      sessionsListEl.innerHTML = sessions.map(session => `
        <div class="session-item" data-domain="${session.domain}">
          <div>
            <div class="session-domain" onclick="visitDomain('${session.domain}')">${session.domain}</div>
            <div class="session-stats">Cookies: ${session.cookieCount || 0}${session.subDomains && session.subDomains.length ? ` · 含子域: ${session.subDomains.join(', ')}` : ''}</div>
          </div>
          <div class="session-actions">
            <button onclick="checkDomain('${session.domain}')">验证</button>
            <button class="danger" onclick="deleteDomain('${session.domain}')">删除</button>
          </div>
        </div>
      `).join('');
```

替换为：

```javascript
      sessionsListEl.innerHTML = sessions.map(session => `
        <div class="session-item" data-domain="${session.domain}">
          <div>
            <div class="session-domain">${session.domain}</div>
            <div class="session-stats">Cookies: ${session.cookieCount || 0}</div>
            ${(session.origins || []).map(o => `
              <div class="session-origin" onclick="visitOrigin('${o.url}')">${o.url} · ${o.cookieCount}</div>
            `).join('')}
          </div>
          <div class="session-actions">
            <button onclick="checkDomain('${session.domain}')">验证</button>
            <button class="danger" onclick="deleteDomain('${session.domain}')">删除</button>
          </div>
        </div>
      `).join('');
```

将 `visitDomain` 函数（约 917-932 行）整体替换为：

```javascript
    function visitOrigin(url) {
      // Switch to webrtc panel and navigate to the recorded origin URL
      // (scheme + port come from the cookie's sourcePort/sourceScheme).
      switchPanel('webrtc');
      urlInput.value = url;
      goBtn.click();
    }
```

将 `deleteDomain` 的 confirm（约 945 行）：

```javascript
      if (!confirm(`确定删除 ${domain} 的登录状态吗？`)) {
```

替换为：

```javascript
      if (!confirm(`确定删除 ${domain} 的登录状态吗？（含该域名下所有服务）`)) {
```

文件末尾的全局导出（约 979-981 行）：

```javascript
    window.visitDomain = visitDomain;
```

替换为：

```javascript
    window.visitOrigin = visitOrigin;
```

在 `<style>` 中 `session-stats` 规则后追加（找到现有 `.session-stats` 选择器位置，样式风格与之一致）：

```css
      .session-origin {
        color: #64ffda;
        font-size: 12px;
        margin-top: 2px;
        cursor: pointer;
      }
      .session-origin:hover {
        text-decoration: underline;
      }
```

- [ ] **Step 3: 运行全部相关测试**

```bash
node --test test/session/SessionRegistry.test.js test/routes/api/sessions.test.js
```

Expected: 16 通过（13 + 3 route 测试，route 测试用 mock registry 不受影响）

- [ ] **Step 4: 手动验证**

```bash
npm start
```

浏览器打开 http://localhost:8080/ → 登录 → “远程访问浏览器”面板访问两个不同端口的服务（如 http://localhost:8080 与任一其他本地服务）→ 切到“登录状态管理”→ 刷新 → 确认 `localhost` 条目下逐行显示两个 origin（含端口），点击各行跳转到对应完整 URL。

- [ ] **Step 5: 提交**

```bash
git add src/index.js src/public/client.html
git commit -m "feat: show per-origin entries in sessions UI

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- [x] §2/§3 sourcePort 读取与 origin 构造 → Task 1 `_fetchCookies()` / `_cookieOrigin()`
- [x] §4 两级分组 + origins 降序 + subDomains 删除 → Task 1 `list()` / `_groupCookies()`
- [x] §4 delete 不动（仍 Playwright clearCookies + rawDomains）→ Task 1 `delete()`
- [x] §5 UI origins 列表 + visitOrigin + confirm 提示 → Task 2
- [x] §6 构造参数改 browserSession、getter 改接线 → Task 1 / Task 2 Step 1
- [x] §8 测试矩阵（同域分端口 / 默认端口省略 / Secure 映射 / 现有分组删除用例）→ Task 1 测试

**2. Placeholder scan:** 无 TBD/TODO；所有代码块完整。

**3. Type consistency:** `_groupCookies` 返回 `{cookieCount, origins: Map<url, count>, rawDomains: Set}`，`list()` 消费 spread 成 `origins: Array<{url, cookieCount}>`，Task 2 UI 消费 `o.url`/`o.cookieCount`，一致；`visitOrigin(url)` 定义与 `window.visitOrigin` 导出、模板 onclick 三处一致。

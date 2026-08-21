# 登录状态自定义检测 URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持为 group 根域名和单域名设置自定义 full check URL，持久化到磁盘，验证时按优先级链选取。

**Architecture:** `SessionRegistry` 内置 `_checkUrls: Map<domain, url>` 配置层，JSON 文件持久化（原子写）；`_doFullCheck` 的 URL 优先级链插入第 2 级（用户配置）；3 个 REST 端点做 CRUD；UI 加 ⚙ 弹窗和组头验证按钮。

**Tech Stack:** Node ESM、`node:fs/promises` + `node:path`、Hono、`node --test`。

**Spec:** `docs/superpowers/specs/2026-08-22-session-check-url-design.md`

## Global Constraints

- ESM，import 带 `.js` 扩展名，无构建步骤
- 运行时依赖仅 4 个：`playwright`、`ws`、`hono`、`@hono/node-server`，不得新增（`node:fs/promises`/`node:path` 是标准库，允许）
- 日志只记关键控制点，格式 `[Module] message`，无 debug 日志
- 测试用 `node --test`（单独跑：`node --test test/session/SessionRegistry.test.js`）；改 `process.env` 的测试必须 `finally` 清理
- URL 优先级链（`_doFullCheck`）：① API 显式 `checkUrl` → ② `_checkUrls.get(domain)` → ③ `_pickCheckUrl(group)` 最大 origin → ④ `https://${domain}` 兜底
- 存储文件：`browser-data/session-check-urls.json`；user-data-dir 设置时取其父目录下的 `browser-data/`（即 `path.dirname(userDataDir)/browser-data/session-check-urls.json`），未设置时项目根下 `browser-data/`（`process.cwd()/browser-data/...`）。写盘原子化：先写 `<file>.tmp` 再 `rename`
- PUT 校验：URL 必须以 `http://` 或 `https://` 开头，否则 400；空串等同 DELETE
- check-url 端点不依赖浏览器运行（无 503 分支、不调 `ensureBrowserStarted`）
- 配置 key 无需存在于 cookie 分组（group 根域名没有 cookie 条目）

---

### Task 1: SessionRegistry 配置层（Map + 磁盘持久化 + 优先级）

**Files:**
- Modify: `src/session/SessionRegistry.js`（imports、constructor、新方法、`_doFullCheck` 优先级链）
- Test: `test/session/SessionRegistry.test.js`（追加）

**Interfaces:**
- Consumes: `this._browserSession._userDataDir`（BrowserSession constructor 已存 `userDataDir` 到 `this._userDataDir`，string|null）
- Produces:
  - `constructor({ browserSession })` — 不改签名；内部初始化 `this._checkUrls: Map<string,string>` 并同步调用 `this._loadCheckUrls()`
  - `getCheckUrl(domain) → string|null`
  - `async setCheckUrl(domain, url) → Promise<void>`（写 Map + 原子写盘）
  - `async clearCheckUrl(domain) → Promise<void>`（删 Map + 写盘）
  - `this._checkUrlsFile: string`（测试观察/注入用）

- [ ] **Step 1: Write the failing tests**

追加到 `test/session/SessionRegistry.test.js`（顶部已有 `test`/`strictEqual`/`ok` 导入；需补 `import { mkdtemp, rm, writeFile, readFile, chmod } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import path from 'node:path';`，并 `import { SessionRegistry } from '../../src/session/SessionRegistry.js';`——该 import 已存在则不重复）:

```js
// ===== custom check URL =====

// Stub browserSession whose _userDataDir points at a temp dir — config file
// lives at <tmp>/browser-data/session-check-urls.json.
async function makeConfigRegistry(userDataDir) {
  const browserSession = {
    _context: null,
    _pages: new Map(),
    _userDataDir: userDataDir,
  };
  return new SessionRegistry({ browserSession });
}

test('SessionRegistry check-url config: default null, set/get roundtrip, persisted', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'checkurl-'));
  try {
    const registry = await makeConfigRegistry(path.join(tmp, 'profile'));
    strictEqual(registry.getCheckUrl('baidu.com'), null, 'unset → null');

    await registry.setCheckUrl('baidu.com', 'https://www.baidu.com');
    strictEqual(registry.getCheckUrl('baidu.com'), 'https://www.baidu.com');

    // Persisted: a fresh registry over the same userDataDir sees it
    const registry2 = await makeConfigRegistry(path.join(tmp, 'profile'));
    strictEqual(registry2.getCheckUrl('baidu.com'), 'https://www.baidu.com');

    await registry.clearCheckUrl('baidu.com');
    strictEqual(registry.getCheckUrl('baidu.com'), null);
    const registry3 = await makeConfigRegistry(path.join(tmp, 'profile'));
    strictEqual(registry3.getCheckUrl('baidu.com'), null, 'clear persisted');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('SessionRegistry check-url config: null userDataDir falls back to cwd browser-data', async () => {
  // _checkUrlsFile derives from process.cwd() when no userDataDir — assert
  // the path shape only, do not touch the real file.
  const registry = await makeConfigRegistry(null);
  ok(registry._checkUrlsFile.endsWith('browser-data/session-check-urls.json'),
    `unexpected path: ${registry._checkUrlsFile}`);
});

test('SessionRegistry check-url config: corrupt file loads as empty', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'checkurl-'));
  try {
    const dataDir = path.join(tmp, 'browser-data');
    await import('node:fs/promises').then(fs => fs.mkdir(dataDir, { recursive: true }));
    await writeFile(path.join(dataDir, 'session-check-urls.json'), '{not json');
    const registry = await makeConfigRegistry(path.join(tmp, 'profile'));
    strictEqual(registry.getCheckUrl('anything.com'), null, 'corrupt → empty map');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('SessionRegistry full check prefers configured URL over auto-pick', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'checkurl-'));
  const navs = [];
  const browserSession = {
    _context: { cookies: async () => [
      { name: 'a', value: '1', domain: '127.0.0.1', path: '/' },
      { name: 'b', value: '2', domain: '127.0.0.1', path: '/' },
    ] },
    _pages: new Map([[1, { cdp: { send: async () => ({ cookies: [
      { name: 'a', value: '1', domain: '127.0.0.1', path: '/', sourcePort: 8080, sourceScheme: 'NonSecure' },
      { name: 'b', value: '2', domain: '127.0.0.1', path: '/', sourcePort: 9090, sourceScheme: 'NonSecure' },
    ] }) } }]]),
    _userDataDir: path.join(tmp, 'profile'),
    openHiddenPage: async () => ({ goto: async () => {}, $: async () => null, url: () => 'https://example.com/x', close: async () => {} }),
    closeHiddenPage: async (p) => { await p.close(); navs.push('closed'); },
  };
  try {
    const registry = new SessionRegistry({ browserSession });
    await registry.setCheckUrl('127.0.0.1', 'https://configured.example/probes');
    let wentTo = null;
    browserSession.openHiddenPage = async () => ({
      goto: async (u) => { wentTo = u; },
      $: async () => null,
      url: () => 'https://configured.example/probes',
      close: async () => {},
    });
    await registry.check('127.0.0.1', 'full');
    strictEqual(wentTo, 'https://configured.example/probes', 'configured URL wins over origin pick');
    strictEqual(navs.length >= 1, true, 'page closed');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/session/SessionRegistry.test.js`
Expected: FAIL — `registry.getCheckUrl is not a function`

- [ ] **Step 3: Implement**

`src/session/SessionRegistry.js` 顶部 imports 补：

```js
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
```

constructor 末尾（`this._lastCheckAt = new Map();` 之后）加：

```js
    this._checkUrls = new Map();      // domain → user-configured check URL
    this._checkUrlsFile = this._deriveCheckUrlsFile();
    this._loadCheckUrls();
```

类内新增方法（放在 `check()` 之前，与 `_recordCheck` 相邻区域）：

```js
  // Internal: config file path — sibling browser-data/ of the profile dir,
  // else cwd browser-data/. The profile dir itself is Chromium-owned and may
  // be wiped by the browser, so the config lives one level up.
  _deriveCheckUrlsFile() {
    const userDataDir = this._browserSession._userDataDir;
    const base = userDataDir ? path.dirname(userDataDir) : process.cwd();
    return path.join(base, 'browser-data', 'session-check-urls.json');
  }

  // Internal: read config into _checkUrls. Missing file → empty. Corrupt →
  // empty + one log line (config is user-fixable, don't crash the registry).
  _loadCheckUrls() {
    readFile(this._checkUrlsFile, 'utf8')
      .then(text => {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof k === 'string' && typeof v === 'string') this._checkUrls.set(k, v);
          }
        }
      })
      .catch(() => { /* missing or corrupt: start empty */ });
  }

  // Public config API — GET/PUT/DELETE /api/sessions/:domain/check-url back onto these.
  getCheckUrl(domain) {
    return this._checkUrls.get(domain) ?? null;
  }

  async setCheckUrl(domain, url) {
    this._checkUrls.set(domain, url);
    await this._persistCheckUrls();
    logger.log(`[SessionRegistry] Check URL set: ${domain} → ${url}`);
  }

  async clearCheckUrl(domain) {
    this._checkUrls.delete(domain);
    await this._persistCheckUrls();
    logger.log(`[SessionRegistry] Check URL cleared: ${domain}`);
  }

  // Internal: atomic write — tmp file + rename, so a crash mid-write never
  // leaves a half-written config behind.
  async _persistCheckUrls() {
    const file = this._checkUrlsFile;
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this._checkUrls), null, 2));
    await rename(tmp, file);
  }
```

`_doFullCheck` 内 URL 选择行（现有 `const checkUrl = overrideUrl ?? this._pickCheckUrl(group, domain);`）改为：

```js
    const checkUrl = overrideUrl
      ?? this._checkUrls.get(domain)
      ?? this._pickCheckUrl(group, domain);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/session/SessionRegistry.test.js`
Expected: all PASS（含原有 URL 选择用例——未配置时走第 3 级，行为不变）

- [ ] **Step 5: Commit**

```bash
git add src/session/SessionRegistry.js test/session/SessionRegistry.test.js
git commit -m "Add check URL config layer with disk persistence"
```

---

### Task 2: check-url REST 端点

**Files:**
- Modify: `src/routes/api/sessions.js`（新增 3 端点）
- Test: `test/routes/api/sessions.test.js`（追加）

**Interfaces:**
- Consumes: Task 1 的 `registry.getCheckUrl(domain)` / `registry.setCheckUrl(domain, url)` / `registry.clearCheckUrl(domain)`
- Produces:
  - `GET /api/sessions/:domain/check-url` → `{ url: string|null }`
  - `PUT /api/sessions/:domain/check-url`（body `{ url }`）→ `{ success: true, url }`；非法 URL → 400 `{ error }`；空串 → 走 DELETE 语义返回 `{ success: true, url: null }`
  - `DELETE /api/sessions/:domain/check-url` → `{ success: true }`
  - 三个端点均**不**走 `ensureBrowserStarted`/503 分支——registry 为 null 时也必须可配置。route 工厂因此新增懒建兜底：`getSessionRegistry()` 为 null 时 `new SessionRegistry` 不可行（route 层拿不到 browserSession）——改为由 `src/index.js` 在 getter 外再包一层：**getter 始终返回 registry 实例**（浏览器未运行时也返回，`_fetchCookies` 等 ctx 为 null 的路径自然降级）。见 Step 3 的 index.js 改动。

- [ ] **Step 1: Write the failing tests**

追加到 `test/routes/api/sessions.test.js`：

```js
test('GET /api/sessions/:domain/check-url returns null when unset', async () => {
  const registry = { getCheckUrl: () => null };
  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({
    getSessionRegistry: () => registry,
    ensureBrowserStarted: async () => {}
  }));

  const res = await app.request('/api/sessions/example.com/check-url');
  strictEqual(res.status, 200);
  strictEqual((await res.json()).url, null);
});

test('PUT /api/sessions/:domain/check-url saves and rejects bad URLs', async () => {
  const saved = {};
  const registry = {
    getCheckUrl: (d) => saved[d] ?? null,
    setCheckUrl: async (d, u) => { saved[d] = u; },
    clearCheckUrl: async (d) => { delete saved[d]; },
  };
  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({
    getSessionRegistry: () => registry,
    ensureBrowserStarted: async () => {}
  }));

  // Valid
  let res = await app.request('/api/sessions/example.com/check-url', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/profile' })
  });
  strictEqual(res.status, 200);
  strictEqual((await res.json()).url, 'https://example.com/profile');

  // Bad scheme → 400
  res = await app.request('/api/sessions/example.com/check-url', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'example.com' })
  });
  strictEqual(res.status, 400);

  // Empty string → delete semantics
  res = await app.request('/api/sessions/example.com/check-url', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: '' })
  });
  strictEqual(res.status, 200);
  strictEqual((await res.json()).url, null);
  strictEqual(saved['example.com'], undefined);
});

test('DELETE /api/sessions/:domain/check-url clears config without browser', async () => {
  let cleared = null;
  const registry = {
    getCheckUrl: () => 'https://x',
    setCheckUrl: async () => {},
    clearCheckUrl: async (d) => { cleared = d; },
  };
  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({
    getSessionRegistry: () => registry,
    ensureBrowserStarted: async () => {}
  }));

  const res = await app.request('/api/sessions/example.com/check-url', { method: 'DELETE' });
  strictEqual(res.status, 200);
  strictEqual(cleared, 'example.com');
  strictEqual((await res.json()).success, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/routes/api/sessions.test.js`
Expected: FAIL — 404（路由不存在）

- [ ] **Step 3: Implement**

`src/routes/api/sessions.js` 在 `/:domain/visit` 路由之前插入：

```js
  // 自定义检测 URL 配置（不依赖浏览器运行）
  app.get('/:domain/check-url', async (c) => {
    const sessionRegistry = getSessionRegistry();
    if (!sessionRegistry) return c.json({ url: null });
    return c.json({ url: sessionRegistry.getCheckUrl(c.req.param('domain')) });
  });

  app.put('/:domain/check-url', async (c) => {
    const sessionRegistry = getSessionRegistry();
    if (!sessionRegistry) return c.json({ error: 'Session registry not available' }, 503);
    const domain = c.req.param('domain');
    const body = await c.req.json().catch(() => ({}));
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (url === '') {
      await sessionRegistry.clearCheckUrl(domain);
      return c.json({ success: true, url: null });
    }
    if (!/^https?:\/\//.test(url)) {
      return c.json({ error: 'URL must start with http:// or https://' }, 400);
    }
    await sessionRegistry.setCheckUrl(domain, url);
    return c.json({ success: true, url });
  });

  app.delete('/:domain/check-url', async (c) => {
    const sessionRegistry = getSessionRegistry();
    if (!sessionRegistry) return c.json({ error: 'Session registry not available' }, 503);
    await sessionRegistry.clearCheckUrl(c.req.param('domain'));
    return c.json({ success: true });
  });
```

**Hono 路由顺序注意**：`/:domain/check-url` 必须注册在 `/:domain/cookies/:name` 等**之前或之后均可**（路径段数不同无冲突），但**必须在 `/:domain/check` 之前不必要**——`check-url` 与 `check` 是不同字面量，无遮蔽。保持插入位置在 visit 前即可。

`src/index.js` 的 `createSessionRegistryGetter` 改为**始终返回单例**（浏览器未运行也返回实例——配置层不依赖浏览器；cookie 相关方法自行降级）：

```js
function createSessionRegistryGetter({ browserSession }) {
  const registry = new SessionRegistry({ browserSession });
  return {
    // Always return the instance: config endpoints work without a browser;
    // cookie paths inside SessionRegistry already degrade on null _context.
    getRegistry: () => registry
  };
}
```

`_fetchCookies` 在 `_context` null 时返回 `[]`、`_doFullCheck` 返回 `browser-not-running`，行为自洽。副作用：浏览器未运行时 GET `/api/sessions`（列表）拿到空列表而非 503，前端显示「暂无保存的登录状态」——**接受的降级**（此前是 503 提示重启）。此变更同时满足 a31fca0 已引入的单例复用（那个版本在浏览器停止后仍返回旧实例；本版本语义更明确：单例永生）。GET `/` 里现有 `ensureBrowserStarted` 分支保留不动（getter 不再返回 null，该分支自然失活，不删以免 route 测试 mock 行为变化）。

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/routes/api/sessions.test.js`
Expected: all PASS（含原有 6+3 个用例——`POST /:domain/check starts browser` 用例的 mock getter 行为不变）

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/sessions.js src/index.js test/routes/api/sessions.test.js
git commit -m "Add check-url REST endpoints with always-on registry"
```

---

### Task 3: UI ⚙ 弹窗 + 组头验证

**Files:**
- Modify: `src/public/client.html`（⚙ 按钮、弹窗、组头验证按钮、配置标记）

**Interfaces:**
- Consumes: Task 2 的 3 个端点；现有 `checkDomain(domain, btn)`、`loadSessions()`、`showToast()`
- Produces: 页面内函数 `openCheckUrlDialog(domain)` / `closeCheckUrlDialog()` / `saveCheckUrl()` / `clearCheckUrlConfig()` / `checkGroupFromHeader(root, btn)`；`window.*` 暴露同名

**说明**: client.html 无 JS 单测；验证为 `node --test` 全量回归 + 手动验收。

- [ ] **Step 1: Add dialog CSS**

`.session-subitem .session-domain` 规则后追加：

```css
    .checkurl-dialog-overlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.4);
      display: flex; align-items: center; justify-content: center;
      z-index: 1500;
    }
    .checkurl-dialog {
      background: #fff; border-radius: 8px; padding: 20px;
      width: 400px; max-width: 90vw;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    }
    .checkurl-dialog h4 { margin: 0 0 8px; font-size: 15px; color: #2c3e50; }
    .checkurl-dialog p { margin: 0 0 12px; font-size: 12px; color: #8892b0; }
    .checkurl-dialog input {
      width: 100%; box-sizing: border-box; padding: 8px 10px;
      border: 1px solid #d9d9d9; border-radius: 4px; font-size: 13px;
      margin-bottom: 16px;
    }
    .checkurl-dialog .dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .config-mark { font-size: 11px; color: #8892b0; cursor: help; margin-left: 4px; }
```

- [ ] **Step 2: Add dialog open/close/save/clear functions**

`toggleSessionGroup` 函数后追加：

```js
    let checkUrlDialogDomain = null;

    function openCheckUrlDialog(domain) {
      checkUrlDialogDomain = domain;
      const overlay = document.createElement('div');
      overlay.className = 'checkurl-dialog-overlay';
      overlay.id = 'checkurl-dialog';
      overlay.onclick = (e) => { if (e.target === overlay) closeCheckUrlDialog(); };
      overlay.innerHTML = `
        <div class="checkurl-dialog">
          <h4>${domain} 检测 URL</h4>
          <p>留空使用自动选择（按 cookie 数最多的来源）</p>
          <input type="text" id="checkurl-input" placeholder="https://...">
          <div class="dialog-actions">
            <button onclick="clearCheckUrlConfig()">清除</button>
            <button onclick="saveCheckUrl()">保存</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      fetch(`/api/sessions/${encodeURIComponent(domain)}/check-url`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
        .then(r => r.json())
        .then(({ url }) => {
          document.getElementById('checkurl-input').value = url || '';
        })
        .catch(() => {});
      document.getElementById('checkurl-input').focus();
    }

    function closeCheckUrlDialog() {
      document.getElementById('checkurl-dialog')?.remove();
      checkUrlDialogDomain = null;
    }

    async function saveCheckUrl() {
      const url = document.getElementById('checkurl-input').value.trim();
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(checkUrlDialogDomain)}/check-url`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        closeCheckUrlDialog();
        showToast('检测 URL 已保存', 'success');
        loadSessions();
      } catch (err) {
        console.error('[Sessions] Save check URL failed:', err);
        showToast('保存失败（需以 http(s):// 开头）', 'error');
      }
    }

    async function clearCheckUrlConfig() {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(checkUrlDialogDomain)}/check-url`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        closeCheckUrlDialog();
        showToast('检测 URL 已清除', 'success');
        loadSessions();
      } catch (err) {
        console.error('[Sessions] Clear check URL failed:', err);
        showToast('清除失败', 'error');
      }
    }
```

- [ ] **Step 3: Wire ⚙ buttons and group verify**

`renderSessionItem()` 的 actions 区加（「详情」按钮前）：

```html
            <button onclick="openCheckUrlDialog('${session.domain}')">⚙</button>
```

`renderSessionGroup()` 的组头改为（header 行右侧追加按钮组，header 的 onclick 保持折叠切换，按钮用 stopPropagation）：

```html
          <div class="session-group-header" onclick="toggleSessionGroup('${root}')">
            <span class="session-group-arrow">${expanded ? '▼' : '▶'}</span>
            <span class="session-group-domain">${root}</span>
            <span class="session-group-count">${items.length} 个服务 · ${totalCookies} cookies</span>
            <span onclick="event.stopPropagation()">
              <button onclick="checkGroupFromHeader('${root}', this)">验证</button>
              <button onclick="openCheckUrlDialog('${root}')">⚙</button>
            </span>
          </div>
```

`renderStatusLine` 后追加组头验证函数（与 `checkDomain` 相同流程，toast 前缀带域名）：

```js
    async function checkGroupFromHeader(root, btn) {
      if (btn) { btn.disabled = true; btn.textContent = '验证中…'; }
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(root)}/check`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        await loadSessions();
        if (result.valid === true) showToast(`${root}: 已登录`, 'success');
        else if (result.valid === false) showToast(`${root}: 未登录`, 'error');
        else showToast(`${root}: 未知状态`, 'warning');
      } catch (err) {
        console.error('[Sessions] Group check failed:', err);
        showToast('验证失败', 'error');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '验证'; }
      }
    }
```

`window.*` 暴露区追加：

```js
    window.openCheckUrlDialog = openCheckUrlDialog;
    window.closeCheckUrlDialog = closeCheckUrlDialog;
    window.saveCheckUrl = saveCheckUrl;
    window.clearCheckUrlConfig = clearCheckUrlConfig;
    window.checkGroupFromHeader = checkGroupFromHeader;
```

- [ ] **Step 4: Regression + manual smoke**

Run: `node --test "test/routes/**/*.test.js" "test/session/**/*.test.js" "test/auth/**/*.test.js"`
Expected: all PASS

手动验收（需用户配合）：`npm start` → 登录状态面板 → 单条目 ⚙ 设 URL → 验证走该 URL；组头 ⚙ 设 `baidu.com` → 组头验证 → 组头出现徽章 + toast。

- [ ] **Step 5: Commit**

```bash
git add src/public/client.html
git commit -m "Add check URL config dialog and group verify button"
```

---

### Task 4: 全量回归 + spec 对照

- [ ] **Step 1: Full suite**

Run: `node --test "test/**/*.test.js"`
Expected: 0 fail

- [ ] **Step 2: Spec 对照**

| Spec 条目 | 实现 |
|------|------|
| 单域名设置/清除 URL | Task 1 `setCheckUrl`/`clearCheckUrl` + Task 3 ⚙ |
| group 根域名设置 URL | Task 3 组头 ⚙（key 为根域名） |
| 组级单次检查 | Task 3 `checkGroupFromHeader` → `check(root, 'full')`，Task 1 优先级第 2 级命中 |
| 结果记组级 | `_recordCheck(root)` 现有行为，`list()` 子条目不含（key 不同） |
| 持久化 | Task 1 磁盘 JSON + 原子写 + 测试 |
| 未配置不变 | Task 1 Step 4 原有用例回归 |
| PUT 400/空串=DELETE | Task 2 测试 |
| 不依赖浏览器 | Task 2 getter 改单例无条件返回 |

缺口 → 补实现再回归。

- [ ] **Step 3: Final commit（如有收尾）**

```bash
git add -A && git commit -m "Polish check URL config per spec review"
```

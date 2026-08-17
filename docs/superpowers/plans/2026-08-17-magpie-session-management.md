# magpie 登录状态管理实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 magpie web admin 中添加登录状态管理面板，支持查看、删除、验证已保存的登录态。

**Architecture:** 新增 SessionRegistry 模块通过 Playwright API 管理 browser-data 中的 cookies，新增 REST API 端点供前端调用，前端在 client.html 中添加管理面板。

**Tech Stack:** Playwright API (context.cookies, clearCookies), Hono REST API, Vanilla JS frontend

## Global Constraints

- 运行时依赖：仅 playwright, ws, hono, @hono/node-server
- ESM 模块，显式 `.js` 扩展名
- 日志格式：`[Module] message`
- 代码风格：`_` 前缀表示私有字段

---

## File Structure

| 文件 | 职责 |
|------|------|
| `src/session/SessionRegistry.js` | 核心模块：获取列表、删除、验证登录态 |
| `src/routes/api/sessions.js` | REST API：GET/DELETE/POST 端点 |
| `src/app.js` | 注册新路由 |
| `src/index.js` | 初始化 SessionRegistry 实例 |
| `src/public/client.html` | 添加管理面板 UI |

---

### Task 1: 创建 SessionRegistry 模块

**Files:**
- Create: `src/session/SessionRegistry.js`
- Test: `test/session/test-SessionRegistry.js`

**Interfaces:**
- Consumes: `BrowserSession` 实例（通过构造函数注入）
- Produces: `list()` 返回 `[{domain, cookieCount}]`, `delete(domain)`, `check(domain, strategy)`

- [ ] **Step 1: 创建测试文件**

```javascript
// test/session/test-SessionRegistry.js
import { test } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { chromium } from 'playwright';
import { SessionRegistry } from '../../src/session/SessionRegistry.js';

test('SessionRegistry.list returns empty array when no cookies', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  const registry = new SessionRegistry({ context });
  const sessions = await registry.list();

  strictEqual(sessions.length, 0);

  await context.close();
  await browser.close();
});

test('SessionRegistry.list groups cookies by domain', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Add cookies
  await context.addCookies([
    { name: 'session1', value: 'a', domain: 'example.com', path: '/' },
    { name: 'session2', value: 'b', domain: 'example.com', path: '/' },
    { name: 'session3', value: 'c', domain: 'other.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  const sessions = await registry.list();

  strictEqual(sessions.length, 2);
  const example = sessions.find(s => s.domain === 'example.com');
  ok(example);
  strictEqual(example.cookieCount, 2);

  await context.close();
  await browser.close();
});

test('SessionRegistry.delete removes cookies for domain', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  await context.addCookies([
    { name: 'session', value: 'x', domain: 'example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  await registry.delete('example.com');

  const cookies = await context.cookies();
  strictEqual(cookies.length, 0);

  await context.close();
  await browser.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/session/test-SessionRegistry.js
```

Expected: 失败，提示模块不存在

- [ ] **Step 3: 创建 SessionRegistry 模块**

```javascript
// src/session/SessionRegistry.js
import console from '../utils/logger.js';

/**
 * SessionRegistry - 管理已保存的登录状态
 *
 * 通过 Playwright API 获取/删除 cookies
 */
export class SessionRegistry {
  constructor({ context }) {
    this._context = context;
  }

  /**
   * 获取所有 domain 及其 cookie 数量
   * @returns {Promise<Array<{domain: string, cookieCount: number}>>}
   */
  async list() {
    if (!this._context) return [];

    const cookies = await this._context.cookies();
    const domainMap = new Map();

    for (const cookie of cookies) {
      // 去掉前导点
      const domain = cookie.domain.replace(/^\./, '');
      domainMap.set(domain, (domainMap.get(domain) || 0) + 1);
    }

    return [...domainMap.entries()]
      .map(([domain, cookieCount]) => ({ domain, cookieCount }))
      .sort((a, b) => b.cookieCount - a.cookieCount);
  }

  /**
   * 删除指定 domain 的所有 cookies
   * @param {string} domain
   */
  async delete(domain) {
    if (!this._context) return;
    await this._context.clearCookies({ domain });
    console.log(`[SessionRegistry] Deleted cookies for domain: ${domain}`);
  }

  /**
   * 验证登录态（quick 策略：仅检查 cookie 存在性）
   * @param {string} domain
   * @param {string} strategy - 'quick' | 'full' | 'custom'
   * @returns {Promise<{valid: boolean, details: object}>}
   */
  async check(domain, strategy = 'quick') {
    if (strategy === 'quick') {
      const cookies = await this._context.cookies();
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

- [ ] **Step 4: 创建 session 目录**

```bash
mkdir -p src/session
```

- [ ] **Step 5: 运行测试确认通过**

```bash
node --test test/session/test-SessionRegistry.js
```

Expected: 所有测试通过

- [ ] **Step 6: 提交**

```bash
git add src/session/SessionRegistry.js test/session/test-SessionRegistry.js
git commit -m "feat: add SessionRegistry module for login state management

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 创建 REST API 路由

**Files:**
- Create: `src/routes/api/sessions.js`
- Test: `test/routes/api/test-sessions.js`

**Interfaces:**
- Consumes: `SessionRegistry` 实例
- Produces: GET `/api/sessions`, DELETE `/api/sessions/:domain`, POST `/api/sessions/:domain/check`

- [ ] **Step 1: 创建测试文件**

```javascript
// test/routes/api/test-sessions.js
import { test } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { Hono } from 'hono';
import { createSessionsRoute } from '../../../src/routes/api/sessions.js';

test('GET /api/sessions returns sessions list', async () => {
  const registry = {
    list: async () => [{ domain: 'example.com', cookieCount: 2 }]
  };

  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({ sessionRegistry: registry }));

  const res = await app.request('/api/sessions');
  strictEqual(res.status, 200);

  const data = await res.json();
  ok(Array.isArray(data.sessions));
  strictEqual(data.sessions[0].domain, 'example.com');
});

test('DELETE /api/sessions/:domain calls registry.delete', async () => {
  let deleted = false;
  const registry = {
    delete: async (domain) => {
      strictEqual(domain, 'example.com');
      deleted = true;
    }
  };

  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({ sessionRegistry: registry }));

  const res = await app.request('/api/sessions/example.com', { method: 'DELETE' });
  strictEqual(res.status, 200);
  ok(deleted);

  const data = await res.json();
  strictEqual(data.success, true);
});

test('POST /api/sessions/:domain/check returns validation result', async () => {
  const registry = {
    check: async (domain, strategy) => {
      strictEqual(domain, 'example.com');
      return { valid: true, details: { strategy } };
    }
  };

  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({ sessionRegistry: registry }));

  const res = await app.request('/api/sessions/example.com/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy: 'quick' })
  });
  strictEqual(res.status, 200);

  const data = await res.json();
  strictEqual(data.valid, true);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/routes/api/test-sessions.js
```

Expected: 失败，提示模块不存在

- [ ] **Step 3: 创建 sessions 路由**

```javascript
// src/routes/api/sessions.js
import { Hono } from 'hono';

/**
 * 创建 sessions REST API 路由
 * @param {Object} deps - 依赖
 * @param {SessionRegistry} deps.sessionRegistry - SessionRegistry 实例
 */
export function createSessionsRoute({ sessionRegistry }) {
  const app = new Hono();

  // 获取已保存的登录态列表
  app.get('/', async (c) => {
    const sessions = await sessionRegistry.list();
    return c.json({ sessions });
  });

  // 删除指定 domain 的 cookies
  app.delete('/:domain', async (c) => {
    const domain = c.req.param('domain');
    await sessionRegistry.delete(domain);
    return c.json({ success: true });
  });

  // 验证登录态
  app.post('/:domain/check', async (c) => {
    const domain = c.req.param('domain');
    const body = await c.req.json().catch(() => ({}));
    const strategy = body.strategy || 'quick';
    const result = await sessionRegistry.check(domain, strategy);
    return c.json(result);
  });

  // 访问该网站（在远程浏览器中打开）
  app.post('/:domain/visit', async (c) => {
    const domain = c.req.param('domain');
    // 由 SessionHandler 处理导航
    return c.json({ success: true, url: `https://${domain}` });
  });

  return app;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/routes/api/test-sessions.js
```

Expected: 所有测试通过

- [ ] **Step 5: 提交**

```bash
git add src/routes/api/sessions.js test/routes/api/test-sessions.js
git commit -m "feat: add sessions REST API routes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 注册路由并初始化 SessionRegistry

**Files:**
- Modify: `src/app.js`
- Modify: `src/index.js`

**Interfaces:**
- Consumes: `SessionRegistry` 类
- Produces: 在 `createApp` 中注册 `/api/sessions` 路由

- [ ] **Step 1: 修改 app.js 注册路由**

找到 `createApp` 函数，在 `// Protected routes` 注释后添加 sessions 路由：

```javascript
// 在 src/app.js 中，找到 createApp 函数

// 在函数参数中添加 sessionRegistry
export function createApp({ streamerPeer, sessionHandler, wsManager, env, sessionRegistry }) {
  const app = new Hono();

  // ... 现有代码 ...

  // Protected routes (auth required)
  app.use('/*', requireAuth());

  // Mount protected HTTP routes
  app.route('/', staticApp);

  // 新增：sessions API 路由
  if (sessionRegistry) {
    const { createSessionsRoute } = await import('./routes/api/sessions.js');
    app.route('/api/sessions', createSessionsRoute({ sessionRegistry }));
  }

  // ... 后续代码 ...
}
```

- [ ] **Step 2: 修改 index.js 初始化 SessionRegistry**

在 `createBrowserSession` 函数后添加：

```javascript
// 在 src/index.js 中

// 在 createBrowserSession 函数定义之后添加：

function createSessionRegistry({ browserSession }) {
  // SessionRegistry 需要 context，在 browserSession.start() 之后才能获取
  // 这里返回一个 getter 函数
  return {
    getRegistry: () => {
      const context = browserSession._context;
      if (!context) return null;
      return new SessionRegistry({ context });
    }
  };
}
```

然后在 `main()` 函数中：

```javascript
// 在 main() 函数中，createApp 调用之前添加：

// Create SessionRegistry
import { SessionRegistry } from "./session/SessionRegistry.js";
const sessionRegistryGetter = createSessionRegistry({ browserSession });

// 修改 createApp 调用，传入 sessionRegistry
const { app, wsRoutes } = createApp({
  streamerPeer,
  sessionHandler,
  wsManager,
  env: cfg.auth,
  sessionRegistry: sessionRegistryGetter.getRegistry()
});
```

注意：由于 `SessionRegistry` 需要 `context`，而 `context` 在 `browserSession.start()` 之后才可用，所以需要延迟获取。

- [ ] **Step 3: 更新 app.js 导入语句**

在 `src/app.js` 顶部不需要静态导入 `sessions.js`，因为我们在运行时动态导入。

- [ ] **Step 4: 更新 index.js 导入语句**

在 `src/index.js` 顶部添加：

```javascript
import { SessionRegistry } from "./session/SessionRegistry.js";
```

- [ ] **Step 5: 提交**

```bash
git add src/app.js src/index.js
git commit -m "feat: integrate SessionRegistry into app

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 添加前端管理面板 UI

**Files:**
- Modify: `src/public/client.html`

**Interfaces:**
- Consumes: `/api/sessions` REST API
- Produces: 可视化的登录状态管理界面

- [ ] **Step 1: 在左侧导航添加新入口**

在 `client.html` 中找到 `.nav-list` 区域，在"远程访问浏览器"后添加：

```html
<!-- 在 <div class="nav-item" data-panel="webrtc"> ... </div> 之后添加 -->
<div class="nav-item" data-panel="sessions">
  <span class="nav-icon">🔐</span>
  <span class="nav-text">登录状态管理</span>
</div>
```

- [ ] **Step 2: 添加 sessions-panel 面板**

在 `</div><!-- webrtc-panel -->` 之后添加：

```html
<!-- 登录状态管理面板 -->
<div id="sessions-panel" class="panel">
  <div class="page-header">
    <div class="page-title">登录状态管理</div>
  </div>
  <div class="sessions-toolbar" style="padding: 12px; background: #fff; border-bottom: 1px solid #e8e8e8;">
    <button id="refresh-sessions" style="background: #5a57c4; color: #fff; border: none; padding: 6px 16px; border-radius: 4px; cursor: pointer; font-size: 13px;">刷新</button>
  </div>
  <div id="sessions-list" style="flex: 1; overflow: auto; padding: 12px;">
    <!-- 动态渲染 -->
  </div>
</div>
```

- [ ] **Step 3: 添加样式**

在 `<style>` 标签内添加：

```css
/* Sessions panel styles */
.session-item {
  background: #fff;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  padding: 12px 16px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.session-item:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

.session-domain {
  font-size: 15px;
  font-weight: 500;
  color: #2c3e50;
  cursor: pointer;
}

.session-domain:hover {
  color: #5a57c4;
}

.session-stats {
  font-size: 12px;
  color: #8892b0;
  margin-top: 4px;
}

.session-actions {
  display: flex;
  gap: 8px;
}

.session-actions button {
  background: #f5f7fa;
  border: 1px solid #d9dade;
  border-radius: 4px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 12px;
  color: #515a6e;
}

.session-actions button:hover {
  background: #5a57c4;
  color: #fff;
  border-color: #5a57c4;
}

.session-actions button.danger:hover {
  background: #f56c6c;
  border-color: #f56c6c;
}
```

- [ ] **Step 4: 添加 JavaScript 逻辑**

在 `<script>` 标签内添加：

```javascript
// ===== Sessions Panel Logic =====
const sessionsList = document.getElementById('sessions-list');
const refreshSessionsBtn = document.getElementById('refresh-sessions');

async function loadSessions() {
  try {
    const res = await fetch('/api/sessions', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Failed to load sessions');
    const data = await res.json();
    renderSessions(data.sessions);
  } catch (err) {
    console.error('[Sessions] Load error:', err);
    sessionsList.innerHTML = '<div style="color: #f56c6c; padding: 20px;">加载失败，请重试</div>';
  }
}

function renderSessions(sessions) {
  if (!sessions || sessions.length === 0) {
    sessionsList.innerHTML = '<div style="color: #8892b0; padding: 20px; text-align: center;">暂无已保存的登录状态</div>';
    return;
  }

  sessionsList.innerHTML = sessions.map(s => `
    <div class="session-item">
      <div class="session-info">
        <div class="session-domain" onclick="visitDomain('${s.domain}')">${s.domain}</div>
        <div class="session-stats">${s.cookieCount} cookies</div>
      </div>
      <div class="session-actions">
        <button onclick="checkDomain('${s.domain}', 'quick')">验证</button>
        <button class="danger" onclick="deleteDomain('${s.domain}')">删除</button>
      </div>
    </div>
  `).join('');
}

async function visitDomain(domain) {
  // 切换到远程浏览器面板并导航
  switchPanel('webrtc');
  if (peer && peer.sendMessage) {
    peer.sendMessage({ t: 'navigate', url: `https://${domain}` });
  }
}

async function checkDomain(domain, strategy) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(domain)}/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ strategy })
    });
    const data = await res.json();
    alert(`${domain} 验证结果: ${data.valid ? '✓ 已登录' : '✗ 未登录'}`);
  } catch (err) {
    console.error('[Sessions] Check error:', err);
    alert('验证失败');
  }
}

async function deleteDomain(domain) {
  if (!confirm(`确定要删除 ${domain} 的登录状态吗？`)) return;

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(domain)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      loadSessions();
    } else {
      throw new Error('Delete failed');
    }
  } catch (err) {
    console.error('[Sessions] Delete error:', err);
    alert('删除失败');
  }
}

// 绑定刷新按钮
if (refreshSessionsBtn) {
  refreshSessionsBtn.addEventListener('click', loadSessions);
}

// 当切换到 sessions panel 时自动加载
const originalSwitchPanel = window.switchPanel;
window.switchPanel = function(panelName) {
  originalSwitchPanel(panelName);
  if (panelName === 'sessions') {
    loadSessions();
  }
};
```

- [ ] **Step 5: 提交**

```bash
git add src/public/client.html
git commit -m "feat: add sessions management panel UI

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 端到端测试

**Files:**
- Test: 手动测试

- [ ] **Step 1: 启动服务**

```bash
npm start
```

- [ ] **Step 2: 测试列表功能**

1. 打开 http://localhost:8080/
2. 登录后点击左侧"登录状态管理"
3. 确认面板显示正常

- [ ] **Step 3: 测试删除功能**

1. 在远程浏览器中访问 https://example.com
2. 刷新登录状态管理页面
3. 点击"删除"按钮
4. 确认删除成功

- [ ] **Step 4: 测试验证功能**

1. 点击"验证"按钮
2. 确认弹出框显示验证结果

- [ ] **Step 5: 提交测试确认**

```bash
git status
```

确认无未提交更改

---

## Self-Review

**1. Spec coverage:**
- [x] 列表展示 → Task 1, Task 4
- [x] 删除指定 domain → Task 1, Task 2, Task 4
- [x] 验证登录态（quick 策略）→ Task 1, Task 2, Task 4
- [ ] 验证登录态（full/custom 策略）→ 未实现，可在后续迭代

**2. Placeholder scan:**
- 无 TBD/TODO
- 所有代码块完整

**3. Type consistency:**
- `list()` 返回 `[{domain, cookieCount}]` 在所有任务中一致
- `delete(domain)` 参数类型一致
- `check(domain, strategy)` 参数和返回类型一致
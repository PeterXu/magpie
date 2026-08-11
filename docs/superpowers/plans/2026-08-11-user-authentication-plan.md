# 用户认证实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现单用户认证系统，保护 magpie 远程浏览器服务

**Architecture:** 使用 @hono/jwt 实现 Token 认证，登录接口返回 JWT token，中间件验证 token 并保护路由

**Tech Stack:** Hono, @hono/jwt, Node.js 内置环境变量

## Global Constraints

- 新增依赖：`@hono/jwt`（版本 ^0.4.0）
- 总依赖数：4 → 5 个
- 环境变量配置：`MAGPIE_ADMIN_USER`, `MAGPIE_ADMIN_PASSWORD`, `MAGPIE_JWT_SECRET`, `MAGPIE_JWT_EXPIRES_IN`
- Token 有效期：默认 24 小时（86400 秒）
- 测试框架：`node:test` + `node:assert/strict`
- 无需构建步骤，纯 JavaScript ESM

---

## File Structure

### 新增文件

```
src/
├── middleware/
│   └── auth.js                 ← 认证中间件（验证 token）
├── routes/api/
│   └── login.js                ← 登录接口
└── public/
    └── login.html              ← 登录页面

test/
└── auth/
    ├── login.test.js           ← 登录接口单元测试
    └── middleware.test.js      ← 认证中间件单元测试
```

### 修改文件

```
package.json                     ← 添加 @hono/jwt 依赖
.env.example                     ← 添加认证配置示例
src/config.js                    ← 添加 loadAuthConfig 函数
src/index.js                     ← 加载认证配置并传递给 createApp
src/app.js                      ← 集成认证中间件和登录路由
src/routes/static.js            ← 添加 login.html 公开路由
src/public/client.html          ← 添加 token 验证逻辑
```

---

## Task 1: 添加依赖和配置

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Create: `.env` (如果不存在)

**Interfaces:**
- Produces: `package.json` 包含 `@hono/jwt` 依赖
- Produces: `.env.example` 包含认证配置示例

- [ ] **Step 1: 添加 @hono/jwt 依赖**

```bash
npm install @hono/jwt
```

- [ ] **Step 2: 验证依赖添加成功**

```bash
npm ls @hono/jwt
```

Expected: 显示 `@hono/jwt@^0.4.0`

- [ ] **Step 3: 更新 .env.example 文件**

```bash
# 用户认证配置
MAGPIE_ADMIN_USER=admin
MAGPIE_ADMIN_PASSWORD=
MAGPIE_JWT_SECRET=
MAGPIE_JWT_EXPIRES_IN=86400
```

- [ ] **Step 4: 创建 .env 文件（如果不存在）**

```bash
# 用户认证配置
MAGPIE_ADMIN_USER=admin
MAGPIE_ADMIN_PASSWORD=test-password-123
MAGPIE_JWT_SECRET=test-secret-key-xyz
MAGPIE_JWT_EXPIRES_IN=86400
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "feat: add @hono/jwt dependency for authentication"
```

---

## Task 2: 实现配置加载

**Files:**
- Modify: `src/config.js`
- Test: `test/config.test.js` (添加认证配置测试)

**Interfaces:**
- Produces: `loadAuthConfig(env)` 函数，返回 `{ adminUser, adminPassword, jwtSecret, jwtExpiresIn }`

- [ ] **Step 1: 编写失败的测试**

```javascript
// test/config.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAuthConfig } from '../src/config.js';

test('loadAuthConfig returns default values when env is empty', () => {
  const config = loadAuthConfig({});
  assert.equal(config.adminUser, 'admin');
  assert.equal(config.adminPassword, '');
  assert.equal(config.jwtSecret, '');
  assert.equal(config.jwtExpiresIn, 86400);
});

test('loadAuthConfig reads values from env', () => {
  const config = loadAuthConfig({
    MAGPIE_ADMIN_USER: 'testuser',
    MAGPIE_ADMIN_PASSWORD: 'testpass',
    MAGPIE_JWT_SECRET: 'testsecret',
    MAGPIE_JWT_EXPIRES_IN: '3600'
  });
  assert.equal(config.adminUser, 'testuser');
  assert.equal(config.adminPassword, 'testpass');
  assert.equal(config.jwtSecret, 'testsecret');
  assert.equal(config.jwtExpiresIn, 3600);
});
```

- [ ] **Step 2: 运行测试，验证失败**

```bash
npm test -- test/config.test.js
```

Expected: FAIL - `loadAuthConfig is not defined`

- [ ] **Step 3: 实现 loadAuthConfig 函数**

```javascript
// src/config.js

// 添加到现有文件末尾
export function loadAuthConfig(env = process.env) {
  return {
    adminUser: env.MAGPIE_ADMIN_USER || 'admin',
    adminPassword: env.MAGPIE_ADMIN_PASSWORD || '',
    jwtSecret: env.MAGPIE_JWT_SECRET || '',
    jwtExpiresIn: parseInt(env.MAGPIE_JWT_EXPIRES_IN || '86400', 10)
  };
}
```

- [ ] **Step 4: 运行测试，验证通过**

```bash
npm test -- test/config.test.js
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: add loadAuthConfig for authentication configuration"
```

---

## Task 3: 实现登录接口

**Files:**
- Create: `src/routes/api/login.js`
- Test: `test/auth/login.test.js`

**Interfaces:**
- Produces: `loginApp` - Hono 应用实例，处理 `POST /api/login`
- Consumes: `c.env.ADMIN_USER`, `c.env.ADMIN_PASSWORD`, `c.env.JWT_SECRET`, `c.env.JWT_EXPIRES_IN`

- [ ] **Step 1: 编写失败的测试**

```javascript
// test/auth/login.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { sign, verify } from '@hono/jwt';
import { loginApp } from '../../src/routes/api/login.js';

test('POST /api/login returns token for valid credentials', async () => {
  const app = new Hono();
  app.route('/api/login', loginApp);

  const env = {
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'test-password',
    JWT_SECRET: 'test-secret',
    JWT_EXPIRES_IN: 86400
  };

  const res = await app.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  }, { env });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.token);
  assert.equal(data.expiresIn, 86400);
  assert.deepEqual(data.user, { username: 'admin', role: 'admin' });

  // Verify token
  const payload = await verify(data.token, env.JWT_SECRET);
  assert.equal(payload.sub, 'admin');
  assert.equal(payload.role, 'admin');
});

test('POST /api/login returns 401 for invalid credentials', async () => {
  const app = new Hono();
  app.route('/api/login', loginApp);

  const env = {
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'test-password',
    JWT_SECRET: 'test-secret'
  };

  const res = await app.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong-password' })
  }, { env });

  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, 'Invalid credentials');
});

test('POST /api/login returns 500 for missing password config', async () => {
  const app = new Hono();
  app.route('/api/login', loginApp);

  const env = {
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: '',  // Empty password
    JWT_SECRET: 'test-secret'
  };

  const res = await app.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test' })
  }, { env });

  assert.equal(res.status, 500);
  const data = await res.json();
  assert.equal(data.error, 'Server misconfiguration');
});
```

- [ ] **Step 2: 运行测试，验证失败**

```bash
npm test -- test/auth/login.test.js
```

Expected: FAIL - `loginApp is not defined`

- [ ] **Step 3: 实现登录接口**

```javascript
// src/routes/api/login.js
import { Hono } from 'hono';
import { sign } from '@hono/jwt';

const app = new Hono();

app.post('/', async (c) => {
  const { username, password } = await c.req.json();

  // 从环境变量读取用户凭证
  const adminUser = c.env.ADMIN_USER || 'admin';
  const adminPassword = c.env.ADMIN_PASSWORD;

  // 检查配置
  if (!adminPassword) {
    return c.json({ error: 'Server misconfiguration' }, 500);
  }

  // 验证用户名和密码
  if (username !== adminUser || password !== adminPassword) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  // 生成 JWT
  const payload = {
    sub: username,
    role: 'admin',
    iat: Math.floor(Date.now() / 1000)
  };

  const expiresIn = c.env.JWT_EXPIRES_IN || 86400;
  const token = await sign(payload, c.env.JWT_SECRET);

  return c.json({
    token,
    expiresIn,
    user: { username, role: 'admin' }
  });
});

export { app as loginApp };
```

- [ ] **Step 4: 运行测试，验证通过**

```bash
npm test -- test/auth/login.test.js
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/login.js test/auth/login.test.js
git commit -m "feat: implement login endpoint with JWT token generation"
```

---

## Task 4: 实现认证中间件

**Files:**
- Create: `src/middleware/auth.js`
- Test: `test/auth/middleware.test.js`

**Interfaces:**
- Produces: `requireAuth()` - HTTP 认证中间件
- Produces: `requireWsAuth()` - WebSocket 认证中间件
- Consumes: `c.env.JWT_SECRET`

- [ ] **Step 1: 编写失败的测试**

```javascript
// test/auth/middleware.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { sign } from '@hono/jwt';
import { requireAuth, requireWsAuth } from '../../src/middleware/auth.js';

test('requireAuth passes with valid token', async () => {
  const app = new Hono();
  const secret = 'test-secret';

  // Create a valid token
  const payload = { sub: 'admin', role: 'admin', iat: Math.floor(Date.now() / 1000) };
  const token = await sign(payload, secret);

  app.use('/protected', requireAuth());
  app.get('/protected', (c) => c.json({ user: c.user }));

  const res = await app.request('/protected', {
    headers: { 'Authorization': `Bearer ${token}` }
  }, { env: { JWT_SECRET: secret } });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.user.sub, 'admin');
});

test('requireAuth returns 401 without token', async () => {
  const app = new Hono();
  const secret = 'test-secret';

  app.use('/protected', requireAuth());
  app.get('/protected', (c) => c.json({ user: c.user }));

  const res = await app.request('/protected', {}, { env: { JWT_SECRET: secret } });

  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, 'Missing authorization token');
});

test('requireAuth returns 401 with invalid token', async () => {
  const app = new Hono();
  const secret = 'test-secret';

  app.use('/protected', requireAuth());
  app.get('/protected', (c) => c.json({ user: c.user }));

  const res = await app.request('/protected', {
    headers: { 'Authorization': 'Bearer invalid-token' }
  }, { env: { JWT_SECRET: secret } });

  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, 'Invalid or expired token');
});

test('requireWsAuth passes with valid token in URL', async () => {
  const app = new Hono();
  const secret = 'test-secret';

  const payload = { sub: 'admin', role: 'admin', iat: Math.floor(Date.now() / 1000) };
  const token = await sign(payload, secret);

  app.use('/ws', requireWsAuth());
  app.get('/ws', (c) => c.json({ user: c.user }));

  const res = await app.request(`/ws?token=${token}`, {}, { env: { JWT_SECRET: secret } });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.user.sub, 'admin');
});

test('requireWsAuth throws without token', async () => {
  const app = new Hono();
  const secret = 'test-secret';

  app.use('/ws', requireWsAuth());
  app.get('/ws', (c) => c.json({ user: c.user }));

  try {
    await app.request('/ws', {}, { env: { JWT_SECRET: secret } });
    assert.fail('Should throw error');
  } catch (err) {
    assert.ok(err.message.includes('Missing token') || err.message.includes('Invalid token'));
  }
});
```

- [ ] **Step 2: 运行测试，验证失败**

```bash
npm test -- test/auth/middleware.test.js
```

Expected: FAIL - `requireAuth is not defined`

- [ ] **Step 3: 实现认证中间件**

```javascript
// src/middleware/auth.js
import { verify } from '@hono/jwt';

/**
 * HTTP 路由认证中间件
 * 验证 Authorization: Bearer <token>
 */
export function requireAuth() {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Missing authorization token' }, 401);
    }

    const token = authHeader.substring(7);

    try {
      const payload = await verify(token, c.env.JWT_SECRET);
      c.user = payload;  // 注入用户信息到 context
      await next();
    } catch (err) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
  };
}

/**
 * WebSocket 认证中间件
 * 从 URL 参数验证 token
 */
export function requireWsAuth() {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const token = url.searchParams.get('token');

    if (!token) {
      throw new Error('Missing token');
    }

    try {
      const payload = await verify(token, c.env.JWT_SECRET);
      c.user = payload;
      await next();
    } catch (err) {
      throw new Error('Invalid token');
    }
  };
}
```

- [ ] **Step 4: 运行测试，验证通过**

```bash
npm test -- test/auth/middleware.test.js
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/middleware/auth.js test/auth/middleware.test.js
git commit -m "feat: implement authentication middleware for HTTP and WebSocket"
```

---

## Task 5: 创建登录页面

**Files:**
- Create: `src/public/login.html`

**Interfaces:**
- Produces: 登录页面 UI，包含用户名/密码表单
- Produces: JavaScript 逻辑：提交到 `/api/login`，存储 token 到 localStorage

- [ ] **Step 1: 创建登录页面**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Magpie Login</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .login-container {
      background: white;
      padding: 48px;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      width: 380px;
    }
    .login-header {
      text-align: center;
      margin-bottom: 32px;
    }
    .login-header h1 {
      margin: 0 0 8px 0;
      color: #5a57c4;
      font-size: 32px;
    }
    .login-header p {
      margin: 0;
      color: #666;
      font-size: 14px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    .form-group label {
      display: block;
      margin-bottom: 6px;
      color: #333;
      font-size: 14px;
      font-weight: 500;
    }
    input[type="text"],
    input[type="password"] {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid #e0e0e0;
      border-radius: 6px;
      font-size: 16px;
      transition: border-color 0.2s;
    }
    input[type="text"]:focus,
    input[type="password"]:focus {
      outline: none;
      border-color: #5a57c4;
    }
    button {
      width: 100%;
      padding: 14px;
      background: #5a57c4;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 16px;
      font-weight: 600;
      transition: background 0.2s;
    }
    button:hover { background: #4a47b4; }
    button:active { background: #3a37a4; }
    .error-message {
      color: #d32f2f;
      font-size: 14px;
      margin-top: 16px;
      text-align: center;
      min-height: 20px;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-header">
      <h1>🦅 Magpie</h1>
      <p>Remote Browser Service</p>
    </div>
    <form id="loginForm">
      <div class="form-group">
        <label for="username">用户名</label>
        <input type="text" id="username" name="username" required autocomplete="username" autofocus>
      </div>
      <div class="form-group">
        <label for="password">密码</label>
        <input type="password" id="password" name="password" required autocomplete="current-password">
      </div>
      <button type="submit">登录</button>
    </form>
    <div class="error-message" id="errorMessage"></div>
  </div>

  <script>
    // 检查是否已登录
    const token = localStorage.getItem('token');
    if (token) {
      // 尝试访问受保护路由验证 token
      fetch('/', {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      .then(res => {
        if (res.ok) {
          window.location.href = '/';
        } else {
          localStorage.removeItem('token');
          localStorage.removeItem('user');
        }
      })
      .catch(() => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
      });
    }

    // 登录表单提交
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();

      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;
      const errorMessage = document.getElementById('errorMessage');

      errorMessage.textContent = '';

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const data = await res.json();

        if (res.ok) {
          localStorage.setItem('token', data.token);
          localStorage.setItem('user', JSON.stringify(data.user));
          window.location.href = '/';
        } else {
          errorMessage.textContent = data.error || '登录失败';
        }
      } catch (err) {
        errorMessage.textContent = '网络错误，请稍后重试';
      }
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add src/public/login.html
git commit -m "feat: add login page with form and token storage"
```

---

## Task 6: 集成认证到 App

**Files:**
- Modify: `src/app.js`
- Modify: `src/index.js`
- Modify: `src/routes/static.js`

**Interfaces:**
- Consumes: `loginApp` from Task 3
- Consumes: `requireAuth`, `requireWsAuth` from Task 4
- Consumes: `loadAuthConfig` from Task 2
- Produces: App 集成认证中间件，保护路由

- [ ] **Step 1: 修改 src/index.js 加载认证配置**

在 `src/index.js` 中，找到创建 app 的位置，添加认证配置加载：

```javascript
// 在文件顶部添加
import { loadAuthConfig } from './config.js';

// 在创建 app 之前添加
const authConfig = loadAuthConfig();

// 修改 createApp 调用，添加 env 参数
const app = createApp({
  browserSession,
  streamerPeer,
  inputChannel,
  clientIceServers,
  wsManager,
  env: {
    ADMIN_USER: authConfig.adminUser,
    ADMIN_PASSWORD: authConfig.adminPassword,
    JWT_SECRET: authConfig.jwtSecret,
    JWT_EXPIRES_IN: authConfig.jwtExpiresIn
  }
});
```

- [ ] **Step 2: 修改 src/app.js 添加环境变量注入**

```javascript
// src/app.js - 在 createApp 函数开头添加
export function createApp({ browserSession, streamerPeer, inputChannel, clientIceServers, wsManager, env }) {
  const app = new Hono();

  // 注入环境变量到 context
  app.use('*', (c, next) => {
    c.env = env;
    return next();
  });

  // ... 其余代码保持不变
```

- [ ] **Step 3: 修改 src/app.js 导入认证模块**

```javascript
// src/app.js - 在文件顶部添加
import { requireAuth, requireWsAuth } from './middleware/auth.js';
import { loginApp } from './routes/api/login.js';
```

- [ ] **Step 4: 修改 src/app.js 添加登录路由和认证中间件**

在 `createApp` 函数中，修改路由注册顺序：

```javascript
// 公开路由（不需要认证）
app.route('/healthz', healthApp);
app.route('/api/login', loginApp);

// 受保护路由（需要认证）
app.use('/*', requireAuth());
app.route('/', staticApp);

// WebSocket 受保护路由
app.use('/signaling', requireWsAuth());
app.route('/signaling', createSignalingRoute({ browserSession, streamerPeer, inputChannel, clientIceServers, wsManager }));
app.route('/internal', createInternalRoute({ streamerPeer }));

return app;
```

- [ ] **Step 5: 修改 src/routes/static.js 添加 login.html 路由**

```javascript
// src/routes/static.js - 在路由注册部分添加
app.get('/login.html', (c) => {
  return c.html(loginHtml);
});

// 在文件顶部添加
import { readFileSync } from 'fs';
const loginHtml = readFileSync(new URL('../../public/login.html', import.meta.url), 'utf-8');
```

- [ ] **Step 6: 运行测试，验证功能**

```bash
npm test
```

Expected: 所有测试通过（包括之前的测试）

- [ ] **Step 7: 手动测试登录流程**

```bash
# 启动服务
npm start

# 在另一个终端测试登录
curl -X POST http://localhost:8080/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"test-password-123"}'
```

Expected: 返回 token

```bash
# 测试受保护路由（使用 token）
curl http://localhost:8080/ \
  -H "Authorization: Bearer <token-from-above>"
```

Expected: 返回 HTML 页面

- [ ] **Step 8: Commit**

```bash
git add src/app.js src/index.js src/routes/static.js
git commit -m "feat: integrate authentication middleware into app"
```

---

## Task 7: 更新客户端页面

**Files:**
- Modify: `src/public/client.html`

**Interfaces:**
- Consumes: `localStorage.getItem('token')`
- Produces: WebSocket 连接携带 token 参数
- Produces: Token 无效时重定向到登录页

- [ ] **Step 1: 在 client.html 添加 token 检查逻辑**

在 `<script>` 标签开头添加：

```javascript
// 在 DOMContentLoaded 事件处理器内部开头添加
window.addEventListener('DOMContentLoaded', () => {
  // 检查 token 是否存在
  const token = localStorage.getItem('token');

  if (!token) {
    window.location.href = '/login.html';
    return;
  }

  // 原有的初始化代码继续...
```

- [ ] **Step 2: 修改 WebSocket 连接携带 token**

找到 WebSocket 创建代码，修改为：

```javascript
// 原代码：
// const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signaling`);

// 修改为：
const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signaling?token=${encodeURIComponent(token)}`);
```

- [ ] **Step 3: 添加 WebSocket 错误处理**

在 WebSocket 事件处理器中添加：

```javascript
ws.onerror = (err) => {
  console.error('WebSocket error:', err);
  // Token 无效，跳转登录页
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = '/login.html';
};
```

- [ ] **Step 4: 手动测试完整流程**

```bash
# 启动服务
npm start

# 在浏览器打开 http://localhost:8080
# Expected: 重定向到登录页

# 输入用户名/密码登录
# Expected: 成功登录，跳转到主页，WebSocket 连接成功

# 刷新页面
# Expected: 不需要重新登录（token 有效）

# 清除 localStorage，刷新页面
# Expected: 重定向到登录页
```

- [ ] **Step 5: Commit**

```bash
git add src/public/client.html
git commit -m "feat: add token verification to client page"
```

---

## Task 8: 编写集成测试

**Files:**
- Create: `test/integration/auth.test.js`

**Interfaces:**
- Tests: 完整登录流程（未登录 → 登录 → 访问受保护路由）

- [ ] **Step 1: 编写集成测试**

```javascript
// test/integration/auth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

test('完整登录流程：未登录重定向到登录页', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto('http://localhost:8080/');

    // 应该重定向到登录页
    await page.waitForURL('**/login.html', { timeout: 5000 });
    assert.ok(page.url().includes('/login.html'));
  } finally {
    await browser.close();
  }
});

test('完整登录流程：登录成功后跳转主页', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto('http://localhost:8080/login.html');

    // 填写用户名和密码
    await page.fill('#username', 'admin');
    await page.fill('#password', 'test-password-123');

    // 提交表单
    await page.click('button[type="submit"]');

    // 应该跳转到主页
    await page.waitForURL('**/', { timeout: 5000 });
    assert.equal(page.url(), 'http://localhost:8080/');

    // 验证 token 存在
    const token = await page.evaluate(() => localStorage.getItem('token'));
    assert.ok(token);
  } finally {
    await browser.close();
  }
});

test('完整登录流程：登录失败显示错误消息', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto('http://localhost:8080/login.html');

    // 填写错误密码
    await page.fill('#username', 'admin');
    await page.fill('#password', 'wrong-password');

    // 提交表单
    await page.click('button[type="submit"]');

    // 等待错误消息
    await page.waitForSelector('.error-message:not(:empty)', { timeout: 5000 });
    const error = await page.$eval('.error-message', el => el.textContent);
    assert.equal(error, 'Invalid credentials');
  } finally {
    await browser.close();
  }
});
```

- [ ] **Step 2: 运行集成测试**

```bash
# 先启动服务
npm start &

# 等待服务启动
sleep 3

# 运行集成测试
npm test -- test/integration/auth.test.js

# 停止服务
pkill -f "node src/index.js"
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/integration/auth.test.js
git commit -m "test: add integration tests for authentication flow"
```

---

## Task 9: 验证所有功能

**Files:**
- None (验证任务)

**Interfaces:**
- Verifies: 所有单元测试通过
- Verifies: 所有集成测试通过
- Verifies: 手动登录流程正常

- [ ] **Step 1: 运行所有测试**

```bash
npm test
```

Expected: 所有测试通过（包括之前的测试）

- [ ] **Step 2: 手动测试完整流程**

```bash
# 启动服务
npm start

# 浏览器测试：
# 1. 打开 http://localhost:8080
# 2. 应该重定向到登录页
# 3. 输入错误密码，应该显示错误
# 4. 输入正确密码，应该登录成功
# 5. 刷新页面，应该保持登录状态
# 6. WebSocket 连接应该正常工作
# 7. 清除 localStorage，刷新页面，应该重定向到登录页
```

- [ ] **Step 3: 验证路由保护**

```bash
# 未登录访问受保护路由
curl http://localhost:8080/

# Expected: 返回 401 错误

# 登录获取 token
TOKEN=$(curl -s -X POST http://localhost:8080/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"test-password-123"}' | jq -r '.token')

# 使用 token 访问受保护路由
curl http://localhost:8080/ -H "Authorization: Bearer $TOKEN"

# Expected: 返回 HTML 页面
```

- [ ] **Step 4: 最终提交**

```bash
git add -A
git commit -m "feat: complete user authentication implementation"
```

---

## 验收标准

- ✅ 所有单元测试通过
- ✅ 所有集成测试通过
- ✅ 登录页面可访问，样式正确
- ✅ 登录成功后跳转主页
- ✅ 登录失败显示错误消息
- ✅ Token 存储在 localStorage
- ✅ 受保护路由需要 token 才能访问
- ✅ WebSocket 连接携带 token
- ✅ Token 无效时重定向到登录页
- ✅ 环境变量配置正确加载

---

## 备注

- Token 有效期默认 24 小时，可通过 `MAGPIE_JWT_EXPIRES_IN` 配置
- 生产环境必须设置强密码和复杂的 `JWT_SECRET`
- 建议使用 HTTPS 保护 token 传输
- 登录页面使用 localStorage 存储 token，关闭浏览器后仍然有效
# Magpie 用户认证设计

**日期**: 2026-08-11
**作者**: Claude
**状态**: 设计阶段

---

## 背景

当前 magpie 没有用户认证机制，任何人都可以访问远程浏览器服务。需要添加简单的认证系统：
- 防止未授权访问
- 保护远程浏览器资源
- 提供基本的安全保障

目标：实现单用户认证系统（admin/password），简单、安全、易部署。

---

## 核心需求

### 1. 单用户管理
- 只有一个固定用户：`admin`（可配置）
- 密码存储在环境变量中
- 无需数据库或文件存储

### 2. Token 认证
- 登录接口：`POST /api/login`
- 返回 JWT token（有效期 24 小时，可配置）
- 客户端存储 token 在 localStorage
- 后续请求携带 `Authorization: Bearer <token>`

### 3. 路由保护
- 未认证请求重定向到登录页面
- WebSocket 连接需要 token 验证
- 公开路由：登录页面、健康检查

---

## 技术选型

### 使用 @hono/jwt

**理由**：
- Hono 生态集成，类型安全
- 开箱即用的 JWT 中间件
- 官方维护，文档完善
- 符合项目轻量级理念

**依赖变化**：
- 新增：`@hono/jwt`
- 总依赖数：4 → 5 个（playwright, ws, hono, @hono/node-server, @hono/jwt）

---

## 架构设计

### 认证流程

```
未认证请求
     ↓
重定向到 /login.html
     ↓
用户输入 username/password
     ↓
POST /api/login
     ↓
验证环境变量（MAGPIE_ADMIN_USER/PASSWORD）
     ↓
成功：生成 JWT token，返回给客户端
失败：返回 401 错误
     ↓
客户端存储 token（localStorage）
     ↓
后续请求携带 Authorization: Bearer <token>
     ↓
中间件验证 token 并注入 c.user
```

### Token 结构

```json
{
  "sub": "admin",
  "role": "admin",
  "iat": 1723377600,
  "exp": 1723464000
}
```

- `sub`：用户标识（subject）
- `role`：用户角色（预留扩展）
- `iat`：签发时间（issued at）
- `exp`：过期时间（expiration，iat + 86400）

---

## 文件结构

### 新增文件

```
src/
├── middleware/
│   └── auth.js                 ← 认证中间件（验证 token）
├── routes/api/
│   └── login.js                ← 登录路由
└── public/
    └── login.html              ← 登录页面
```

### 修改文件

```
src/
├── app.js                      ← 添加认证中间件
├── index.js                    ← 加载认证环境变量
├── config.js                   ← 添加认证配置加载
├── public/client.html          ← 添加 token 验证逻辑
└── package.json                ← 添加 @hono/jwt 依赖
```

### 配置文件

```
.env.example                    ← 添加认证配置示例
```

---

## 核心实现

### 1. 登录路由

**文件**：`src/routes/api/login.js`

```javascript
import { Hono } from 'hono';
import { sign } from '@hono/jwt';

const app = new Hono();

app.post('/', async (c) => {
  const { username, password } = await c.req.json();

  // 从环境变量读取用户凭证
  const adminUser = c.env.ADMIN_USER || 'admin';
  const adminPassword = c.env.ADMIN_PASSWORD;

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

---

### 2. 认证中间件

**文件**：`src/middleware/auth.js`

```javascript
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

---

### 3. App 集成

**文件**：`src/app.js`

```javascript
import { Hono } from 'hono';
import { requireAuth, requireWsAuth } from './middleware/auth.js';
import { loginApp } from './routes/api/login.js';

export function createApp({ browserSession, streamerPeer, inputChannel, clientIceServers, wsManager, env }) {
  const app = new Hono();

  // 注入环境变量到 context
  app.use('*', (c, next) => {
    c.env = env;
    return next();
  });

  // 公开路由
  app.route('/healthz', healthApp);
  app.route('/api/login', loginApp);

  // 受保护路由（需要认证）
  app.use('/*', requireAuth());
  app.route('/', staticApp);

  // WebSocket 受保护路由
  app.use('/signaling', requireWsAuth());
  app.route('/signaling', createSignalingRoute({ ... }));

  return app;
}
```

---

### 4. 登录页面

**文件**：`src/public/login.html`

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
      fetch('/api/verify', {
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

---

### 5. 客户端集成

**修改**：`src/public/client.html`

```javascript
// 启动时检查 token
window.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('token');

  if (!token) {
    window.location.href = '/login.html';
    return;
  }

  // WebSocket 连接时携带 token
  const ws = new WebSocket(`wss://${location.host}/signaling?token=${token}`);

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    // token 无效，跳转登录
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login.html';
  };
});
```

---

## 环境变量配置

### .env 文件

```bash
# 用户认证配置
MAGPIE_ADMIN_USER=admin
MAGPIE_ADMIN_PASSWORD=your-secret-password-123
MAGPIE_JWT_SECRET=your-jwt-secret-key-xyz
MAGPIE_JWT_EXPIRES_IN=86400  # 24小时（秒）
```

### .env.example

```bash
# 用户认证配置
MAGPIE_ADMIN_USER=admin
MAGPIE_ADMIN_PASSWORD=
MAGPIE_JWT_SECRET=
MAGPIE_JWT_EXPIRES_IN=86400
```

### config.js 修改

```javascript
// src/config.js
export function loadAuthConfig(env = process.env) {
  return {
    adminUser: env.MAGPIE_ADMIN_USER || 'admin',
    adminPassword: env.MAGPIE_ADMIN_PASSWORD || '',
    jwtSecret: env.MAGPIE_JWT_SECRET || '',
    jwtExpiresIn: parseInt(env.MAGPIE_JWT_EXPIRES_IN || '86400', 10)
  };
}
```

---

## 路由保护清单

| 路由 | 认证要求 | 说明 |
|------|---------|------|
| `/api/login` | 公开 | 登录接口 |
| `/login.html` | 公开 | 登录页面 |
| `/healthz` | 公开 | 健康检查 |
| `/` | 需要 token | 客户端主页 |
| `/client.html` | 需要 token | 客户端页面 |
| `/signaling` | 需要 token | WebSocket 连接 |
| `/internal` | 需要 token | 内部帧传输 |

---

## 错误处理

### 登录失败

**请求**：
```json
POST /api/login
{
  "username": "admin",
  "password": "wrong-password"
}
```

**响应**：
```json
{
  "error": "Invalid credentials"
}
```
状态码：401

---

### Token 无效

**请求**：
```json
GET /
Authorization: Bearer invalid-token
```

**响应**：
```json
{
  "error": "Invalid or expired token"
}
```
状态码：401

---

### Token 缺失

**请求**：
```json
GET /
```

**响应**：
```json
{
  "error": "Missing authorization token"
}
```
状态码：401

---

### 配置缺失

**响应**：
```json
{
  "error": "Server misconfiguration"
}
```
状态码：500

---

## 安全考虑

### 1. 密码安全
- ✅ 密码存储在环境变量中，不提交到 git
- ✅ 生产环境必须设置强密码
- ✅ 定期更换密码和 JWT_SECRET

### 2. Token 安全
- ✅ Token 有效期 24 小时（可配置）
- ✅ Token 存储在 localStorage（浏览器）
- ✅ HTTPS 环境下传输加密

### 3. 传输安全
- ✅ 生产环境必须使用 HTTPS
- ✅ WebSocket 使用 WSS（加密）
- ✅ 避免在不安全网络传输 token

---

## 实现步骤

1. **添加依赖**：`npm install @hono/jwt`
2. **配置环境变量**：编辑 `.env` 和 `.env.example`
3. **实现登录接口**：`src/routes/api/login.js`
4. **实现认证中间件**：`src/middleware/auth.js`
5. **创建登录页面**：`src/public/login.html`
6. **集成到 App**：修改 `src/app.js`
7. **更新客户端页面**：修改 `src/public/client.html`
8. **编写测试**：单元测试 + 集成测试
9. **验证功能**：完整登录流程测试

---

## 测试策略

### 单元测试

1. **登录接口**
   - 正确用户名/密码 → 200 + token
   - 错误密码 → 401
   - 缺失配置 → 500

2. **认证中间件**
   - 有效 token → 通过
   - 无效 token → 401
   - 过期 token → 401

### 集成测试

1. **完整流程**
   - 未登录访问 → 重定向到登录页
   - 登录成功 → 获取 token
   - 使用 token 访问受保护路由 → 成功
   - 使用无效 token → 401

---

## 参考资料

- [Hono JWT Middleware](https://github.com/honojs/hono/blob/main/src/middleware/jwt/README.md)
- [JWT.io](https://jwt.io/)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
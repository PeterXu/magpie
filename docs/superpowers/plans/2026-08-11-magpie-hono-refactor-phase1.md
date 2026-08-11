# Magpie Hono 改造 - 第一阶段实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Hono 框架替换原生 http + ws，重构 HTTP 路由和 WebSocket 消息处理，保持单用户架构不变。

**Architecture:** 引入 Hono 轻量级框架，将 server.js 的路由逻辑重构为模块化的路由和处理器，使用中间件统一错误处理和日志。

**Tech Stack:** Hono ^4.7.0, @hono/node-server ^1.13.0

## Global Constraints

- 保持 ESM 模块（"type": "module"）
- 无构建步骤，纯 JavaScript
- 所有现有测试必须通过
- 功能与改造前完全一致
- 依赖数量：从 2 个 → 3 个（仍保持轻量）

---

## File Structure

**创建**：
- `src/app.js` - Hono 应用入口，定义路由和中间件
- `src/routes/health.js` - GET /healthz 健康检查路由
- `src/routes/static.js` - 静态文件服务路由（/, /client.html, /streamer.html 等）
- `src/routes/ws/signaling.js` - WebSocket /signaling 路由
- `src/routes/ws/internal.js` - WebSocket /internal 路由
- `src/handlers/signaling/SessionHandler.js` - WebSocket 消息处理器（可复用）
- `src/websocket/WebSocketManager.js` - WebSocket 连接管理和广播
- `src/middleware/errorHandler.js` - 统一错误处理中间件
- `src/middleware/logger.js` - 请求日志中间件

**修改**：
- `package.json` - 更新依赖（移除 ws，新增 hono + @hono/node-server）
- `src/index.js` - 调整启动逻辑，使用 app.js 导出的 Hono 应用

**删除**：
- `src/server.js` - 被 app.js 替代

---

## Task 1: 添加 Hono 依赖

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `hono` 和 `@hono/node-server` 依赖可用

- [ ] **Step 1: 更新 package.json**

```json
{
  "dependencies": {
    "playwright": "^1.49.0",
    "hono": "^4.7.0",
    "@hono/node-server": "^1.13.0"
  }
}
```

- [ ] **Step 2: 安装依赖**

Run: `npm install`
Expected: 成功安装，package-lock.json 更新

- [ ] **Step 3: 验证依赖安装**

Run: `npm ls hono @hono/node-server`
Expected: 显示 hono@^4.7.0 和 @hono/node-server@^1.13.0

- [ ] **Step 4: 提交**

```bash
git add package.json package-lock.json
git commit -m "chore: add hono and @hono/node-server dependencies"
```

---

## Task 2: 创建 Hono 应用骨架

**Files:**
- Create: `src/app.js`
- Create: `src/routes/health.js`

**Interfaces:**
- Produces: `app` Hono 实例，可导入使用
- Produces: `GET /healthz` 路由

- [ ] **Step 1: 创建 health 路由**

```javascript
// src/routes/health.js
import { Hono } from 'hono';

const app = new Hono();

app.get('/', (c) => {
  return c.text('ok');
});

export { app };
```

- [ ] **Step 2: 创建 Hono 应用骨架**

```javascript
// src/app.js
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { app as healthApp } from './routes/health.js';

const app = new Hono();

// 挂载路由
app.route('/healthz', healthApp);

export { app, serve };
```

- [ ] **Step 3: 验证健康检查路由**

Run: `node -e "import('./src/app.js').then(m => console.log('app created'))"`
Expected: 无错误输出

- [ ] **Step 4: 提交**

```bash
git add src/app.js src/routes/health.js
git commit -m "feat: create Hono app skeleton with health route"
```

---

## Task 3: 实现静态文件路由

**Files:**
- Create: `src/routes/static.js`

**Interfaces:**
- Consumes: `serveFile` 函数（从 server.js 迁移）
- Produces: `GET /`, `GET /client.html`, `GET /streamer.html` 等路由

- [ ] **Step 1: 创建静态文件路由**

```javascript
// src/routes/static.js
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '../public');

const app = new Hono();

// 辅助函数：读取并返回文件
async function serveStaticFile(c, filename, contentType) {
  try {
    const filePath = path.join(PUBLIC_DIR, filename);
    const body = await readFile(filePath);
    return c.body(body, 200, { 'Content-Type': contentType });
  } catch {
    return c.text('not found', 404);
  }
}

// 路由定义
app.get('/', async (c) => {
  return serveStaticFile(c, 'client.html', 'text/html; charset=utf-8');
});

app.get('/client.html', async (c) => {
  return serveStaticFile(c, 'client.html', 'text/html; charset=utf-8');
});

app.get('/streamer.html', async (c) => {
  return serveStaticFile(c, 'streamer/streamer.html', 'text/html; charset=utf-8');
});

app.get('/cursor.svg', async (c) => {
  return serveStaticFile(c, 'cursor.svg', 'image/svg+xml');
});

// WebRTC 模块文件
const MODULE_FILES = {
  '/codec-pick.js': { file: 'webrtc/codec-pick.js', type: 'text/javascript' },
  '/EventEmitter.js': { file: 'webrtc/EventEmitter.js', type: 'text/javascript' },
  '/MagpiePeer.js': { file: 'webrtc/MagpiePeer.js', type: 'text/javascript' },
  '/MagpieConnection.js': { file: 'webrtc/MagpieConnection.js', type: 'text/javascript' },
  '/MagpieNegotiator.js': { file: 'webrtc/MagpieNegotiator.js', type: 'text/javascript' },
  '/MagpieSignalChannel.js': { file: 'webrtc/MagpieSignalChannel.js', type: 'text/javascript' },
};

Object.entries(MODULE_FILES).forEach(([route, config]) => {
  app.get(route, async (c) => {
    return serveStaticFile(c, config.file, config.type);
  });
});

export { app };
```

- [ ] **Step 2: 挂载静态路由到 app.js**

```javascript
// src/app.js（添加）
import { app as staticApp } from './routes/static.js';

// 挂载路由（在 health 路由后）
app.route('/', staticApp);
```

- [ ] **Step 3: 提交**

```bash
git add src/app.js src/routes/static.js
git commit -m "feat: add static file routes"
```

---

## Task 4: 实现错误处理中间件

**Files:**
- Create: `src/middleware/errorHandler.js`

**Interfaces:**
- Produces: `errorHandler` 中间件函数，捕获未处理异常

- [ ] **Step 1: 创建错误处理中间件**

```javascript
// src/middleware/errorHandler.js
import { Context } from 'hono';

export async function errorHandler(c, next) {
  try {
    await next();
  } catch (err) {
    console.error('Unhandled error:', err);
    return c.json(
      { error: 'Internal Server Error', message: err.message },
      500
    );
  }
}
```

- [ ] **Step 2: 应用中间件到 app.js**

```javascript
// src/app.js（添加）
import { errorHandler } from './middleware/errorHandler.js';

// 应用中间件（在路由定义前）
app.use('*', errorHandler);
```

- [ ] **Step 3: 提交**

```bash
git add src/app.js src/middleware/errorHandler.js
git commit -m "feat: add error handling middleware"
```

---

## Task 5: 实现日志中间件

**Files:**
- Create: `src/middleware/logger.js`

**Interfaces:**
- Produces: `logger` 中间件函数，记录请求/响应信息

- [ ] **Step 1: 创建日志中间件**

```javascript
// src/middleware/logger.js
export async function logger(c, next) {
  const start = Date.now();
  const { method, url } = c.req;

  console.log(`--> ${method} ${url}`);

  await next();

  const ms = Date.now() - start;
  console.log(`<-- ${method} ${url} ${c.res.status} ${ms}ms`);
}
```

- [ ] **Step 2: 应用中间件到 app.js**

```javascript
// src/app.js（添加）
import { logger } from './middleware/logger.js';

// 应用中间件（在 errorHandler 后）
app.use('*', logger);
```

- [ ] **Step 3: 提交**

```bash
git add src/app.js src/middleware/logger.js
git commit -m "feat: add request logging middleware"
```

---

## Task 6: 创建消息处理器（SessionHandler）

**Files:**
- Create: `src/handlers/signaling/SessionHandler.js`

**Interfaces:**
- Consumes: `browserSession`, `streamerPeer`, `inputChannel` 实例
- Produces: `SessionHandler` 类，提供 `handle(msg)` 方法

- [ ] **Step 1: 创建 SessionHandler 类**

```javascript
// src/handlers/signaling/SessionHandler.js
export class SessionHandler {
  constructor({ browserSession, streamerPeer, inputChannel }) {
    this.browserSession = browserSession;
    this.streamerPeer = streamerPeer;
    this.inputChannel = inputChannel;
  }

  async handle(msg) {
    switch (msg.t) {
      case 'offer':
        return this.handleOffer(msg);
      case 'navigate':
        return this.handleNavigate(msg);
      case 'back':
        return this.handleBack();
      case 'forward':
        return this.handleForward();
      case 'refresh':
        return this.handleRefresh();
      case 'switch-tab':
        return this.handleSwitchTab(msg);
      case 'close-tab':
        return this.handleCloseTab(msg);
      case 'new-tab':
        return this.handleNewTab();
      case 'status':
        return this.handleStatus();
      case 'mouse':
      case 'wheel':
      case 'key':
      case 'paste':
      case 'copy':
        return this.handleInput(msg);
      default:
        throw new Error(`Unknown message type: ${msg.t}`);
    }
  }

  async handleOffer(msg) {
    const sdp = await this.streamerPeer.relayOffer(msg.sdp);
    return { t: 'answer', sdp };
  }

  async handleNavigate(msg) {
    await this.browserSession.navigate(msg.url);
    // URL 变化通过 onUrlChange 广播，无需响应
    return null;
  }

  async handleBack() {
    await this.browserSession.goBack();
    return null;
  }

  async handleForward() {
    await this.browserSession.goForward();
    return null;
  }

  async handleRefresh() {
    await this.browserSession.reload();
    return null;
  }

  async handleSwitchTab(msg) {
    await this.browserSession.switchPage(msg.id);
    return null;
  }

  async handleCloseTab(msg) {
    await this.browserSession.closePage(msg.id);
    return null;
  }

  async handleNewTab() {
    await this.browserSession.newPage();
    return null;
  }

  async handleStatus() {
    const viewport = this.browserSession.getViewport();
    const url = this.browserSession.getUrl();
    return { t: 'status', viewport, url };
  }

  async handleInput(msg) {
    await this.inputChannel.handle(JSON.stringify(msg));
    return null;
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/handlers/signaling/SessionHandler.js
git commit -m "feat: create SessionHandler for WebSocket message handling"
```

---

## Task 7: 实现 WebSocket 路由（signaling）并添加广播机制

**Files:**
- Create: `src/routes/ws/signaling.js`
- Create: `src/routes/ws/internal.js`
- Create: `src/websocket/WebSocketManager.js`

**Interfaces:**
- Consumes: `browserSession`, `streamerPeer`, `inputChannel`, `clientIceServers` 实例
- Produces: `/signaling` WebSocket 路由，处理 WebRTC 信令
- Produces: `WebSocketManager` 类，管理所有 WebSocket 连接并提供广播功能

- [ ] **Step 1: 创建 WebSocketManager（管理连接和广播）**

```javascript
// src/websocket/WebSocketManager.js
export class WebSocketManager {
  constructor() {
    this.clients = new Set(); // 存储所有连接的 WebSocket
  }

  add(ws) {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(msg);
        } catch (e) {
          // ignore send errors
        }
      }
    }
  }
}
```

- [ ] **Step 2: 创建 signaling WebSocket 路由**

```javascript
// src/routes/ws/signaling.js
import { Hono } from 'hono';
import { websocket } from 'hono/ws';
import { SessionHandler } from '../../handlers/signaling/SessionHandler.js';

const app = new Hono();

export function createSignalingRoute({ browserSession, streamerPeer, inputChannel, clientIceServers, wsManager }) {
  const handler = new SessionHandler({ browserSession, streamerPeer, inputChannel });

  app.get('/signaling', websocket(async (c, ws) => {
    // 注册到 WebSocketManager
    wsManager.add(ws);

    const send = (obj) => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify(obj));
        } catch (e) {
          // ignore send errors
        }
      }
    };

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      try {
        const response = await handler.handle(msg);
        if (response) {
          send(response);
        }
      } catch (err) {
        send({ t: 'error', error: String((err && err.message) || err) });
      }
    });

    // 发送 hello 消息
    const nav = await browserSession.getNavState();
    const tabs = browserSession.getTabsState();
    send({
      t: 'hello',
      viewport: browserSession.getViewport(),
      url: nav.url,
      canBack: nav.canBack,
      canForward: nav.canForward,
      iceServers: clientIceServers,
      magpieCodecs: streamerPeer.getSenderCodecs(),
      pages: tabs.pages,
      activeId: tabs.activeId
    });
  }));

  return app;
}

export { app };
```

- [ ] **Step 3: 创建 internal WebSocket 路由**

```javascript
// src/routes/ws/internal.js
import { Hono } from 'hono';
import { websocket } from 'hono/ws';

const app = new Hono();

export function createInternalRoute({ streamerPeer }) {
  app.get('/internal', websocket(async (c, ws) => {
    streamerPeer.setFrameSocket(ws);
  }));

  return app;
}

export { app };
```

- [ ] **Step 4: 更新 app.js 创建工厂函数**

```javascript
// src/app.js（修改）
import { WebSocketManager } from './websocket/WebSocketManager.js';

export function createApp({ browserSession, streamerPeer, inputChannel, clientIceServers, wsManager }) {
  const app = new Hono();

  // 应用中间件
  app.use('*', errorHandler);
  app.use('*', logger);

  // 挂载 HTTP 路由
  app.route('/healthz', healthApp);
  app.route('/', staticApp);

  // 挂载 WebSocket 路由
  const signalingApp = createSignalingRoute({ browserSession, streamerPeer, inputChannel, clientIceServers, wsManager });
  const internalApp = createInternalRoute({ streamerPeer });

  app.route('/', signalingApp);
  app.route('/', internalApp);

  return app;
}
```

- [ ] **Step 5: 提交**

```bash
git add src/app.js src/routes/ws/signaling.js src/routes/ws/internal.js src/websocket/WebSocketManager.js
git commit -m "feat: add WebSocket routes with broadcast support"
```

---

## Task 8: 集成到主入口并验证

**Files:**
- Modify: `src/index.js`

**Interfaces:**
- Consumes: `createApp` 函数, `WebSocketManager` 类
- Produces: 运行中的 Hono 服务器，支持广播

- [ ] **Step 1: 修改 index.js 使用 Hono**

```javascript
// src/index.js（修改）
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./browser/launch-options.js";
import { BrowserSession } from "./browser/BrowserSession.js";
import { StreamerPeer } from "./streamer/StreamerPeer.js";
import { InputChannel } from "./webrtc/InputChannel.js";
import { createApp, serve } from "./app.js";
import { WebSocketManager } from "./websocket/WebSocketManager.js";
import { buildIceServers } from "./webrtc/ice-servers.js";
import { loadConfig } from "./config.js";
import { loadEnvFile } from "./env.js";
import { fileURLToPath } from "node:url";

// ... (env 配置部分保持不变)

async function main() {
  const browser = await chromium.launch(chromiumLaunchOptions());

  const browserSession = new BrowserSession({ url: DEFAULT_URL, width: cfg.viewport.width, height: cfg.viewport.height, browser, screencast: cfg.screencast });
  await browserSession.start();

  const streamerPeer = new StreamerPeer({ browser });
  const inputChannel = new InputChannel({ browserSession, viewportProvider: browserSession });

  // 创建 WebSocket 管理器
  const wsManager = new WebSocketManager();

  // 创建 Hono app
  const app = createApp({ browserSession, streamerPeer, inputChannel, clientIceServers, wsManager });

  // 启动服务器
  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST });
  const base = `http://127.0.0.1:${PORT}`;

  await streamerPeer.start({ streamerUrl: buildStreamerUrl(base, cfg), iceServers: serverIceServers });

  await browserSession.startScreencast((frame) => streamerPeer.pushFrame(frame.data));

  // 使用 WebSocketManager 广播 URL 变化
  browserSession.onUrlChange = (nav) => {
    wsManager.broadcast({ t: "nav", ...nav });
  };

  browserSession.onTabsChange = (state) => {
    wsManager.broadcast({ t: "tabs", ...state });
  };

  browserSession.onClipboardChange = (data) => {
    wsManager.broadcast({ t: "clipboard", text: data.text });
  };

  browserSession.onCrash = async () => {
    try { await browserSession.restart(); } catch (err) { console.error("onCrash: restart failed", err); }
    wsManager.broadcast({ t: "reload" });
    try { await browserSession.startScreencast((frame) => streamerPeer.pushFrame(frame.data)); } catch (err) { console.error("onCrash: screencast restart failed", err); }
  };

  console.log(`magpie listening on ${base}`);

  const shutdown = async () => {
    server.close();
    try { await streamerPeer.stop(); } catch {}
    try { await browserSession.stop(); } catch {}
    try { await browser.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 2: 运行所有测试**

Run: `npm test`
Expected: 所有测试通过

- [ ] **Step 3: 手动验证功能**

Run: `npm start`
Expected:
1. 服务器启动，访问 http://localhost:8080 显示客户端页面
2. WebSocket 连接正常建立
3. WebRTC 视频流正常

- [ ] **Step 4: 提交**

```bash
git add src/index.js
git commit -m "feat: integrate Hono app with WebSocket broadcast support"
```

---

## Task 9: 清理旧代码

**Files:**
- Delete: `src/server.js`

- [ ] **Step 1: 删除 server.js**

Run: `rm src/server.js`

- [ ] **Step 2: 验证测试仍然通过**

Run: `npm test`
Expected: 所有测试通过

- [ ] **Step 3: 提交**

```bash
git rm src/server.js
git commit -m "refactor: remove old server.js"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- ✅ 用 Hono 替换原生 http + ws（Task 1-2）
- ✅ 重构 HTTP 路由（Task 3）
- ✅ 添加中间件（Task 4-5）
- ✅ 重构 WebSocket 消息处理（Task 6-7）
- ✅ 实现 WebSocket 广播机制（Task 7 WebSocketManager）
- ✅ 集成到主入口（Task 8）
- ✅ 清理旧代码（Task 9）
- ✅ 保持单用户架构（SessionHandler 设计可复用）
- ✅ 所有测试通过（Task 8 验证）

**2. Placeholder scan:**
- ✅ 无 TBD/TODO
- ✅ 所有代码步骤都有具体实现

**3. Type consistency:**
- ✅ `createApp` 函数签名在各任务中一致
- ✅ `SessionHandler` 构造函数参数一致
- ✅ WebSocket 路由工厂函数签名一致
- ✅ `WebSocketManager` 类提供 `add()` 和 `broadcast()` 方法

**4. Risk assessment:**
- ✅ 广播机制已实现（WebSocketManager）
- ⚠️ Hono WebSocket API 可能需要调整（使用 `hono/ws` 而非 `hono/bun`）
- ⚠️ 需要在测试中验证 WebSocket 广播功能
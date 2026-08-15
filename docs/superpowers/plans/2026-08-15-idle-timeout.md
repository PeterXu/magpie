# 浏览器空闲超时释放功能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 添加浏览器空闲超时释放功能，当没有客户端连接超过指定时间时自动关闭浏览器以节省资源

**Architecture:** 创建独立的 IdleTimeoutManager 类管理空闲超时逻辑，WebSocketManager 继承 EventEmitter 发射连接变化事件，在 index.js 中协调组件依赖关系

**Tech Stack:** Node.js, EventEmitter, ESM

## Global Constraints

- 环境变量：`MAGPIE_IDLE_TIMEOUT`（分钟，默认30）
- 日志格式：`[IdleTimeout]` 和 `[Connection]` 前缀
- ESM 模块：使用 `import/export` 语法
- 错误处理：所有异步操作使用 try-catch
- 定时检查间隔：每分钟检查一次

---

## Task 1: 修改 WebSocketManager 继承 EventEmitter

**Files:**
- Modify: `src/websocket/WebSocketManager.js:1-22`

**Interfaces:**
- Consumes: 无
- Produces: `connection-change` 事件，参数为 `clientCount` (number)

- [ ] **Step 1: 修改 WebSocketManager 继承 EventEmitter**

在文件顶部添加 EventEmitter 导入，修改类定义：

```javascript
import { EventEmitter } from 'events';

export class WebSocketManager extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
  }
```

- [ ] **Step 2: 在 add() 方法中添加事件发射**

修改 `add()` 方法，在添加连接和删除连接时发射事件：

```javascript
add(ws) {
  this.clients.add(ws);
  // 发射连接变化事件
  this.emit('connection-change', this.clients.size);
  
  ws.on('close', () => {
    this.clients.delete(ws);
    // 发射连接变化事件
    this.emit('connection-change', this.clients.size);
  });
}
```

- [ ] **Step 3: 验证语法**

```bash
node --check src/websocket/WebSocketManager.js
```

Expected: 无输出（语法正确）

- [ ] **Step 4: 运行现有测试**

```bash
npm test
```

Expected: 所有测试通过（110/110）

- [ ] **Step 5: 提交改动**

```bash
git add src/websocket/WebSocketManager.js
git commit -m "feat: WebSocketManager 继承 EventEmitter，发射 connection-change 事件"
```

---

## Task 2: 创建 IdleTimeoutManager 类

**Files:**
- Create: `src/utils/IdleTimeoutManager.js`

**Interfaces:**
- Consumes: `BrowserSession` 实例，`StreamerPeer` 实例，`timeoutMinutes` 配置
- Produces: `start()`, `stop()`, `handleConnectionChange(clientCount)` 方法

- [ ] **Step 1: 创建 IdleTimeoutManager.js 文件**

创建新文件 `src/utils/IdleTimeoutManager.js`，包含完整的类实现：

```javascript
/**
 * IdleTimeoutManager - 管理浏览器空闲超时释放
 * 
 * 监听 WebSocket 连接变化，当没有客户端连接超过指定时间时，
 * 自动关闭浏览器实例以释放资源。当新客户端连接时自动重启。
 */
export class IdleTimeoutManager {
  /**
   * @param {Object} options
   * @param {BrowserSession} options.browserSession - 浏览器会话实例
   * @param {StreamerPeer} options.streamerPeer - 流媒体实例
   * @param {number} options.timeoutMinutes - 超时时间（分钟）
   */
  constructor({ browserSession, streamerPeer, timeoutMinutes = 30 }) {
    this._browserSession = browserSession;
    this._streamerPeer = streamerPeer;
    this._timeoutMinutes = timeoutMinutes;
    
    this._lastDisconnectTime = null;
    this._browserStopped = false;
    this._checkInterval = null;
  }
  
  /**
   * 启动空闲超时管理
   */
  start() {
    if (this._timeoutMinutes <= 0) {
      console.log('[IdleTimeout] Idle timeout disabled');
      return;
    }
    
    // 每分钟检查一次
    this._checkInterval = setInterval(() => this._checkIdle(), 60 * 1000);
    console.log(`[IdleTimeout] Idle timeout enabled: ${this._timeoutMinutes} minutes`);
  }
  
  /**
   * 停止空闲超时管理
   */
  stop() {
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
      this._checkInterval = null;
    }
  }
  
  /**
   * 处理连接数量变化
   * @param {number} clientCount - 当前客户端数量
   */
  handleConnectionChange(clientCount) {
    console.log(`[Connection] Client count: ${clientCount}`);
    
    if (clientCount === 0) {
      // 最后一个客户端断开
      this._lastDisconnectTime = Date.now();
      console.log('[Connection] Last client disconnected, idle timer started');
    } else {
      // 有客户端连接
      this._lastDisconnectTime = null;
      
      // 如果浏览器已停止，重启
      if (this._browserStopped) {
        this._ensureBrowserRunning();
      }
    }
  }
  
  /**
   * 检查是否需要关闭浏览器
   */
  async _checkIdle() {
    if (!this._lastDisconnectTime || this._browserStopped) {
      return;
    }
    
    const idleMinutes = (Date.now() - this._lastDisconnectTime) / 1000 / 60;
    
    if (idleMinutes >= this._timeoutMinutes) {
      console.log(`[IdleTimeout] Browser idle for ${idleMinutes.toFixed(1)} minutes, stopping...`);
      try {
        await this._browserSession.stop();
        this._browserStopped = true;
        this._lastDisconnectTime = null;
        console.log('[IdleTimeout] Browser stopped successfully');
      } catch (err) {
        console.error('[IdleTimeout] Failed to stop browser:', err);
      }
    }
  }
  
  /**
   * 确保浏览器运行
   */
  async _ensureBrowserRunning() {
    if (!this._browserStopped) {
      return;
    }
    
    console.log('[IdleTimeout] New client connecting, restarting browser...');
    try {
      await this._browserSession.start();
      await this._browserSession.startScreencast(
        (frame) => this._streamerPeer.pushFrame(frame.data)
      );
      this._browserStopped = false;
      this._lastDisconnectTime = null;
      console.log('[IdleTimeout] Browser restarted successfully');
    } catch (err) {
      console.error('[IdleTimeout] Failed to restart browser:', err);
    }
  }
}
```

- [ ] **Step 2: 验证语法**

```bash
node --check src/utils/IdleTimeoutManager.js
```

Expected: 无输出（语法正确）

- [ ] **Step 3: 提交文件**

```bash
git add src/utils/IdleTimeoutManager.js
git commit -m "feat: create IdleTimeoutManager class for browser idle timeout"
```

---

## Task 3: 在 index.js 中集成 IdleTimeoutManager

**Files:**
- Modify: `src/index.js:1-138`

**Interfaces:**
- Consumes: Task 1 的 WebSocketManager 事件，Task 2 的 IdleTimeoutManager
- Produces: 集成后的主程序，启动空闲超时管理

- [ ] **Step 1: 添加 IdleTimeoutManager 导入**

在 `src/index.js` 文件顶部的导入部分添加：

```javascript
import { IdleTimeoutManager } from "./utils/IdleTimeoutManager.js";
```

- [ ] **Step 2: 在 main() 函数中创建 IdleTimeoutManager**

在创建 `wsManager` 之后，添加以下代码：

```javascript
// 创建空闲超时管理器
const idleTimeoutManager = new IdleTimeoutManager({
  browserSession,
  streamerPeer,
  timeoutMinutes: Number(process.env.MAGPIE_IDLE_TIMEOUT || 30)
});
```

- [ ] **Step 3: 监听 WebSocketManager 的 connection-change 事件**

在 `wsManager` 创建后添加事件监听：

```javascript
// 监听连接变化
wsManager.on('connection-change', (clientCount) => {
  idleTimeoutManager.handleConnectionChange(clientCount);
});
```

- [ ] **Step 4: 启动空闲超时管理**

在事件监听后添加启动代码：

```javascript
// 启动空闲超时管理
idleTimeoutManager.start();
```

- [ ] **Step 5: 修改 shutdown 函数添加清理**

修改 `shutdown` 函数，在开头添加停止空闲管理：

```javascript
const shutdown = async () => {
  idleTimeoutManager.stop();  // 停止空闲管理
  server.close();
  try { await streamerPeer.stop(); } catch {}
  try { await browserSession.stop(); } catch {}
  process.exit(0);
};
```

- [ ] **Step 6: 验证语法**

```bash
node --check src/index.js
```

Expected: 无输出（语法正确）

- [ ] **Step 7: 运行测试**

```bash
npm test
```

Expected: 所有测试通过（110/110）

- [ ] **Step 8: 提交改动**

```bash
git add src/index.js
git commit -m "feat: integrate IdleTimeoutManager into main application"
```

---

## Task 4: 编写 IdleTimeoutManager 单元测试

**Files:**
- Create: `test/utils/IdleTimeoutManager.test.js`

**Interfaces:**
- Consumes: Task 2 的 IdleTimeoutManager 类
- Produces: 单元测试验证功能正确性

- [ ] **Step 1: 创建测试文件**

创建 `test/utils/IdleTimeoutManager.test.js`：

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { IdleTimeoutManager } from "../../src/utils/IdleTimeoutManager.js";

test("IdleTimeoutManager: constructor initializes with default timeout", () => {
  const browserSession = {};
  const streamerPeer = {};
  const manager = new IdleTimeoutManager({ browserSession, streamerPeer });
  
  assert.equal(manager._timeoutMinutes, 30);
  assert.equal(manager._lastDisconnectTime, null);
  assert.equal(manager._browserStopped, false);
  assert.equal(manager._checkInterval, null);
});

test("IdleTimeoutManager: constructor accepts custom timeout", () => {
  const browserSession = {};
  const streamerPeer = {};
  const manager = new IdleTimeoutManager({ 
    browserSession, 
    streamerPeer, 
    timeoutMinutes: 60 
  });
  
  assert.equal(manager._timeoutMinutes, 60);
});

test("IdleTimeoutManager: start() creates interval for positive timeout", (t, done) => {
  const browserSession = {};
  const streamerPeer = {};
  const manager = new IdleTimeoutManager({ 
    browserSession, 
    streamerPeer, 
    timeoutMinutes: 1 
  });
  
  manager.start();
  assert.ok(manager._checkInterval !== null);
  manager.stop();
  
  done();
});

test("IdleTimeoutManager: start() does nothing for zero timeout", () => {
  const browserSession = {};
  const streamerPeer = {};
  const manager = new IdleTimeoutManager({ 
    browserSession, 
    streamerPeer, 
    timeoutMinutes: 0 
  });
  
  manager.start();
  assert.equal(manager._checkInterval, null);
});

test("IdleTimeoutManager: stop() clears interval", (t, done) => {
  const browserSession = {};
  const streamerPeer = {};
  const manager = new IdleTimeoutManager({ 
    browserSession, 
    streamerPeer, 
    timeoutMinutes: 1 
  });
  
  manager.start();
  manager.stop();
  assert.equal(manager._checkInterval, null);
  
  done();
});

test("IdleTimeoutManager: handleConnectionChange(0) records disconnect time", () => {
  const browserSession = {};
  const streamerPeer = {};
  const manager = new IdleTimeoutManager({ browserSession, streamerPeer });
  
  manager.handleConnectionChange(0);
  
  assert.ok(manager._lastDisconnectTime !== null);
  assert.ok(manager._lastDisconnectTime <= Date.now());
});

test("IdleTimeoutManager: handleConnectionChange(>0) clears disconnect time", () => {
  const browserSession = {};
  const streamerPeer = {};
  const manager = new IdleTimeoutManager({ browserSession, streamerPeer });
  
  manager.handleConnectionChange(0);
  manager.handleConnectionChange(1);
  
  assert.equal(manager._lastDisconnectTime, null);
});
```

- [ ] **Step 2: 运行测试验证通过**

```bash
node --test test/utils/IdleTimeoutManager.test.js
```

Expected: 所有测试通过

- [ ] **Step 3: 提交测试**

```bash
git add test/utils/IdleTimeoutManager.test.js
git commit -m "test: add unit tests for IdleTimeoutManager"
```

---

## Task 5: 编写 WebSocketManager 事件测试

**Files:**
- Create: `test/websocket/WebSocketManager.events.test.js`

**Interfaces:**
- Consumes: Task 1 修改后的 WebSocketManager
- Produces: 验证 `connection-change` 事件正确发射

- [ ] **Step 1: 创建 WebSocketManager 事件测试**

创建 `test/websocket/WebSocketManager.events.test.js`：

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketManager } from "../../src/websocket/WebSocketManager.js";

test("WebSocketManager: emits connection-change event on add", (t, done) => {
  const manager = new WebSocketManager();
  
  manager.on('connection-change', (clientCount) => {
    assert.equal(clientCount, 1);
    done();
  });
  
  const mockWs = { on: () => {} };
  manager.add(mockWs);
});

test("WebSocketManager: emits connection-change event on close", (t, done) => {
  const manager = new WebSocketManager();
  let eventCount = 0;
  
  manager.on('connection-change', (clientCount) => {
    eventCount++;
    if (eventCount === 1) {
      assert.equal(clientCount, 1);
    } else if (eventCount === 2) {
      assert.equal(clientCount, 0);
      done();
    }
  });
  
  const closeHandlers = [];
  const mockWs = { 
    on: (event, handler) => {
      if (event === 'close') closeHandlers.push(handler);
    }
  };
  
  manager.add(mockWs);
  
  // Simulate close event
  closeHandlers.forEach(handler => handler());
});
```

- [ ] **Step 2: 运行测试验证通过**

```bash
node --test test/websocket/WebSocketManager.events.test.js
```

Expected: 所有测试通过

- [ ] **Step 3: 提交测试**

```bash
git add test/websocket/WebSocketManager.events.test.js
git commit -m "test: add event emission tests for WebSocketManager"
```

---

## Task 6: 运行完整测试套件并验证

**Files:**
- Test: 运行所有测试验证功能

**Interfaces:**
- Consumes: Task 1-5 的所有实现
- Produces: 验证后的完整系统

- [ ] **Step 1: 运行完整测试套件**

```bash
npm test
```

Expected: 所有测试通过（至少110个测试）

- [ ] **Step 2: 验证环境变量默认值**

启动服务并检查日志：

```bash
MAGPIE_IDLE_TIMEOUT=5 npm start &
# 检查日志中是否有 "[IdleTimeout] Idle timeout enabled: 5 minutes"
# Ctrl+C 停止服务
```

Expected: 看到 `[IdleTimeout] Idle timeout enabled: 5 minutes` 日志

- [ ] **Step 3: 验证禁用功能**

```bash
MAGPIE_IDLE_TIMEOUT=0 npm start &
# 检查日志中是否有 "[IdleTimeout] Idle timeout disabled"
# Ctrl+C 停止服务
```

Expected: 看到 `[IdleTimeout] Idle timeout disabled` 日志

- [ ] **Step 4: 提交验证记录**

```bash
git commit --allow-empty -m "test: verify idle timeout functionality works correctly"
```

---

## Task 7: 更新文档

**Files:**
- Modify: `README.md` 或创建 `.env.example`

**Interfaces:**
- Consumes: 所有实现功能
- Produces: 用户文档和配置说明

- [ ] **Step 1: 创建或更新 .env.example**

在项目根目录创建或更新 `.env.example` 文件：

```bash
# 空闲超时配置（分钟）
# 默认：30 分钟
# 设置为 0 禁用空闲超时
MAGPIE_IDLE_TIMEOUT=30
```

- [ ] **Step 2: 提交文档**

```bash
git add .env.example
git commit -m "docs: add MAGPIE_IDLE_TIMEOUT to .env.example"
```

---

## Self-Review Checklist

完成计划后，检查以下项目：

### Spec Coverage
- [x] WebSocketManager 继承 EventEmitter - Task 1
- [x] 创建 IdleTimeoutManager 类 - Task 2
- [x] 在 index.js 中集成 - Task 3
- [x] 单元测试覆盖 - Task 4, 5
- [x] 完整测试验证 - Task 6
- [x] 文档更新 - Task 7

### Placeholder Scan
- [x] 无 "TBD" 或 "TODO"
- [x] 无 "implement later"
- [x] 所有代码步骤都有具体代码
- [x] 所有测试步骤都有具体命令

### Type Consistency
- [x] `handleConnectionChange(clientCount)` 参数类型一致
- [x] `start()` 和 `stop()` 方法签名一致
- [x] `connection-change` 事件参数一致

---

## Execution Notes

- **Estimated Time**: 45-60 minutes
- **Risk Level**: 低（新功能，不影响现有功能）
- **Rollback**: `git reset --hard HEAD~7` (回退 7 个 commit)

**Plan complete. Ready for execution.**
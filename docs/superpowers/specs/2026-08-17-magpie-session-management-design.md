# magpie 登录状态管理设计（Phase 2）

> 2026-08-17。基于 Phase 1 持久化功能，新增登录状态可视化管理。

## 1. 背景与目标

magpie 已实现浏览器数据持久化（Phase 1），登录态保存在 `browser-data` 目录。用户需要可视化管理这些登录状态。

| 验收标准 | 验证方法 |
|------|------|
| 列表展示已保存登录态 | UI 显示各 domain 的数据统计 |
| 删除指定 domain | 点击删除后，该 domain 数据被清除 |
| 重新验证登录态 | 支持 quick/full/custom 三种验证策略 |

## 2. 功能设计

### 2.1 核心功能

| 功能 | 描述 |
|------|------|
| 列表展示 | 按 domain 分组显示 cookies、localStorage、IndexedDB 数量 |
| 删除 | 删除指定 domain 的所有数据 |
| 验证 | 三种策略验证登录态是否有效 |
| 访问 | 在远程浏览器中打开该网站 |

### 2.2 验证策略

| 策略 | 原理 | 优点 | 缺点 |
|------|------|------|------|
| quick | 仅检查 cookie 存在性 | 快速，无网络请求 | 不准确 |
| full | 后台 tab 访问检测 | 准确 | 耗时，可能触发风控 |
| custom | 用户预配置规则 | 最准确，可定制 | 需要预配置 |

## 3. 架构设计

### 3.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│  client.html                                                │
│  ┌──────────┐  ┌────────────────────────────────────────────┐│
│  │ 左侧导航  │  │ 右侧内容                                    ││
│  │ ├ 项目介绍│  │ ┌────────────────────────────────────────┐││
│  │ ├ 远程访问│  │ │ 登录状态管理面板                        │││
│  │ └ 登录状态│  │ │ - 网站列表（domain, 数据统计, 状态）    │││
│  └──────────┘  │ │ - 操作：删除、验证、访问                 │││
│                │ └────────────────────────────────────────────┘││
└─────────────────────────────────────────────────────────────┘
                              │ HTTP API
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  后端 API (src/routes/api/sessions.js)                       │
│  GET    /api/sessions           → 列表                       │
│  DELETE /api/sessions/:domain   → 删除                       │
│  POST   /api/sessions/:domain/check → 验证                   │
│  POST   /api/sessions/:domain/visit → 访问                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  SessionRegistry (src/session/SessionRegistry.js)            │
│  - 通过 Playwright API 获取/删除数据                         │
│  - 三种验证策略实现                                          │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 数据范围

| 数据类型 | 获取方式 | 备注 |
|----------|----------|------|
| Cookies | `context.cookies()` | 直接获取 |
| localStorage | 需打开对应 origin | 遍历已访问的 domain |
| IndexedDB | 需打开对应 origin | 遍历已访问的 domain |

## 4. 模块设计

### 4.1 SessionRegistry

**文件**: `src/session/SessionRegistry.js`

```javascript
export class SessionRegistry {
  constructor({ browserSession }) {
    this._browserSession = browserSession;
  }

  /**
   * 获取所有 domain 及其数据统计
   * @returns {Promise<Array<{domain, cookies, localStorage, indexedDB, lastCheck, status}>>}
   */
  async list() { ... }

  /**
   * 删除指定 domain 的所有数据
   * @param {string} domain
   */
  async delete(domain) { ... }

  /**
   * 验证登录态
   * @param {string} domain
   * @param {string} strategy - 'quick' | 'full' | 'custom'
   * @returns {Promise<{valid: boolean, details: object}>}
   */
  async check(domain, strategy = 'quick') { ... }
}
```

### 4.2 REST API

**文件**: `src/routes/api/sessions.js`

| 端点 | 方法 | 描述 | 请求 | 响应 |
|------|------|------|------|------|
| `/api/sessions` | GET | 获取列表 | - | `{ sessions: [...] }` |
| `/api/sessions/:domain` | DELETE | 删除 | - | `{ success: true }` |
| `/api/sessions/:domain/check` | POST | 验证 | `{ strategy? }` | `{ valid, details }` |
| `/api/sessions/:domain/visit` | POST | 访问 | - | `{ success: true }` |

## 5. UI 设计

### 5.1 左侧导航

在现有导航项下新增：

```html
<div class="nav-item" data-panel="sessions">
  <span class="nav-icon">🔐</span>
  <span class="nav-text">登录状态管理</span>
</div>
```

### 5.2 面板布局

```
┌─────────────────────────────────────────────────────────────┐
│  登录状态管理                                     [刷新]     │
├─────────────────────────────────────────────────────────────┤
│  taobao.com                                    [验证] [删除]│
│  12 cookies • 2 localStorage                                │
│  最后验证: 2小时前 • 状态: ✓ 已登录                          │
├─────────────────────────────────────────────────────────────┤
│  jd.com                                        [验证] [删除]│
│  8 cookies • 1 localStorage                                 │
│  最后验证: 未验证 • 状态: ? 未知                             │
├─────────────────────────────────────────────────────────────┤
│  github.com                                    [验证] [删除]│
│  5 cookies                                                  │
│  最后验证: 1天前 • 状态: ✗ 已过期                            │
└─────────────────────────────────────────────────────────────┘
```

### 5.3 交互设计

| 操作 | 行为 |
|------|------|
| 点击"验证" | 下拉菜单选择策略（quick/full/custom） |
| 点击"删除" | 确认对话框 → 删除 |
| 点击域名 | 在远程浏览器中打开该网站 |
| 点击"刷新" | 重新获取列表 |

## 6. 技术细节

### 6.1 localStorage/IndexedDB 获取

**挑战**: localStorage/IndexedDB 需要打开对应 origin 才能访问。

**方案**:
1. 维护 `visitedOrigins` 列表，记录用户访问过的 domain
2. 获取列表时，遍历这些 origin 获取数据
3. 对于未访问过的 domain，只显示 cookies

### 6.2 登录态判定逻辑

**判断是否为登录页**:
- URL 包含 `login`、`signin`、`auth` 等关键词
- 页面包含 `<input type="password">` 元素
- HTTP 状态码为 401/403

**判断是否已登录**:
- URL 不包含登录关键词
- 页面包含用户信息元素

### 6.3 自定义规则配置

**文件**: `browser-data/session-rules.json`

```json
{
  "rules": {
    "taobao.com": {
      "checkUrl": "https://www.taobao.com",
      "loggedInPattern": "\"isLoggedIn\":true",
      "loginPagePattern": "login.taobao.com"
    },
    "github.com": {
      "checkUrl": "https://github.com",
      "loggedInSelector": "meta[name=\"user-login\"]",
      "loginPagePattern": "github.com/login"
    }
  }
}
```

## 7. 实施计划

| 步骤 | 文件 | 内容 |
|------|------|------|
| 1 | `src/session/SessionRegistry.js` | 新增模块 |
| 2 | `src/routes/api/sessions.js` | 新增 REST API |
| 3 | `src/app.js` | 注册路由 |
| 4 | `src/index.js` | 初始化 SessionRegistry |
| 5 | `src/public/client.html` | 添加面板 UI |
| 6 | `browser-data/session-rules.json` | 预置常用规则 |
| 7 | 测试 | 验证功能 |

## 8. 测试设计

### 8.1 单元测试

| 测试项 | 测试内容 |
|--------|----------|
| SessionRegistry.list() | 正确按 domain 分组统计 |
| SessionRegistry.delete() | 正确清除数据 |
| SessionRegistry.check('quick') | 正确检查 cookie 存在性 |
| 登录页判断逻辑 | 正确识别登录页 |

### 8.2 集成测试

| 测试项 | 测试内容 |
|--------|----------|
| API 端点 | 请求正确响应 |
| 删除操作 | 数据被清除 |
| 验证操作 | 返回正确状态 |

### 8.3 E2E 测试

| 测试项 | 测试内容 |
|--------|----------|
| UI 显示 | 列表正确渲染 |
| 删除流程 | 用户操作生效 |
| 验证流程 | 状态正确更新 |

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| localStorage/IndexedDB 获取耗时 | 异步加载，先显示 cookies |
| 验证触发网站风控 | 限制频率，添加延迟 |
| 自定义规则配置复杂 | 提供默认规则，简化 UI |
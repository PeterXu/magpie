# Magpie Hono 改造设计

**日期**: 2026-08-11
**作者**: Claude
**状态**: 设计阶段

---

## 背景

当前 magpie 使用原生 `node:http` + `ws` 库，存在以下问题：
- HTTP 路由是手动的 if-else 链
- WebSocket 消息处理集中在一个大回调里
- 没有中间件系统，错误处理分散
- 代码组织不够清晰，难以扩展

目标：引入 Hono 框架，改进 HTTP 路由组织和代码结构，并支持多客户端连接。

---

## 整体方案：3 阶段演进

### 架构演进

**当前架构**（单用户）：
```
客户端 → WebSocket → 全局 StreamerPeer → WebRTC
                       ↓
                   BrowserSession（共享）
```

**目标架构**（多用户）：
```
客户端 A → WebSocket A → Session A → StreamerPeer A
                                   ↓
客户端 B → WebSocket B → Session B → StreamerPeer B
                                   ↓
                               共享 BrowserSession
                                   ↓
                              单个 Chromium 实例
```

**核心概念**：
- **一个 client → 一个 WebSocket → 一个 Session → 一个 WebRTC 实例**
- **BrowserSession 全局共享**（所有 client 看到同一个浏览器画面）
- **StreamerPeer 变成会话级实例**（每个 client 独立的 WebRTC 连接）

---

## 第一阶段：引入 Hono + 代码重构（单用户）

### 目标
- 用 Hono 替换原生 `http` + `ws`
- 重构 HTTP 路由和 WebSocket 消息处理
- 保持单用户架构不变
- 为后续多客户端预留扩展点

### 改动范围

**依赖变化**：
- 移除：`ws`
- 新增：`hono` + `@hono/node-server`
- 依赖从 2 个 → 3 个（仍保持轻量）

**文件结构**：
```
src/
├── app.js                    ← Hono 应用入口
├── index.js                  ← 启动逻辑（调整）
├── routes/
│   ├── health.js             ← GET /healthz
│   ├── static.js             ← 静态文件路由
│   └── ws/
│       ├── signaling.js      ← WebSocket /signaling
│       └── internal.js       ← WebSocket /internal
├── handlers/
│   └── signaling/
│       ├── SessionHandler.js ← 消息处理器（可复用）
│       └── *.js              ← 各类消息处理函数
└── middleware/
    ├── errorHandler.js       ← 统一错误处理
    └── logger.js             ← 请求日志
```

### 扩展点设计

**消息处理器设计**：
- 设计为可复用类，接受依赖注入
- 阶段 1 作为单例使用
- 阶段 2 可直接用于多客户端 Session

**WebSocket 路由设计**：
- 支持依赖注入（browserSession, streamerPeer）
- 为 Session 预留接口（阶段 1 不实现）

### 验证标准
- 所有现有测试通过
- 功能与改造前完全一致
- 代码结构更清晰

---

## 第二阶段：多客户端会话管理

### 目标
- 引入 SessionManager + Session 类
- 每个 WebSocket 连接创建独立 Session
- 每个 Session 有独立的 WebRTC 实例
- BrowserSession 全局共享

### 改动范围

**新增模块**：
- `src/session/SessionManager.js` - 会话生命周期管理
- `src/session/Session.js` - 单个会话（包含 WebRTC 实例）

**核心变化**：
- StreamerPeer 从全局单例 → 会话级实例
- WebSocket 路由集成会话管理
- 消息处理器与 Session 绑定

---

## 第三阶段：高级特性（可选）

### 目标
- 会话恢复（WebSocket 断线重连）
- 会话权限控制
- 会话监控面板
- 性能优化（WebRTC 实例池）

### 改动范围
- 会话状态持久化
- 权限中间件
- 监控 API

---

## 风险与缓解

**风险 1：Hono 与现有 WebSocket 逻辑不兼容**
- 缓解：第一阶段保持单用户，充分测试验证

**风险 2：多客户端资源竞争**
- 缓解：第二阶段引入会话管理，独立 WebRTC 实例

**风险 3：性能下降**
- 缓解：Hono 轻量级设计，监控关键指标

---

## 参考资料
- [Hono 官方文档](https://hono.dev/)
- [Hono WebSocket 支持](https://hono.dev/helpers/websocket)
- [Magpie 原始架构设计](./2026-08-08-magpie-remote-browser-design.md)
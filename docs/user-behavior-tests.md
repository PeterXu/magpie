# Magpie 用户行为测试对照表

**目的**: 记录所有用户交互场景及其测试覆盖，供开发者快速定位和验证功能。

**更新日期**: 2026-08-11

---

## 1. 标签页管理

### 1.1 新建标签页

**用户行为**:
- 点击客户端 UI 的 "+" 按钮
- 点击远程浏览器中的 `target="_blank"` 链接

**预期结果**:
- ✅ 新标签页自动打开
- ✅ **自动切换**到新标签页（用户无需手动点击切换）
- ✅ 标签栏实时更新，显示新标签页

**测试文件**: `test/browser/BrowserSession.tabs.test.js`
- `BrowserSession: _registerPage captures new pages`
- `BrowserSession: switchPage switches active and screencast target`

**实现文件**: `src/browser/BrowserSession.js:261-277`
- `context.on('page')` 捕获新页面事件
- 自动调用 `switchPage(id)` 切换到新标签页

**关键代码**:
```javascript
// src/browser/BrowserSession.js:274-276
else {
  // Auto-switch to new tabs: target="_blank" links or other automatic openings
  this.switchPage(id).catch(() => {});
}
```

**注意事项**:
- 新标签页创建后立即切换，无需等待导航完成
- 切换失败时静默处理（catch），不影响用户体验
- 标签页 ID 自增，不重复使用

---

### 1.2 切换标签页

**用户行为**:
- 点击客户端标签栏中的标签页

**预期结果**:
- ✅ 视频流切换到对应标签页
- ✅ 标签栏高亮更新
- ✅ URL 栏显示新标签页的 URL

**测试文件**: `test/browser/BrowserSession.tabs.test.js`
- `BrowserSession: switchPage switches active and screencast target`

**实现文件**: `src/browser/BrowserSession.js:148-152`
- `switchPage(pageId)` 切换活动标签页
- `_switchTo(pageId)` 内部切换逻辑（停止旧 screencast，启动新 screencast）

**关键代码**:
```javascript
// src/browser/BrowserSession.js:148-152
async switchPage(pageId) {
  await this._switchTo(pageId);
  this._fireTabsChange();
}
```

**注意事项**:
- 切换前会停止旧标签页的 screencast
- 切换后会启动新标签页的 screencast
- 失败时不会抛出错误，静默处理

---

### 1.3 关闭标签页

**用户行为**:
- 点击标签栏中的关闭按钮（x）

**场景 A: 关闭非活动标签页**
- ✅ 标签页从列表中移除
- ✅ 当前活动标签页不变
- ✅ 视频流继续播放当前标签页

**场景 B: 关闭活动标签页（有其他标签页）**
- ✅ 自动切换到最后一个剩余标签页
- ✅ 视频流切换到新活动标签页

**场景 C: 关闭最后一个标签页**
- ✅ 自动创建新的空白标签页（`about:blank`）
- ✅ 自动切换到新标签页

**测试文件**: `test/browser/BrowserSession.tabs.test.js`
- `BrowserSession: closePage on non-active removes it`
- `BrowserSession: closePage on active switches to remaining`
- `BrowserSession: closing last tab creates new about:blank`

**实现文件**: `src/browser/BrowserSession.js:199-217`

**关键代码**:
```javascript
// src/browser/BrowserSession.js:204-213
if (pageId === this._activePageId) {
  const remaining = [...this._pages.keys()];
  if (remaining.length > 0) {
    this.switchPage(remaining[remaining.length - 1]).catch(() => {});
  } else {
    this._createBlankPage().catch(() => {});
  }
}
```

---

### 1.4 标签页状态广播

**用户行为**:
- 打开、关闭、切换标签页
- 标签页标题变化

**预期结果**:
- ✅ 服务端通过 WebSocket 广播 `{t: 'tabs', pages, activeId}`
- ✅ 客户端实时更新标签栏 UI

**测试文件**: `test/browser/BrowserSession.tabs.test.js`
- `BrowserSession: onTabsChange fires on open/close/switch`

**实现文件**: `src/browser/BrowserSession.js:110-114`

---

## 2. 导航操作

### 2.1 URL 导航

**用户行为**:
- 在 URL 栏输入新地址并回车

**预期结果**:
- ✅ 远程浏览器导航到新 URL
- ✅ URL 栏更新显示新地址
- ✅ 前进/后退按钮状态更新

**测试文件**: `test/browser/BrowserSession.tabs.test.js`
- `BrowserSession: navigate changes url`
- `BrowserSession: getNavState tracks back/forward history`

**实现文件**: 
- `src/handlers/signaling/SessionHandler.js:34-38`
- `src/browser/BrowserSession.js` (navigate 方法)

---

### 2.2 前进/后退/刷新

**用户行为**:
- 点击前进、后退、刷新按钮

**预期结果**:
- ✅ 远程浏览器执行对应操作
- ✅ URL 栏更新
- ✅ 历史记录状态正确

**测试文件**: 
- `test/browser/BrowserSession.tabs.test.js`
  - `BrowserSession: getNavState tracks back/forward history`
  - `BrowserSession: reload keeps url, no throw`

**实现文件**: `src/handlers/signaling/SessionHandler.js`
- `handleBack()` - 后退
- `handleForward()` - 前进
- `handleRefresh()` - 刷新

---

## 3. 剪贴板操作

### 3.1 复制（Ctrl/Cmd+C）

**用户行为**:
- 在远程浏览器中选中文本
- 按下 Ctrl+C 或 Cmd+C

**预期结果**:
- ✅ 服务端读取远程剪贴板内容
- ✅ 通过 WebSocket 发送 `{t: 'clipboard', text: '...'}`
- ✅ 客户端接收后写入本地剪贴板

**测试文件**: `test/browser/BrowserSession.clipboard.test.js`
- `handleCopy reads clipboard from remote browser`

**实现文件**: 
- `src/browser/BrowserSession.js` (clipboard 相关)
- `src/webrtc/InputChannel.js`

---

### 3.2 粘贴（Ctrl/Cmd+V）

**用户行为**:
- 按下 Ctrl+V 或 Cmd+V
- 本地剪贴板有内容

**预期结果**:
- ✅ 客户端读取本地剪贴板
- ✅ 发送 `{t: 'paste', text: '...'}` 到服务端
- ✅ 服务端调用 CDP `Input.insertText` 插入文本

**测试文件**: 
- `test/browser/BrowserSession.clipboard.test.js`
- `test/e2e.clipboard.test.js`

**边界情况**:
- 文本长度限制 100KB，超出部分截断
- 测试: `insertText limits text to 100KB`

---

## 4. 输入处理

### 4.1 鼠标点击

**用户行为**:
- 在视频区域点击

**预期结果**:
- ✅ 坐标正确映射到远程浏览器
- ✅ CDP `Input.dispatchMouseEvent` 发送
- ✅ 远程页面响应点击

**测试文件**: `test/browser/BrowserSession.tabs.test.js`
- `BrowserSession: mouse click registers on the page`

**实现文件**: 
- `src/webrtc/coords.js` - 坐标映射
- `src/webrtc/InputChannel.js` - 输入分发

**关键逻辑**:
```javascript
// 坐标转换：客户端视频矩形 → 远程页面坐标
const pageX = clientX * (pageWidth / displayWidth);
const pageY = clientY * (pageHeight / displayHeight);
```

---

### 4.2 键盘输入

**用户行为**:
- 在视频区域按键

**预期结果**:
- ✅ 按键事件正确映射（key, code, virtualKeyCode）
- ✅ CDP `Input.dispatchKeyEvent` 发送
- ✅ 远程页面响应输入

**测试文件**: `test/browser/BrowserSession.tabs.test.js`
- `BrowserSession: key dispatch types into input`

**实现文件**: `src/webrtc/keys.js`

---

### 4.3 滚轮滚动

**用户行为**:
- 在视频区域滚动滚轮

**预期结果**:
- ✅ 滚轮事件正确映射（deltaX, deltaY）
- ✅ CDP `Input.dispatchMouseEvent` 发送
- ✅ 远程页面响应滚动

**测试文件**: `test/webrtc/InputChannel.test.js`
- `InputChannel: maps + dispatches wheel`

---

## 5. WebRTC 视频流

### 5.1 视频连接建立

**用户行为**:
- 打开客户端页面

**预期结果**:
- ✅ WebSocket 连接到 `/signaling`
- ✅ 收到 `{t: 'hello', viewport, url, iceServers, ...}`
- ✅ WebRTC 连接建立
- ✅ 视频开始在 `<video>` 元素播放

**测试文件**: 
- `test/e2e.test.js`
  - `e2e: client sees video and a click reaches the target page`
- `test/spike.capturestream.test.js`

**实现文件**: 
- `src/routes/ws/signaling.js`
- `src/streamer/StreamerPeer.js`

---

### 5.2 视频帧传输

**技术流程**:
1. CDP `Page.startScreencast` → JPEG 帧
2. Node 通过 `/internal` WebSocket 发送到 streamer 页面
3. streamer 页面绘制到 `<canvas>` → `captureStream()`
4. WebRTC 编码传输 → 客户端 `<video>`

**测试文件**: 
- `test/browser/BrowserSession.tabs.test.js`
  - `BrowserSession: start + screencast yields JPEG frames`
- `test/streamer/StreamerPeer.test.js`

---

## 6. 连接状态管理

### 6.1 断开重连

**用户行为**:
- 网络中断
- 手动点击"停止远程"

**预期结果**:
- ✅ WebSocket 连接正确关闭
- ✅ WebRTC 连接清理
- ✅ 可以重新连接

**测试文件**: `test/e2e.clipboard.test.js`
- `e2e clipboard: disconnect and reconnect`

**实现文件**: `src/public/client.html`

---

### 6.2 浏览器崩溃恢复

**场景**: Chromium 进程崩溃

**预期结果**:
- ✅ `onCrash` 回调触发
- ✅ 自动重启 BrowserSession
- ✅ 广播 `{t: 'reload'}` 到所有客户端
- ✅ 客户端重新加载页面

**测试文件**: `test/browser/BrowserSession.crash.test.js`
- `BrowserSession: onCrash fires and restart() recovers`
- `BrowserSession: onCrash re-entrancy guard`
- `BrowserSession: onCrash guard resets after restart`

**实现文件**: `src/browser/BrowserSession.js`
- 重入保护：`_crashFired` 标志防止重复触发
- 自动恢复：调用 `restart()` 重启会话

---

## 7. 边界情况与错误处理

### 7.1 并发操作保护

**场景**: 用户快速点击"+"按钮多次

**预期结果**:
- ✅ 使用 `_newPageInProgress` 锁防止并发
- ✅ 后续点击被忽略，不会创建多个标签页

**测试文件**: `test/browser/BrowserSession.concurrent.test.js`
- `BrowserSession: rapid newPage() calls don't hang`
- `BrowserSession: concurrent newPage() with lock works correctly`

---

### 7.2 静态文件路由

**特殊路由**:
- `/.well-known/*` - 立即返回 404（跳过 Chrome DevTools 自动请求）
- `/healthz` - 健康检查，返回 "ok"

**实现文件**: `src/routes/static.js`

---

## 8. 配置与环境

### 8.1 环境变量验证

**测试覆盖**:
- ✅ `MAGPIE_FPS` - 帧率限制，非法值回退默认值
- ✅ `MAGPIE_QUALITY` - JPEG 质量 1-100，超出范围 clamp
- ✅ `MAGPIE_WIDTH/HEIGHT` - 分辨率限制
- ✅ `MAGPIE_MAX_BITRATE` - 比特率限制

**测试文件**: `test/config.test.js`

---

## 快速索引

| 用户行为 | 测试文件 | 实现文件 |
|---------|---------|---------|
| 新建标签页（自动切换） | `BrowserSession.tabs.test.js` | `BrowserSession.js:261-277` |
| 切换标签页 | `BrowserSession.tabs.test.js` | `BrowserSession.js:148-152` |
| 关闭标签页 | `BrowserSession.tabs.test.js` | `BrowserSession.js:199-217` |
| URL 导航 | `BrowserSession.tabs.test.js` | `SessionHandler.js:34-38` |
| 剪贴板复制 | `BrowserSession.clipboard.test.js` | `InputChannel.js` |
| 剪贴板粘贴 | `BrowserSession.clipboard.test.js` | `InputChannel.js` |
| 鼠标点击 | `BrowserSession.tabs.test.js` | `coords.js`, `InputChannel.js` |
| 键盘输入 | `BrowserSession.tabs.test.js` | `keys.js`, `InputChannel.js` |
| 视频连接 | `e2e.test.js` | `signaling.js`, `StreamerPeer.js` |
| 崩溃恢复 | `BrowserSession.crash.test.js` | `BrowserSession.js` |
| 并发保护 | `BrowserSession.concurrent.test.js` | `BrowserSession.js:171-196` |

---

## 注意事项

1. **测试先行**: 所有用户行为都有对应测试，测试文件名与功能模块对应
2. **边界覆盖**: 测试包含正常流程和边界情况（非法输入、并发、崩溃等）
3. **文档同步**: 新增功能时需更新此文档
4. **回归验证**: 修改代码后运行 `npm test` 确保所有测试通过

---

## 相关文档

- [架构设计](./superpowers/specs/2026-08-08-magpie-remote-browser-design.md)
- [Hono 改造计划](./superpowers/specs/2026-08-11-magpie-hono-refactor-design.md)
- [模块映射](../CLAUDE.md#module-map)
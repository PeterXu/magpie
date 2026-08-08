# magpie — 远程浏览器实例服务设计

- 日期:2026-08-08
- 修订:2026-08-08 —— 编码/传输从 werift 改为「CDP + 中继 canvas 页 + Chromium 原生 libwebrtc」。像素采集仍由 CDP screencast 完成。
- 状态:已通过设计评审,待编写实现计划

## 1. 目标

用 Node.js 实现一个名为 **magpie** 的服务,提供 Web 访问接口。服务内部启动一个 Playwright headless Chromium(默认打开 `https://gitee.com`)。外部用户通过 **WebRTC video** 观看该页面,并对其进行操作。

### 会话模型

**单实例单用户**:一个 Chromium + 一个目标页 + 一个对端,同一时间只有一个外部用户。

### v1 能力范围(MVP)

- WebRTC video 观看(基线)
- 鼠标移动 / 点击 / 右键 / 滚动
- 键盘输入(文本 + 常用特殊键 / 组合键)
- 导航 / 改 URL

明确**不**在 v1:剪贴板、音频、多会话、鉴权、运行时 resize、STUN/TURN。

## 2. 技术选型

| 环节 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js + ESM(无构建步骤) | 纯 JS |
| 浏览器控制 | `playwright`(headless Chromium) | 目标页 + streamer 页都由它管理 |
| 像素采集 | CDP `Page.startScreencast` | headless + 任意网站唯一可靠来源;帧落 Node |
| 帧中继 | 内部 WebSocket `/internal`(二进制 JPEG) | Node → streamer 页 |
| 视频编码/传输 | **Chromium 页内原生 libwebrtc**(`canvas.captureStream()` → `RTCPeerConnection`) | 取代 werift;无需 node-canvas、无需手写 I420 |
| 信令 | `ws`(`/signaling`)+ `page.evaluate` 中继 | 客户端 offer → Node → streamer 页 → answer |
| HTTP | 内置 `node:http` | 托管 client/streamer 页 + WS 升级 |

**运行时依赖**:`playwright`、`ws`(仅此两个)。

### 关键约束:为什么 capture 必须用 CDP

任意网站是 DOM,不是 `<canvas>`;`canvas.captureStream()` 只能流化"画到 canvas 上的内容",抓不了网站画面。headless 下:

- `getDisplayMedia()` 需要 OS 屏幕采集后端,**不可用**;
- Playwright **headless 不支持加载扩展**,故 `chrome.tabCapture` 也不可用;
- headed + Xvfb 违背 "headless" 约束,排除。

因此 headless + 任意网站的像素**只能由 CDP `Page.startScreencast` 采集到 Node**。本方案里 canvas + captureStream 的作用是:把 CDP 帧中继进 streamer 页的 canvas 后,用 Chromium 原生 libwebrtc 编码发送(取代 Node 端 werift)。capture 仍是 CDP;canvas 是中转 + libwebrtc 的喂帧入口。

### 方案选择记录

- **选定:CDP + 中继 canvas 页 + libwebrtc** —— 互通是 libwebrtc↔libwebrtc,最稳;编码原生、可 H.264;无需 node-canvas、无手写 I420。代价:多一个 streamer 页 + 帧中继 WS + 信令中继。
- 备选 werift(纯 Node 编码):capture 同样走 CDP,编码/传输在 Node 用 werift 软件 VP8;werift↔libwebrtc 互通是最大风险。本方案用原生 libwebrtc 规避之。

## 3. 模块划分

```
magpie/
├── package.json
├── src/
│   ├── index.js                   # 入口:启动 browser + 各模块 + server
│   ├── server.js                  # HTTP + /signaling WS(客户端)+ /internal WS(帧中继)
│   ├── browser/BrowserSession.js  # 目标页:Playwright 启动 + CDP screencast/input/navigate
│   ├── streamer/
│   │   ├── StreamerPeer.js        # 管理 streamer 页:relayOffer(evaluate)+ pushFrame(/internal)
│   │   └── streamer.html          # canvas + captureStream + RTCPeerConnection + /internal 接收帧
│   ├── webrtc/
│   │   ├── coords.js              # 纯:客户端坐标 → 页面坐标
│   │   ├── keys.js                # 纯:CDP key 映射 + 消息解析
│   │   └── InputChannel.js        # 解析 /signaling 消息 → 映射 → BrowserSession 分发
│   └── public/client.html         # 客户端:/signaling WS + RTCPeerConnection(recvonly)+ 输入采集
└── test/                          # 单元 + 集成 + spike + E2E
```

### 模块职责

- **index.js**:启动一个共享 Playwright browser;创建 `BrowserSession`(目标页)、`StreamerPeer`(streamer 页)、`InputChannel`、`server`,正确连线。
- **server.js**:HTTP 托管 `client.html` / `streamer.html`;`/signaling` WS 处理 offer/navigate/status/input;`/internal` WS 接收 streamer 页连接并交给 `StreamerPeer`。
- **BrowserSession.js**:headless Chromium 目标页(固定 viewport 1280×800),`goto` 默认 URL,CDP session;暴露 `startScreencast(onFrame)` / `stopScreencast()` / `dispatchMouse` / `dispatchWheel` / `dispatchKey` / `navigate` / `getViewport` / `getUrl` / `onCrash` / `restart`。可注入共享 browser。
- **StreamerPeer.js**:在共享 browser 中开一个独立 context+page 加载 `streamer.html`;`setFrameSocket(ws)` 接收 `/internal` 连接;`pushFrame(jpegBuffer)` 二进制下发;`relayOffer(sdp)→answerSdp` 经 `page.evaluate` 调用页面内 `window.relayOffer`。
- **streamer.html**:连 `/internal` WS(`binaryType=arraybuffer`);每帧 `createImageBitmap(blob)→drawImage` 到 `<canvas>`;`canvas.captureStream(fps)` 取 video track;`window.relayOffer(offer)` 建 `RTCPeerConnection`、addTrack、createAnswer、等 ICE 收集完成、返回 answer sdp。
- **coords.js / keys.js / InputChannel.js**:与坐标映射、键映射、消息解析相关的纯逻辑与分发;`InputChannel.handle(raw)` 由 server 在收到 input 类消息时调用。
- **client.html**:连 `/signaling`;`RTCPeerConnection` + `addTransceiver('video',{recvonly:true})` + createOffer;`ontrack` 渲染 `<video>`;采集鼠标/键盘/滚轮,以 JSON 经 `/signaling` 上行;导航栏发 `navigate`。

## 4. 核心数据流

### 视频下行

```
目标页(gitee) ──CDP Page.startScreencast(JPEG)──▶ Node(BrowserSession)
Node ──/internal WS(二进制 JPEG)──▶ streamer 页(Chromium 内)
streamer 页:createImageBitmap → drawImage 到 <canvas> → canvas.captureStream(fps)
            → 页内 RTCPeerConnection(libwebrtc 编码) ──RTP──▶ 客户端 <video>
```

### 输入 / 控制(走 `/signaling` WS,直达 Node→CDP,不经 WebRTC)

```
客户端 ──/signaling WS(JSON: mouse/wheel/key/navigate/status)──▶ Node
Node → InputChannel(坐标映射)→ BrowserSession.dispatch*/navigate(CDP)──▶ 目标页
```

### 信令(WebRTC offer/answer,经 Node 中继到 streamer 页)

```
客户端:createOffer(recvonly video) ──{t:offer,sdp}──▶ /signaling
Node:StreamerPeer.relayOffer(sdp) ==page.evaluate(window.relayOffer)==> streamer 页
streamer 页:setRemoteDescription → addTrack(captureStream 的 track) → createAnswer
            → 等 ICE 收集完成 → 返回 answer sdp
Node ──{t:answer,sdp}──▶ 客户端:setRemoteDescription
```

WebRTC 对端在 streamer 页(Chromium libwebrtc),故 WebRTC 连接**只传视频**(recvonly);输入/控制走 `/signaling` WS。职责分离,避免输入绕经 streamer 页。

**连接时机**:客户端打开页面即发 offer;streamer 页加载即连 `/internal`、备好 canvas + captureStream;目标页 screencast 在有帧时持续推送。

## 5. 关键实现细节与风险

1. **headless `canvas.captureStream()` + 页面作 WebRTC sender(最大风险)**:`--headless=new` 下需 spike 验证能产出视频并被外部对端接收。失败则回退备选(werift)。**计划里设为早期 gate 任务。**
2. **帧中继吞吐**:localhost `/internal` 二进制 JPEG @ ~10-15fps,带宽/延迟可接受;`createImageBitmap` + `drawImage` 解码绘制需跟得上。
3. **输入坐标映射**:CDP `dispatchMouseEvent` 用 CSS 像素;按客户端视频显示尺寸 + 目标 viewport 线性映射(假定无黑边,客户端 video 用 `width:100%;height:auto`)。
4. **键盘映射**:CDP `Input.dispatchKeyEvent` 的 `key/code/windowsVirtualKeyCode/text`;文本走 `char` 事件;覆盖常用键。
5. **信令中继**:`page.evaluate` 调 streamer 页 `window.relayOffer`,返回 answer sdp(JSON 可序列化,字符串无碍)。
6. **多页管理**:同一 browser 实例下,目标页(指定 viewport)与 streamer 页(独立 context)分离;index 负责共享 browser 注入。

## 6. 错误处理

- **无客户端时可暂停 screencast** 省 CPU(单用户);有连接再 start。
- **目标页 / Chromium 崩溃**:重启 `BrowserSession`(重新启动 + 导航 + screencast);streamer 页独立保留,视频自动恢复。
- **解码 / 中继异常**:丢帧继续。
- **导航失败**:回传错误。
- **`/signaling` 断线**:客户端自动重连。

## 7. 测试策略

- **单元**:坐标映射、key 映射、消息解析。
- **集成**:BrowserSession screencast 出帧、CDP 输入注入生效(本地 fixture 页)。
- **Spike + E2E**:headless streamer 页 `captureStream` → WebRTC;真实浏览器(Playwright 起 chromium 当客户端)连接,看到视频并能点击 / 输入 / 导航。

## 8. MVP 边界(YAGNI)

单会话单用户、无鉴权、固定 viewport、无音频、无剪贴板、仅局域网(`iceServers: []`)。以上均可后续迭代。

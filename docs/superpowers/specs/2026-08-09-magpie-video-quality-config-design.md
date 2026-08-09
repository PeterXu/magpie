# magpie — 视频/采集质量定制接口设计

- 日期:2026-08-09
- 状态:已通过设计评审,待编写实现计划
- 上游设计:`docs/superpowers/specs/2026-08-08-magpie-remote-browser-design.md`

> **修正(2026-08-09,实测推翻本文档的 CDP 帧率前提):**
> `Page.startScreencast` **没有 `every` 参数**;CDP 对未知字段静默忽略,故下文
> "`every:100` 把采集上限锁在 10fps" 从未生效——screencast 一直按合成器速率
> 无上限推帧(运动时实测约 98fps)。CDP 唯一的帧率参数是 **`everyNthFrame`**,且
> 它是**帧计数除数**(每隔 N 帧发一帧),不是毫秒间隔、也不是真正的码率上限。
> 实测:静态页面 `everyNthFrame=1` 发 1 帧(初始合成),但 `=2` 或 `=10` 发 **0 帧**
> ——任意 N>1 都会饿死静态/低重绘内容(需累积 N 次重绘才发一帧)。magpie 服务的是
> 任意(常静态)页面,所以 `everyNthFrame` 必须 保持 1(CDP 默认)。结论:**不再从
> fps 派生 CDP 帧率参数**;`screencast` 配置只剩 `quality`。真正决定输出帧率的是
> streamer 页的 `canvas.captureStream(fps)`——CDP 每次重绘推一帧 JPEG,canvas 按
> `fps` 采样。`MAGPIE_FPS` 现在只驱动 `captureStream(fps)`。下文凡是 `every`
> (ms 语义)之处均已按此修正实现,文档正文保留以记录原始设计推理。

## 1. 目标与背景

视频管线分两层:**采集层**(CDP `Page.startScreencast` → Node → streamer 页 canvas)与**传输层**(streamer 页内 Chromium 原生 libwebrtc 编码 → client `<video>`)。当前两层的画质/帧率/分辨率参数**全部硬编码**,无任何定制接口;且两层之间的帧率参数互不协调。本设计为两层补齐一组**启动期 env 配置**,使画质可定制。

### 现状(硬编码点)

- `src/browser/BrowserSession.js`:`Page.startScreencast` 写死 `format:"jpeg", quality:80, every:100`,`maxWidth/maxHeight` 取自 viewport。
- `src/index.js`:`const WIDTH = 1280, HEIGHT = 800;` —— 连 env 都没读(与同文件 `PORT`/`HOST`/`MAGPIE_URL` 风格不一致)。
- `src/streamer/streamer.html`:`canvas.captureStream(15)` 写死;canvas 尺寸来自 `?w&h`(源头仍是写死的 WIDTH/HEIGHT);WebRTC 发送端**无任何**码率/帧率/退化策略控制。

### 帧率不一致(顺手修正)

三处帧率参数互不协调:CDP `every:100` 把采集上限锁在 **10fps**;`captureStream(15)` 要 15fps;`setInterval(...,50)` 重绘心跳约 20Hz。实际唯一画面最多 10fps,canvas 的 15 与心跳只是在重复绘制上一帧。本设计用一个 `MAGPIE_FPS` 同时驱动 CDP `every` 和 `captureStream`,收敛到一致值(默认 10,对可见画质中性,仅消除不一致)。

## 2. 设计原则

- **加法式默认**:所有 cap 默认**不设**,未传 env 时行为与现状**完全一致**;只有显式传 env 才生效。最安全、纯增量。
- **配置集中在纯模块** `src/config.js`,与 `ice-servers.js`/`coords.js`/`keys.js` 同属可单测的纯函数家族。
- **v1 single-instance/single-user**:启动期 env 足够,不做运行时 per-client 协商。

## 3. Config 形状

新增 `src/config.js`,导出纯函数 `loadConfig(env = process.env)`,返回:

```js
{
  viewport:   { width, height },                 // → context.viewport + screencast maxWH + streamer canvas
  screencast: { quality, every },                // jpeg quality 0-100;every = round(1000/fps) ms
  webrtc: {
    streamFps,        // canvas.captureStream(fps)
    maxBitrate,       // sender encodings[0].maxBitrate (bps);null=不设
    maxFramerate,     // sender encodings[0].maxFramerate;null=不设
    degradation,      // 'maintain-resolution'|'maintain-framerate'|'balanced';null=不设
  },
}
```

### env 变量

| env | 默认 | 解析/校验 |
|---|---|---|
| `MAGPIE_WIDTH` | 1280 | 正整数;范围 320–3840,越界钳制 + warn |
| `MAGPIE_HEIGHT` | 800 | 正整数;范围 320–3840,越界钳制 + warn |
| `MAGPIE_QUALITY` | 80 | 1–100。非整数→默认;越界→钳制;均 + warn |
| `MAGPIE_FPS` | 10 | 正整数;范围 1–60。非整数→默认;越界→钳制;均 + warn。同时驱动 `every=round(1000/fps)` 与 `streamFps` |
| `MAGPIE_MAX_BITRATE` | 不设(null) | 接受 `2500000` / `2500k` / `2.5m` 三种写法 → 统一成 bps 正整数 |
| `MAGPIE_MAX_FRAMERATE` | 不设(null) | 正整数 |
| `MAGPIE_DEGRADATION` | 不设(null) | 枚举 `maintain-resolution`/`maintain-framerate`/`balanced`,非法 → null + warn |

**统一解析规则**:数值字段——非整数/空→回退默认(或 null,见各行);为整数但越界→钳制到最近边界;均 + `console.warn`。枚举字段非法值→null + warn。**永不抛异常**:返回恒定合法的 cfg,避免在 crash→restart 流程里因坏 env 导致重启循环。

## 4. 模块改动

### `src/config.js`(新增)

纯函数,接收 env 对象(默认 `process.env`),返回上面的结构。内部包含:
- `parseBitrate(str)`:支持 `k`/`M` 后缀解析为 bps。
- 各字段的钳制/回退逻辑 + warn。

### `src/index.js`

- 删除 `const WIDTH = 1280, HEIGHT = 800;`。
- 新增 `const cfg = loadConfig();`。
- `new BrowserSession({ url: DEFAULT_URL, width: cfg.viewport.width, height: cfg.viewport.height, browser, screencast: cfg.screencast })`。
- streamer URL:在现有 `?w&h` 基础上追加 `fps`(恒有默认值,总是带上)与 `bitrate`/`maxFps`/`degradation`(**仅已设置的才带**;未设置的不进 query,页内对应逻辑跳过)。
- crash→restart 路径(`onCrash`)无需改动:screencast opts 在 BrowserSession 构造器里,restart 自动复用。

### `src/browser/BrowserSession.js`

- 构造器新增 `screencast = { quality: 80, every: 100 }` 参数(**带默认**,现有不传该参数的测试与自启动路径照常工作)。
- `startScreencast(onFrame)` 内 `Page.startScreencast` 改用 `this._screencast.quality` / `this._screencast.every`,`maxWidth/maxHeight` 仍取自 viewport(不变)。

### `src/streamer/streamer.html`

- 从 query 读取 `fps`(缺失默认 10)/`bitrate`/`maxFps`/`degradation`(`bitrate`/`maxFps`/`degradation` 缺失则对应逻辑跳过)。
- `canvas.captureStream(fps)`(`Number(params.get("fps")) || 10`)替代写死的 `15`。
- `relayOffer` 内,`pc.addTrack(...)` 后,若存在任一 cap,执行:
  ```js
  const sender = pc.addTrack(stream.getVideoTracks()[0]);
  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];
  if (bitrate)  params.encodings[0].maxBitrate   = bitrate;
  if (maxFps)   params.encodings[0].maxFramerate = maxFps;
  if (degradation) params.degradationPreference  = degradation;
  try { await sender.setParameters(params); } catch (e) { console.warn('setParameters failed', e); }
  ```
  顺序:`addTrack` → `setParameters` → `setRemoteDescription(offer)` → `createAnswer` → `setLocalDescription`。整段 `setParameters` 包 try/catch:浏览器支持/时序异常时只 warn,不阻断 offer(视频仍以默认参数工作)。无任何 cap 时不调用。

### `src/streamer/StreamerPeer.js`

**不动**。sender 参数经 URL query 传入(与现有 `?w&h` 一致),`relayOffer` 签名不变。

### `src/server.js` / `src/public/client.html`

**不动**。client 仍 recvonly;caps 在发送端(streamer 页)生效,与客户端无关。

## 5. 数据流

```
loadConfig(env) ──cfg──▶ index.js
                          ├─▶ BrowserSession({ width,height,browser, screencast:{quality,every} })
                          │        startScreencast() 用 this._screencast(替代写死 80/100)
                          │        maxWidth/maxHeight 仍取自 viewport(不变)
                          └─▶ streamer URL 带 ?w&h&fps&bitrate&maxFps&degradation(仅 set 的才带)
                                   │
                                   ▼
                        streamer.html 从 query 读:
                          captureStream(fps)                       (替代写死 15)
                          relayOffer: addTrack → getParameters → 填 caps → setParameters
```

## 6. 错误处理

- `loadConfig`:永不抛;非法 env → 钳制/回退默认 + `console.warn`。
- 页内 `setParameters`:try/catch 包裹,失败只 warn;无 cap 时跳过整个 setParameters。
- streamer URL 仅包含已设置的 cap → 缺失即"不设",与默认哲学一致。

## 7. 测试

- **新增** `test/config.test.js`(纯,传入 env 对象,不碰 `process.env`):
  - 无 env → 全默认(`quality 80 / every 100 / fps 10 / viewport 1280×800`,所有 webrtc cap 为 null)。
  - `MAGPIE_FPS=30` → `every ≈ 33`,`streamFps 30`。
  - `MAGPIE_FPS=0` → 钳制 1;`"abc"` → 回退默认 10;均 + warn。
  - `MAGPIE_QUALITY=150` → 钳制 100;`=0` → 钳制 1;`"abc"` → 回退默认 80;均 + warn。
  - `MAGPIE_MAX_BITRATE="2.5m"` → `2500000`;`"2500k"` → `2500000`;`"2500000"` → `2500000`;`"abc"` → null + warn。
  - `MAGPIE_DEGRADATION="balanced"` → `"balanced"`;`"foo"` → null + warn。
  - `MAGPIE_WIDTH=99999` / `=10` → 钳制到 3840 / 320。
- **现有** `test/browser/BrowserSession.*.test.js`:screencast 带默认值,现有用例不变;补一条断言自定义 opts 流进了 `Page.startScreencast` 的参数(spy `_cdp.send` 的入参)。
- **e2e / spike**:默认值未改变行为,应保持绿色,不改。
- **测试边界(诚实标注)**:页内 `setParameters` 的实际生效发生在 streamer 页(浏览器上下文),不易单测;靠 `config.test.js` 覆盖解析 + 手动验证,不硬塞脆弱的浏览器断言。

## 8. 不在范围(v1)

- 运行时 per-client 协商(client 经信令动态请求不同画质)——v2。
- Simulcast / SVC / `setCodecPreferences`。
- 运行时 resize(仍仅启动期 viewport)。
- client 侧 UI 调节控件。

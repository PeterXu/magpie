# magpie — codec 偏好 + 桌面友好默认 设计

- 日期:2026-08-09
- 状态:已通过设计评审,待编写实现计划
- 上游设计:`docs/superpowers/specs/2026-08-09-magpie-video-quality-config-design.md`(本特性是其延续,建在已落地的 `src/config.js` 之上)

## 1. 目标与背景

视频本质是桌面共享(CDP screencast → canvas → libwebrtc),但**源是 `canvas.captureStream()`**——libwebrtc 把它当普通视频源,**不会自动启用屏幕内容编码优化**(那个内部开关由 `getDisplayMedia`/`tabCapture` 触发,canvas 触发不了)。因此原生桌面共享 App "免费"拿到的优化,要靠手动调参补。

本设计在已落地的 env 配置基础上做两件事:

1. **翻转两项默认**(打破原"加法式",仅这两项):不传 env 时也主动设 `degradationPreference` 与 `maxBitrate`,因为对桌面场景这俩"不设"通常是错的。
2. **新增 codec 偏好**(`MAGPIE_CODEC_PRIORITY`):优先 AV1/VP9,H.264 降到最低优先级——对屏幕文字这是性价比最高的一刀。

### 与上游"加法式默认"原则的关系

上游设计明确:不传 env = 行为与现状完全一致,所有 cap 为 opt-in。本特性**仅对 `degradation` 与 `maxBitrate` 翻转该原则**(`maxFramerate` 仍保持 null/不设)。`maxBitrate` 保留显式禁用逃生口(`0`/`none`/`off` → 不限速)。

## 2. 默认值翻转

| 项 | 旧默认(不传 env) | 新默认 |
|---|---|---|
| `degradation` | `null`(libwebrtc 默认 ≈ balanced) | **`maintain-resolution`** |
| `maxBitrate` | `null`(不限速) | **自适应**(见 §2.1) |
| `maxFramerate` | `null` | 不变(仍 null) |

### 2.1 码率自适应默认

码率上限绑的是"文字细节量",与分辨率正相关;**fps 不进公式**(桌面静态时段编码器自身用量远低于上限,上限主要约束运动/滚动瞬间)。

```js
function defaultBitrate(width, height) {
  return clamp(round(width * height * 2.5), 1_500_000, 8_000_000);
}
```

落点:

| viewport | 像素数 | 自适应码率 |
|---|---|---|
| 1280×800(默认) | 1.02M | 2.56 Mbps |
| 1920×1080 | 2.07M | 5.18 Mbps |
| 2560×1440 | 3.69M | 8 Mbps(触顶) |
| 3840×2160(4K) | 8.29M | 8 Mbps(触顶) |
| 640×480 | 0.31M | 1.5 Mbps(触底) |

### 2.2 码率解析规则(MAGPIE_MAX_BITRATE)

| env 值 | 结果 |
|---|---|
| 未设 / 空 | 自适应默认(§2.1) |
| `none` / `off`(大小写不敏感) | `null` = **不限速**(显式禁用) |
| 数值形式 `<n>[k\|M]`(如 `3m`、`2500k`) | 解析为 bps;**≤ 0(含 `0`/`0k`/`0m`/负数)→ `null`(禁用)**,否则取该 bps |
| 非法(非数值,如 `abc`) | `console.warn` + 回退**自适应默认**(不变 null) |

> 码率解析为「禁用」(`null`,不限速)只有两条路径:字面 `none`/`off`,或数值解析后 ≤ 0。其余非法输入回退自适应默认,保证恒有一个合理的码率上限(除非显式禁用)。

### 2.3 degradation 解析规则(MAGPIE_DEGRADATION)

恒为合法枚举值之一(`maintain-resolution`/`maintain-framerate`/`balanced`),**不再产出 null**:

| env 值 | 结果 |
|---|---|
| 未设 / 空 | `maintain-resolution` |
| 合法枚举 | 该值 |
| 非法(如 `foo`) | `console.warn` + 回退 `maintain-resolution` |

无需"禁用"逃生口:`balanced` 等价于 libwebrtc 的 unset 默认行为。

## 3. codec 偏好(新增)

### 3.1 config 侧

解析 `MAGPIE_CODEC_PRIORITY`(默认 `"av1,vp9,vp8"`)→ 小写名数组 `["av1","vp9","vp8"]`,存入 `cfg.webrtc.codecPriority`。空 / 非法 / 全空白 → 默认列表。**config 只解析名字,不做可用性过滤**(Node 拿不到浏览器 codec 能力)。

### 3.2 传输与 URL

`buildStreamerUrl` 恒带 `&codec=av1,vp9,vp8`(逗号拼接)。`degradation` 现在恒非空 → URL 也恒带 `&degradation=...`。`bitrate` 在 maxBitrate 非 null 时带(null = 禁用时不带)。

### 3.3 streamer 页内应用(relayOffer)

`addTrack` 后、`setRemoteDescription` 前:

1. `const caps = RTCRtpSender.getCapabilities("video").codecs`(浏览器实际能编码的;AV1 不支持时这里就没有,自动降级)。
2. 按 `CODECS` 顺序,从 `caps` 里挑出 `mimeType` 的 `/` 后名字匹配(大小写不敏感)的项;一个名字匹配其所有 profile 变体(如 VP9 profile0/profile2)。
3. 把**未匹配的**(如 H.264、RTX 等)按原顺序追加到末尾 → H.264 仍可协商,仅优先级最低。
4. `transceiver.setCodecPreferences(preferred)`,包 try/catch(失败只 `console.warn`,不阻断 offer)。

关键不变量:`preferred` 是 `caps` 的一个**排列**(过滤 + 补齐),故 `setCodecPreferences` 不会因"含不支持的 codec"抛错。`RTCRtpSender.getCapabilities` 不存在时(极老浏览器)整段跳过。

`transceiver` 由 `pc.getTransceivers().find(t => t.sender === sender)` 取得。

完整 `relayOffer` 顺序:`addTrack → setCodecPreferences → setParameters(maxBitrate/maxFramerate/degradation) → setRemoteDescription(offer) → createAnswer → setLocalDescription`。

## 4. config 形状(改动)

```js
webrtc: {
  streamFps,
  maxBitrate,     // 现在恒有值(自适应或显式 bps);仅 0/none/off → null
  maxFramerate,   // 不变:默认 null,opt-in
  degradation,    // 恒为合法枚举(默认 maintain-resolution),不再 null
  codecPriority,  // 新增:["av1","vp9","vp8"] 等
}
```

## 5. 模块改动

### `src/config.js`(改)

- 新增 `defaultBitrate(width, height)`(纯,导出供单测)。
- `maxBitrate` 解析改为 §2.2 规则(新增 `0/none/off` → null,未设 → 自适应)。
- `degradation` 解析改为 §2.3 规则(默认 `maintain-resolution`,不再 null)。
- 新增 `codecPriority` 解析(§3.1)。
- `loadConfig` 返回结构加 `webrtc.codecPriority`。

### `src/index.js` `buildStreamerUrl`(改)

URL 恒带 `codec=`;`degradation` 现在(几乎)恒带;`bitrate` 仅 maxBitrate 非 null 时带。

### `src/streamer/streamer.html`(改)

- query 解析新增 `codec`(缺失默认 `"av1,vp9,vp8"`,split 成数组)。
- `window.__magpieCfg` 加 `CODECS`。
- `relayOffer` 内 `addTrack` 后插入 `setCodecPreferences` 流程(§3.3)。

### `CLAUDE.md`(改)

env 行:`MAGPIE_MAX_BITRATE` 默认改自适应 + 加 `0/none/off` 说明;新增 `MAGPIE_CODEC_PRIORITY`。

## 6. 错误处理

- `loadConfig` 仍永不抛;码率/codec 非法 → warn + 回退默认。
- 页内 `setCodecPreferences` / `setParameters` 均包 try/catch,失败只 warn,不阻断 offer;`getCapabilities` 缺失则跳过 codec 设置。
- `preferred` 为 `caps` 排列这一不变量保证 `setCodecPreferences` 不抛"不支持 codec"。

## 7. 测试

- `test/config.test.js`(改 + 新增):
  - 默认用例改为新默认:`maxBitrate` = `defaultBitrate(1280,800)` = 2560000、`degradation:"maintain-resolution"`、新增 `codecPriority:["av1","vp9","vp8"]`。
  - `defaultBitrate` 各分辨率落点(1080p→5180000、4K→8000000 触顶、640×480→1500000 触底)。
  - `MAGPIE_MAX_BITRATE`:`0`/`none`/`off`/`NONE` → null;`3m`→3000000;`abc`→ 回退默认(且 warn)。
  - `MAGPIE_DEGRADATION`:未设→`maintain-resolution`;`balanced`→`balanced`;`foo`→`maintain-resolution`(且 warn)。
  - `MAGPIE_CODEC_PRIORITY`:默认;`vp9,av1`→`["vp9","av1"]`;空/`"  "`→默认;`av1, vp9 ,vp8`(含空白)→`["av1","vp9","vp8"]`。
- `test/index.test.js`(改):`buildStreamerUrl` 现恒带 `&codec=av1,vp9,vp8` 与 `&degradation=maintain-resolution`;新增 codec 参数断言。
- `test/streamer/streamer-params.test.js`(改):加 `CODECS` 解析断言(含默认与自定义);`relayOffer` 流仍通(实际协商出的 codec 依赖 build 的 AV1 支持,属手动验证,诚实标注)。
- 全量 `npm test` 保持绿(原断言旧默认的用例需同步更新)。

## 8. 不在范围(v1)

- `scaleResolutionDownBy`(桌面不降采样,保持 1.0)。
- Simulcast / SVC `scalabilityMode`(单 recvonly 对端用不上)。
- keyframe 间隔(标准 WebRTC JS API 不暴露)。
- 运行时改 codec/码率(仍仅启动期 env)。

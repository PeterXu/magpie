# magpie — codec 选择修复设计(offerer 侧单 codec 收窄)

- 日期:2026-08-09
- 状态:已通过设计评审,待编写实现计划
- 上游(被本设计取代其 codec 选择部分):`docs/superpowers/specs/2026-08-09-magpie-codec-and-defaults-design.md`

## 1. 背景与问题

刚落地的 codec 偏好特性(`MAGPIE_CODEC_PRIORITY` → streamer 页 `relayOffer` 内 `setCodecPreferences`)**实际不改变发送的 codec**——总是发 VP8。系统性调试已定位根因(有探针实测证据):

- **实际编码/发送的 codec 跟随 offer 的 m-line 顺序(offerer 偏好),不跟随 answer。**
- 我们的架构里 **client 是 offerer**(recvonly,在 `client.html` `createOffer`),**streamer 页是 answerer**(sender)。
- 原实现把 `setCodecPreferences` 调在 **answerer**(streamer)——它确实把 *answer* 的 m-line 重排成 AV1 在前,但**编码器不看 answer**,只看 offer;而 client 没设偏好 → offer 默认 VP8 在前 → streamer 编 VP8。

实测矩阵(同一 streamer 页,只改偏好施加侧):

| 偏好施加在 | offer m-line | answer m-line | 实际发送 |
|---|---|---|---|
| answerer(原实现) | VP8 在前 | AV1 在前 | **VP8** |
| **offerer(client)** | AV1 在前 | AV1 在前 | **AV1** ✅ |
| offerer,收窄到 AV1 单 codec | 只 AV1+rtx | 只 AV1+rtx | **AV1** ✅ |
| offerer,收窄到 VP9 单 codec | 只 VP9+rtx | 只 VP9+rtx | **VP9** ✅ |

旁证:`RTCRtpSender.getCapabilities` 含 AV1(streamer 能编 AV1,非能力问题);`sender.setParameters({codecs})` 被拒(`codecs` 只读);与 AV1 无关(VP9/H264 偏好在 answerer 侧也照样发 VP8)。

## 2. 目标

让发送的 codec 真正可控:**按固定链 `[av1, vp9, vp8, h264]`,取第一个"magpie 能编码 且 client 能解码"的 codec,把 offer 的 video m-line 收窄成只有它(+rtx)**,从而强制 streamer 编该 codec。

### 硬规则(必须遵守)

**只有当某 codec 同时存在于 magpie(sender 编码能力)和 client(receiver 解码能力)时,才可以被选中/写入 m-line。** 链中无一满足 → 不设偏好(走默认,通常落到 VP8,因 VP8 几乎总是双方都有)。

### 不做的事

- **不追加 h264**(不把 h264 作为选中 codec 之外的额外兜底塞进 m-line)——避免重现"之前的问题"。m-line 永远只有**选中的那一个** codec(+rtx)。
- **不保留 `MAGPIE_CODEC_PRIORITY` 可配置性**——链固定为 `[av1,vp9,vp8,h264]`(决策,见 §6)。

## 3. 设计

### 3.1 选 codec 的算法(纯逻辑,client 侧执行)

```
CHAIN = ["av1", "vp9", "vp8", "h264"]   // 固定,不可配
magpieCodecs = <server 在 hello 里下发:magpie sender 能编码的 codec 名集合>
clientCodecs  = RTCRtpReceiver.getCapabilities("video").codecs 里出现的 codec 名集合

picked = CHAIN 中第一个 ∈ magpieCodecs 且 ∈ clientCodecs 的;都没有则 picked = null
```

`picked` 非 null → `setCodecPreferences([picked 的所有 fmtp 变体 + 所有 `video/rtx` 条目])`(收窄成单 codec;rtx 是通用重传条目,Chromium 会自动与 picked 配对——已实测)。
`picked` 为 null → 不调 `setCodecPreferences`(默认)。

### 3.2 各组件改动

| 文件 | 改动 |
|---|---|
| `src/streamer/StreamerPeer.js` | `start()` 时从 streamer 页读一次 `RTCRtpSender.getCapabilities("video").codecs`,提取去重后的小写 codec 名集合(如 `["vp8","vp9","av1","h264"]`),存为 `this._senderCodecs`。新增 `getSenderCodecs()` 取值。 |
| `src/server.js` | `hello` 消息里增加 `magpieCodecs: streamerPeer.getSenderCodecs()`(与 `iceServers`/`viewport` 同一发送路径)。 |
| `src/public/client.html` | `startPeer` 内:`addTransceiver` 后、`createOffer` 前,按 §3.1 计算 `picked`(用 hello 里的 `magpieCodecs` + 本地 `RTCRtpReceiver.getCapabilities`)并收窄 m-line。纯挑选逻辑抽成一个页内函数(便于测试驱动)。 |
| `src/streamer/streamer.html` | **删除** §3 里加的 codec 相关代码:`relayOffer` 内的 `setCodecPreferences` 块(死代码,answerer 侧无效)、`CODECS` query 解析、`__magpieCfg` 里的 `CODECS` 字段。其余(`setParameters` caps 块、心跳等)不变。 |
| `src/index.js` `buildStreamerUrl` | **删除** `codec=` 参数(随配置移除)。 |
| `src/config.js` | **删除** `parseCodecPriority` 与 `webrtc.codecPriority` 字段(决策,见 §6)。`MAGPIE_CODEC_PRIORITY` 不再被识别。 |
| `CLAUDE.md` | env 行**移除** `MAGPIE_CODEC_PRIORITY`;新增说明:codec 按 `[av1,vp9,vp8,h264]` 自动选、双方能力交集、单 codec 收窄、在 client/offerer 侧生效。streamer.html / config.js 模块表行同步更新。 |

### 3.3 数据流

```
startup: StreamerPeer.start() ──读 caps──▶ this._senderCodecs = {av1,vp9,vp8,h264}
client 连接:
  server hello ──{magpieCodecs, iceServers, viewport, ...}──▶ client.html
  client.startPeer:
     magpieCodecs ∩ RTCRtpReceiver.getCapabilities("video")
     → CHAIN[首個双方都有] = picked
     picked ? setCodecPreferences([picked+rtx]) : (默认)
     → createOffer → m-line 只含 picked(+rtx) → 发 offer
  streamer.relayOffer(offer) → answer(被迫只回 picked) → streamer 编 picked
```

## 4. 错误处理

- `RTCRtpReceiver.getCapabilities` 缺失(极老浏览器)或 `magpieCodecs` 缺失/空 → `picked = null` → 不设偏好(安全降级到默认)。
- `setCodecPreferences` 失败 → try/catch,只 `console.warn`,不阻断 offer(回退默认)。
- magpie 端读 caps 失败 → `_senderCodecs` 为空集 → hello 带空 → client `picked=null` → 默认。

## 5. 测试

- **client 挑选逻辑(纯函数 + 无浏览器单测)**:把挑选逻辑抽成纯函数 `pickCodec(magpieSet, clientSet, chain = ["av1","vp9","vp8","h264"])`,放进一个可被 `node:test` 直接 import 的纯模块(如 `src/webrtc/codec-pick.js`,与 `coords.js`/`keys.js`/`ice-servers.js` 同家族)。`client.html` 用 `<script type="module">` 引入该模块(项目无构建步骤,浏览器原生 ESM)。这需要 server 多对外提供一个静态 JS 路由。单测覆盖:双方全有→av1;magpie 无 av1→vp9;client 无 av1/vp9→vp8;只都有 h264→h264;无任何交集→null;`magpieSet`/`clientSet` 为空→null。
  - 若 `<script type="module">` 引入对 client.html 现有内联脚本作用域改动过大,降级方案:把 `pickCodec` 内联进 client.html,用"启 http 服务加载页面、`page.evaluate` 调函数"的集成测试断言(同 `test/streamer/streamer-params.test.js` 模式)。**实现阶段二选一,优先纯模块 + 无浏览器单测。**
- **端到端 codec 收窄**:扩展现有 `test/e2e.test.js`(或新增 `test/e2e-codec.test.js`):用真实 Playwright 页当 client 跑完整 offer/answer,断言 client 的 offer video m-line **只剩单个 codec**(+rtx),且该 codec ∈ CHAIN 且 ∈ 双方 caps。
- **回归**:全量 `npm test` 保持绿(删除 codec 相关代码后,相关旧断言同步移除/更新)。

## 6. 决策:`MAGPIE_CODEC_PRIORITY` 的去留

链固定不可配 → `MAGPIE_CODEC_PRIORITY`、`parseCodecPriority`、`webrtc.codecPriority`、`buildStreamerUrl` 的 `codec=`、streamer 页 codec 解析/`setCodecPreferences` 全部失去用途。**本设计移除它们**(保持代码干净,删掉刚加进来但无效的死代码)。

> 备选(若需保留可配置):让 `MAGPIE_CODEC_PRIORITY`(默认 `[av1,vp9,vp8,h264]`)作为链,经 hello 下发给 client 当 CHAIN,仍遵守"交集才设 + 单 codec 收窄 + 不追加"。本设计默认**不**走这条,除非评审时改主意。

## 7. 不在范围

- 运行时 codec 失败的回退(单 codec 收窄 = 无回退;可接受,见 §2)。
- Simulcast / SVC / `scaleResolutionDownBy`。
- 音频 codec。

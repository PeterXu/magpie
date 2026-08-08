# codec 选择修复(offerer 侧单 codec 收窄)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让发送的 codec 真正可控——按固定链 `[av1,vp9,vp8,h264]` 取第一个"magpie 能编码 且 client 能解码"的 codec,在 **client(offerer)** 侧把 offer 的 video m-line 收窄成只有它;并移除上一版无效的 answerer 侧 `MAGPIE_CODEC_PRIORITY` 管线。

**Architecture:** 新增纯模块 `src/webrtc/codec-pick.js`(可单测);`StreamerPeer.start()` 读 magpie sender caps;server 经 `hello` 下发 `magpieCodecs` 并对外提供 `/codec-pick.js` 路由;`client.html` 转为 ESM、`import pickCodec`、在 `startPeer` 里收窄 m-line。最后删除 config/index/streamer.html/tests 里旧的 codec 死代码。

**Tech Stack:** Node.js ESM(无构建)、`node:test` + `node:assert/strict`、Playwright(集成/e2e);运行时依赖仍是 `playwright` + `ws`。

## Global Constraints

- ESM(`"type":"module"`),import 带 `.js` 后缀,**无构建步骤**,无 TypeScript。
- 运行时依赖仅 `playwright` + `ws`,**不新增依赖**。
- `node:test` + `node:assert/strict`;`npm test` = `node --test`。
- **硬规则**:某 codec 只有在 **同时** ∈ magpie sender caps 与 client receiver caps 时才可被选中写入 m-line;链中无一满足 → 不设偏好(默认)。
- **固定链** `["av1","vp9","vp8","h264"]`,**不追加** h264,m-line 永远只有**选中的那一个** codec(+rtx)。
- 收窄在 **offerer(client)** 侧生效;answerer(streamer)侧不再做 codec 选择。
- 无构建步骤 → client.html 用浏览器原生 `<script type="module">` import。

参考 spec:`docs/superpowers/specs/2026-08-09-magpie-codec-selection-fix-design.md`。

---

## File Structure

| 文件 | 责任 | 任务 |
|---|---|---|
| `src/webrtc/codec-pick.js`(**新建**) | 纯 `pickCodec(magpieCodecs, clientCodecs, chain)` | Task 1 |
| `test/webrtc/codec-pick.test.js`(**新建**) | 纯单测 | Task 1 |
| `src/streamer/StreamerPeer.js`(改) | `start()` 读 sender caps,存 `this._senderCodecs`;新增 `getSenderCodecs()` | Task 2 |
| `src/server.js`(改) | `hello` 带 `magpieCodecs`;新增 `/codec-pick.js` 路由 | Task 2 |
| `test/server-codec-route.test.js`(**新建**) | 断言 `/codec-pick.js` 被正确提供 | Task 2 |
| `src/public/client.html`(改) | `<script>` → `<script type="module">` + `import pickCodec`;`hello` 存 `_magpieCodecs`;`startPeer` 内收窄 | Task 3 |
| `test/e2e.test.js`(改) | 断言 client offer 收窄成单个 chain 内 codec | Task 3 |
| `src/config.js`(改) | 删 `parseCodecPriority`/`DEFAULT_CODEC_PRIORITY`/`webrtc.codecPriority` | Task 4 |
| `src/index.js`(改) | `buildStreamerUrl` 删 `codec=` 参数 | Task 4 |
| `src/streamer/streamer.html`(改) | 删 `CODECS` 解析、`__magpieCfg.CODECS`、`relayOffer` 的 `setCodecPreferences` 块 | Task 4 |
| `test/config.test.js` / `test/index.test.js` / `test/streamer/streamer-params.test.js`(改) | 删 codec 相关断言 | Task 4 |
| `CLAUDE.md`(改) | env 行移除 `MAGPIE_CODEC_PRIORITY`;文档化自动选择 | Task 5 |

---

## Task 1: codec-pick 纯模块 + 单测

**Files:**
- Create: `src/webrtc/codec-pick.js`
- Test: `test/webrtc/codec-pick.test.js`

**Interfaces:**
- Produces: `pickCodec(magpieCodecs: string[], clientCodecs: string[], chain = ["av1","vp9","vp8","h264"]) → string | null`。返回 chain 中第一个**同时**出现在 magpieCodecs 和 clientCodecs(大小写不敏感)的元素;无则 `null`。对 `null`/`undefined`/空数组输入安全(返回 null)。

- [ ] **Step 1: 写失败测试** `test/webrtc/codec-pick.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCodec } from "../../src/webrtc/codec-pick.js";

test("pickCodec: both have av1 -> av1", () => {
  assert.equal(pickCodec(["av1", "vp9", "vp8", "h264"], ["av1", "vp9", "vp8", "h264"]), "av1");
});

test("pickCodec: magpie lacks av1 -> vp9", () => {
  assert.equal(pickCodec(["vp9", "vp8", "h264"], ["av1", "vp9", "vp8", "h264"]), "vp9");
});

test("pickCodec: client lacks av1 -> vp9", () => {
  assert.equal(pickCodec(["av1", "vp9", "vp8"], ["vp9", "vp8", "h264"]), "vp9");
});

test("pickCodec: only vp8+h264 shared -> vp8", () => {
  assert.equal(pickCodec(["vp8", "h264"], ["vp8", "h264"]), "vp8");
});

test("pickCodec: only h264 shared -> h264", () => {
  assert.equal(pickCodec(["h264"], ["h264"]), "h264");
});

test("pickCodec: no intersection in chain -> null", () => {
  assert.equal(pickCodec(["av1"], ["vp9"]), null);
});

test("pickCodec: empty / null inputs -> null", () => {
  assert.equal(pickCodec([], ["av1"]), null);
  assert.equal(pickCodec(null, null), null);
  assert.equal(pickCodec(undefined, undefined), null);
});

test("pickCodec: case-insensitive", () => {
  assert.equal(pickCodec(["AV1"], ["av1"]), "av1");
});

test("pickCodec: custom chain honored", () => {
  assert.equal(pickCodec(["x", "y"], ["x"], ["x", "y"]), "x");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx node --test test/webrtc/codec-pick.test.js`
Expected: FAIL(`pickCodec` 未导出)。

- [ ] **Step 3: 写实现** `src/webrtc/codec-pick.js`

```js
// Pure: pick the first codec (from a priority chain) that BOTH sides support.
// Used by the client (offerer) to narrow the offer's video m-line to a single
// codec — the encoder follows the OFFER's m-line order, so selection must happen
// on the offerer. Returns null when no chain element is mutually supported
// (caller then leaves preferences at the browser default).
const DEFAULT_CHAIN = ["av1", "vp9", "vp8", "h264"];

export function pickCodec(magpieCodecs, clientCodecs, chain = DEFAULT_CHAIN) {
  const toSet = (xs) => new Set((xs || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean));
  const m = toSet(magpieCodecs);
  const c = toSet(clientCodecs);
  for (const name of chain) {
    const n = String(name).trim().toLowerCase();
    if (n && m.has(n) && c.has(n)) return n;
  }
  return null;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx node --test test/webrtc/codec-pick.test.js`
Expected: PASS(全部用例)。

- [ ] **Step 5: 提交**

```bash
git add src/webrtc/codec-pick.js test/webrtc/codec-pick.test.js
git commit -m "$(cat <<'EOF'
feat: add pure pickCodec for offerer-side codec selection

First codec in [av1,vp9,vp8,h264] present in BOTH magpie encode caps
and client decode caps, else null. Foundation for narrowing the offer
m-line on the client (the side whose m-line governs the encoder).

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: 服务端 —— 暴露 magpie caps + 提供 pickCodec 路由

**Files:**
- Modify: `src/streamer/StreamerPeer.js`(`start()` 末尾追加读 caps;新增 `getSenderCodecs()`)
- Modify: `src/server.js`(`hello` 加 `magpieCodecs`;新增 `/codec-pick.js` 路由)
- Test: `test/server-codec-route.test.js`(新建)

**Interfaces:**
- Produces: `StreamerPeer.prototype.getSenderCodecs() → string[]`(如 `["vp8","h264","av1","vp9"]`)。
- Produces: server `hello` 消息新增字段 `magpieCodecs: string[]`;HTTP `GET /codec-pick.js` 返回 `200` + `text/javascript`,body 为 `src/webrtc/codec-pick.js` 内容。
- Consumes(下游 Task 3):client.html 将 `import { pickCodec } from "/codec-pick.js"` 并用 `hello.magpieCodecs`。

- [ ] **Step 1: 写路由失败测试** `test/server-codec-route.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";

test("server: serves /codec-pick.js as text/javascript with the pickCodec export", async () => {
  const server = createServer({ browserSession: {}, inputChannel: {}, streamerPeer: { getSenderCodecs: () => [] }, clientIceServers: [] });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/codec-pick.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/javascript");
    const body = await res.text();
    assert.match(body, /export function pickCodec/);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx node --test test/server-codec-route.test.js`
Expected: FAIL(`/codec-pick.js` 返回 404)。

- [ ] **Step 3a: 改 `src/streamer/StreamerPeer.js`**

在 `start()` 内 `await this._page.waitForFunction(() => window.__ready === true, ...)` **之后**追加读取 sender caps:

```js
  await this._page.waitForFunction(() => window.__ready === true, { timeout: 5000 });
  // Read the video codecs this browser can ENCODE, so the client (offerer) can
  // pick a codec both sides support. Excludes non-codec entries (rtx/red/fec).
  this._senderCodecs = await this._page.evaluate(() => {
    const caps = RTCRtpSender.getCapabilities("video");
    if (!caps || !caps.codecs) return [];
    const drop = new Set(["rtx", "red", "ulpfec", "flexfec-03"]);
    const names = new Set();
    for (const c of caps.codecs) {
      const name = (c.mimeType || "").split("/")[1];
      if (name && !drop.has(name.toLowerCase())) names.add(name.toLowerCase());
    }
    return [...names];
  });
}
```

在类内新增方法(紧邻 `setFrameSocket` 等方法):

```js
  getSenderCodecs() {
    return this._senderCodecs || [];
  }
```

- [ ] **Step 3b: 改 `src/server.js`**

顶部文件路径常量区(已有 `CLIENT_HTML`/`STREAMER_HTML`)新增:

```js
const CODEC_PICK_JS = path.join(__dirname, "webrtc", "codec-pick.js");
```

请求路由区(`if (url.pathname === "/streamer.html") ...` 那段)新增一条:

```js
    if (url.pathname === "/codec-pick.js") return serveFile(res, CODEC_PICK_JS, "text/javascript");
```

`hello` 发送处加 `magpieCodecs`:

```js
    send({ t: "hello", viewport: browserSession.getViewport(), url: browserSession.getUrl(), iceServers: clientIceServers, magpieCodecs: streamerPeer.getSenderCodecs() });
```

- [ ] **Step 4: 运行确认通过**

Run: `npx node --test test/server-codec-route.test.js`
Expected: PASS。

- [ ] **Step 5: 回归 StreamerPeer 集成**

Run: `npx node --test test/streamer/StreamerPeer.test.js`
Expected: PASS(确认 `start()` 里读 caps 的改动不破坏现有 relay/video 流)。

- [ ] **Step 6: 提交**

```bash
git add src/streamer/StreamerPeer.js src/server.js test/server-codec-route.test.js
git commit -m "$(cat <<'EOF'
feat: expose magpie sender caps + serve pickCodec module

StreamerPeer.start() reads RTCRtpSender.getCapabilities('video') and
exposes getSenderCodecs(); server hello includes magpieCodecs; server
serves /codec-pick.js (text/javascript) so the client can import the
pure pickCodec for offerer-side codec narrowing.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: client 端 —— ESM import + 收窄 offer m-line

**Files:**
- Modify: `src/public/client.html`(`<script>` → `<script type="module">` + import;`hello` 存 `_magpieCodecs`;`startPeer` 内收窄)
- Modify: `test/e2e.test.js`(末尾追加 offer 收窄断言)

**Interfaces:**
- Consumes: Task 1 `pickCodec`;Task 2 `hello.magpieCodecs` + `/codec-pick.js` 路由。
- Produces:client 的 offer video m-line 只含**单个** chain 内 codec(+rtx)。

- [ ] **Step 1: 写失败测试** —— 在 `test/e2e.test.js` 的现有 test 内,`assert.equal(count, "1")` 之后、`finally` 之前,追加:

```js
    // Offerer-side codec selection: the client's offer must be narrowed to a
    // single preferred codec (the encoder follows the offer's m-line order).
    const offer = await client.evaluate(() => window._lastOffer);
    const real = new Set();
    for (const line of (offer || "").split("\r\n")) {
      if (line.startsWith("a=rtpmap:")) {
        const name = line.split(" ")[1].split("/")[0].toLowerCase();
        if (!["rtx", "red", "ulpfec", "flexfec-03"].includes(name)) real.add(name);
      }
    }
    assert.equal(real.size, 1, `offer video m-line should have one real codec, got ${[...real]}`);
    assert.ok(["av1", "vp9", "vp8", "h264"].includes([...real][0]), `unexpected codec ${[...real][0]}`);
```

- [ ] **Step 2: 运行确认失败**

Run: `npx node --test test/e2e.test.js`
Expected: FAIL(offer 含多个 codec;`real.size` > 1)。注:e2e 启动真实 Chromium,较慢。

- [ ] **Step 3: 改 `src/public/client.html`**

**Edit A** —— `<script>` 改为 module 并加 import(把开头 `<script>` 那一行 + 紧随的第一条语句替换):

old:
```
  <script>
    const video = document.getElementById("v");
```
new:
```
  <script type="module">
    import { pickCodec } from "/codec-pick.js";
    const video = document.getElementById("v");
```

**Edit B** —— `hello` 处理存 `_magpieCodecs`:

old:
```
        window._iceServers = msg.iceServers || [];
        if (!pc) startPeer();                 // start AFTER we have iceServers
```
new:
```
        window._iceServers = msg.iceServers || [];
        window._magpieCodecs = msg.magpieCodecs || [];
        if (!pc) startPeer();                 // start AFTER we have iceServers + magpieCodecs
```

**Edit C** —— `startPeer` 内,`addTransceiver` 改为拿到 transceiver 并收窄:

old:
```
      pc = new RTCPeerConnection(rtcConfig);
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.ontrack = (e) => { video.srcObject = e.streams[0]; };
```
new:
```
      pc = new RTCPeerConnection(rtcConfig);
      const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
      narrowCodec(transceiver);               // offerer-side: force single preferred codec
      pc.ontrack = (e) => { video.srcObject = e.streams[0]; };
```

**Edit D** —— 新增 `narrowCodec` 函数(放在 `startPeer` 函数定义之前):

```js
    // Offerer-side codec selection. The encoder follows the OFFER's m-line order,
    // so this MUST happen on the client (offerer), not the streamer. Narrow the
    // video m-line to the single codec both magpie and this client support, per
    // the fixed chain [av1,vp9,vp8,h264]. No-op if none mutually supported.
    function narrowCodec(tr) {
      try {
        const recv = RTCRtpReceiver.getCapabilities("video");
        if (!recv || !recv.codecs) return;
        const clientSet = [...new Set(recv.codecs.map((c) => (c.mimeType.split("/")[1] || "").toLowerCase()))];
        const picked = pickCodec(window._magpieCodecs || [], clientSet);
        if (!picked) return;
        const want = recv.codecs.filter((c) => (c.mimeType.split("/")[1] || "").toLowerCase() === picked);
        const rtx = recv.codecs.filter((c) => c.mimeType === "video/rtx");
        tr.setCodecPreferences([...want, ...rtx]);
      } catch (e) { console.warn("magpie: codec narrow failed", e); }
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx node --test test/e2e.test.js`
Expected: PASS(含新断言:offer 收窄成单个 codec)。注:此时 streamer 侧仍残留旧的 `setCodecPreferences`(无害,Task 4 删除)。

- [ ] **Step 5: 提交**

```bash
git add src/public/client.html test/e2e.test.js
git commit -m "$(cat <<'EOF'
feat: client narrows offer to a single mutually-supported codec

client.html becomes an ES module importing pickCodec. On hello it stores
magpieCodecs; in startPeer it narrows the offer's video m-line to the one
codec (fixed chain [av1,vp9,vp8,h264]) both magpie and the client support.
e2e asserts the offer now carries exactly one real video codec.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 移除旧的(answerer 侧)codec 死代码

**Files:**
- Modify: `src/config.js`(删 `DEFAULT_CODEC_PRIORITY`、`parseCodecPriority`、`webrtc.codecPriority`)
- Modify: `src/index.js`(`buildStreamerUrl` 删 `codec=`)
- Modify: `src/streamer/streamer.html`(删 `CODECS` 解析、`__magpieCfg.CODECS`、`relayOffer` 内 `setCodecPreferences` 块)
- Modify: `test/config.test.js`(删 codecPriority 默认断言 + `MAGPIE_CODEC_PRIORITY` 用例)
- Modify: `test/index.test.js`(cfg 去 `codecPriority`、URL 去 `codec=`)
- Modify: `test/streamer/streamer-params.test.js`(URL 去 `codec=`、断言去 `CODECS`)

**Interfaces:** 无新增;纯删除。删后 `cfg.webrtc` 形如 `{ streamFps, maxBitrate, maxFramerate, degradation }`(无 `codecPriority`)。

- [ ] **Step 1: 改 `src/config.js`**

删常量(第 15 行):
```
const DEFAULT_CODEC_PRIORITY = ["av1", "vp9", "vp8"];
```
删整个 `parseCodecPriority` 函数(第 51-57 行,含其上注释)。

`loadConfig` 返回的 `webrtc` 对象删 `codecPriority` 字段(第 91 行):
```
      codecPriority: parseCodecPriority(env.MAGPIE_CODEC_PRIORITY),
```
(注意删完后 `webrtc` 对象最后一项 `degradation,` 后不要留多余逗号问题——`degradation` 成为末项,把它的逗号去掉:`degradation` 无尾逗号。)

- [ ] **Step 2: 改 `src/index.js` `buildStreamerUrl`**

`parts` 数组删 `codec=` 那行:
```
    `codec=${w.codecPriority.join(",")}`,
```
(`fps=` 之后直接是条件参数。)

- [ ] **Step 3: 改 `src/streamer/streamer.html`**

删 `CODECS` 解析行(第 17 行):
```
  const CODECS = (params.get("codec") || "av1,vp9,vp8").split(",").map((s) => s.trim()).filter(Boolean); // preferred codec order
```
`__magpieCfg` 去 `CODECS`(第 20 行):
```
  window.__magpieCfg = { FPS, BITRATE, MAXFPS, DEGRADATION, CODECS };
```
改为:
```
  window.__magpieCfg = { FPS, BITRATE, MAXFPS, DEGRADATION };
```
删 `relayOffer` 内整个 codec 偏好块(第 63-79 行,从 `// Codec preferences:` 注释到对应 `} catch (e) { console.warn("magpie: setCodecPreferences failed", e); }`),保留其后的 `setParameters` 块与 `setRemoteDescription` 等。删后 `relayOffer` 在 `const sender = pc.addTrack(...)` 之后直接是 `// Optional sender caps` 注释。

- [ ] **Step 4: 改 `test/config.test.js`**

"defaults when env empty" 用例的 `webrtc` deepEqual 删 `codecPriority` 行(第 14 行):
```
    codecPriority: ["av1", "vp9", "vp8"],
```
删整个 `MAGPIE_CODEC_PRIORITY parsing` test(第 100-106 行)。

- [ ] **Step 5: 改 `test/index.test.js`**

两条用例的 cfg 字面量删 `codecPriority: [...]`,URL 期望删 `&codec=...`。结果:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStreamerUrl } from "../src/index.js";

test("buildStreamerUrl: w/h/fps always present; caps only when set", () => {
  const url = buildStreamerUrl("http://127.0.0.1:8080", {
    viewport: { width: 1280, height: 800 },
    screencast: { quality: 80, every: 100 },
    webrtc: { streamFps: 10, maxBitrate: null, maxFramerate: null, degradation: null },
  });
  assert.equal(url, "http://127.0.0.1:8080/streamer.html?w=1280&h=800&fps=10");
});

test("buildStreamerUrl: includes bitrate/maxFps/degradation when set", () => {
  const url = buildStreamerUrl("http://h:1", {
    viewport: { width: 640, height: 480 },
    screencast: { quality: 80, every: 50 },
    webrtc: { streamFps: 20, maxBitrate: 2500000, maxFramerate: 15, degradation: "maintain-resolution" },
  });
  assert.equal(url, "http://h:1/streamer.html?w=640&h=480&fps=20&bitrate=2500000&maxFps=15&degradation=maintain-resolution");
});
```

- [ ] **Step 6: 改 `test/streamer/streamer-params.test.js`**

第一条用例的 URL 去 `&codec=vp9,av1`,断言删 `assert.deepEqual(cfg.CODECS, ["vp9", "av1"]);`。
第二条用例(默认)断言删 `assert.deepEqual(cfg.CODECS, ["av1", "vp9", "vp8"]);`。

- [ ] **Step 7: 运行确认通过**

Run: `npx node --test test/config.test.js test/index.test.js test/streamer/streamer-params.test.js`
Expected: PASS(三文件)。

- [ ] **Step 8: 提交**

```bash
git add src/config.js src/index.js src/streamer/streamer.html test/config.test.js test/index.test.js test/streamer/streamer-params.test.js
git commit -m "$(cat <<'EOF'
refactor: remove dead answerer-side codec plumbing

Codec selection now happens offerer-side (client, Task 3). Remove the
ineffective pieces: config parseCodecPriority/webrtc.codecPriority,
buildStreamerUrl codec= param, and streamer.html CODECS parsing +
relayOffer setCodecPreferences block (the encoder ignored the answer's
m-line anyway). Update the three affected tests.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 文档(CLAUDE.md)+ 全量回归

**Files:**
- Modify: `CLAUDE.md`(env 行、config.js / streamer.html 模块表行)

**Interfaces:** 无(纯文档)。

- [ ] **Step 1: 改 CLAUDE.md env 行**

定位含 `MAGPIE_CODEC_PRIORITY` 的 env 段,把它从 env 列表移除,并补充 codec 自动选择说明。把这段:

```
`MAGPIE_DEGRADATION` (`maintain-resolution`;
`maintain-resolution`/`maintain-framerate`/`balanced`), `MAGPIE_CODEC_PRIORITY`
(`av1,vp9,vp8`; preferred video codec order, H.264 falls last).
```

替换为:

```
`MAGPIE_DEGRADATION` (`maintain-resolution`;
`maintain-resolution`/`maintain-framerate`/`balanced`). Video codec is
auto-selected, not env-configurable: the client narrows its offer to the first
codec in `[av1,vp9,vp8,h264]` that both magpie can encode and the client can
decode (offerer-side, since the encoder follows the offer's m-line order).
```

- [ ] **Step 2: 改 CLAUDE.md 模块表 —— config.js 行**

old:
```
| `src/config.js` | Pure `loadConfig(env)` + `defaultBitrate`/`resolveMaxBitrate`/`parseCodecPriority`: reads/validates `MAGPIE_*` video+quality env, never throws. Drives viewport, screencast opts, and WebRTC sender caps + codec order. |
```
new:
```
| `src/config.js` | Pure `loadConfig(env)` + `defaultBitrate`/`resolveMaxBitrate`: reads/validates `MAGPIE_*` video+quality env, never throws. Drives viewport, screencast opts, and WebRTC sender caps. |
| `src/webrtc/codec-pick.js` | Pure `pickCodec(magpie, client, chain)`: first codec in `[av1,vp9,vp8,h264]` both sides support; used by the client to narrow the offer m-line. |
```

- [ ] **Step 3: 改 CLAUDE.md 模块表 —— streamer.html 行**

old:
```
| `src/streamer/streamer.html` | canvas + `captureStream(FPS)` (default 10, via `?fps=`) + page-side `RTCPeerConnection`; receives JPEG frames on `/internal`; applies sender caps from `?bitrate=&maxFps=&degradation=` and codec order from `?codec=` via `setCodecPreferences`; sets `window.__ready=true` and exposes `window.__magpieCfg`. |
```
new:
```
| `src/streamer/streamer.html` | canvas + `captureStream(FPS)` (default 10, via `?fps=`) + page-side `RTCPeerConnection`; receives JPEG frames on `/internal`; applies sender caps from `?bitrate=&maxFps=&degradation=`. Codec selection happens client-side, not here. Sets `window.__ready=true`, exposes `window.__magpieCfg`. |
```

- [ ] **Step 4: 全量回归**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: codec is auto-selected offerer-side, not MAGPIE_CODEC_PRIORITY

Drop MAGPIE_CODEC_PRIORITY from the env list; document that the client
narrows its offer per the fixed [av1,vp9,vp8,h264] chain against mutual
caps. Add codec-pick.js to the module map; note streamer.html no longer
does codec selection.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review(计划作者自检,已执行)

- **Spec coverage**:spec §2 硬规则(交集才设)→ Task 1 `pickCodec` + Task 3 `narrowCodec`(`picked` null 则不设);§2 不追加 h264 / 单 codec → Task 3 只塞 `want + rtx`;§3.1 算法 → Task 1;§3.2 各组件 → Task 1-5 一一对应;§4 错误处理 → Task 3 `narrowCodec` try/catch + getCapabilities 缺失守护、Task 2 `_senderCodecs` 空集降级;§6 删除 `MAGPIE_CODEC_PRIORITY` 全套 → Task 4。
- **Placeholder scan**:无 TBD/TODO;每个代码步骤含完整可运行代码/精确 old-new。
- **Type consistency**:`pickCodec(magpieCodecs, clientCodecs, chain)` 在 Task 1 定义、Task 3 import 调用一致;`getSenderCodecs()` 在 Task 2 定义、Task 2 server `hello` 与 Task 2 route-test 调用一致;`hello.magpieCodecs` 在 Task 2 发送、Task 3 读取一致;`cfg.webrtc` 去 `codecPriority` 在 Task 4(config)+ Task 4(index test)一致。
- **中间态全绿**:Task 1-3 期间 streamer 旧 `setCodecPreferences` 仍在(无害);Task 3 完成时 client 收窄已生效(offer 单 codec);Task 4 删旧代码后行为不变(client 侧已接管)。每个 Task 末尾对应测试绿。

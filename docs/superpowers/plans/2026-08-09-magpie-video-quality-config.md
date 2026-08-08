# 视频/采集质量定制接口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为采集层(CDP screencast)与传输层(WebRTC sender)补齐一组启动期 env 配置,使画质/帧率/分辨率/码率可定制。

**Architecture:** 新增纯模块 `src/config.js` 集中读 env + 校验,返回结构化 cfg;`index.js` 调一次并透传到 `BrowserSession`(screencast opts)与 streamer 页(URL query → `captureStream` fps + sender caps)。默认完全保持现状,所有 cap 为 opt-in。

**Tech Stack:** Node.js ESM(无构建)、`node:test` + `node:assert/strict`、Playwright(集成测试)、运行时依赖仍是 `playwright` + `ws`(本特性不新增依赖)。

## Global Constraints

- ESM(`"type":"module"`),import 带 `.js` 后缀,**无构建步骤**,无 TypeScript。
- 运行时依赖仅 `playwright` 与 `ws`,**不新增依赖**。
- 测试用 `node:test` + `node:assert/strict`;`npm test` = `node --test`。
- 保持纯逻辑可单测(config 与 `coords.js`/`keys.js`/`ice-servers.js` 同家族);dispatch/IO 留在类里。
- **加法式默认**:不传 env 时行为与现状完全一致;cap 默认 `null`/`0`/`""` 表示"不设"。
- 数值字段统一解析规则:非整数/空 → 回退默认;整数越界 → 钳制到最近边界;枚举非法 → null。均 `console.warn`,**永不抛**。
- 当前分支:`feat/video-quality-config`(spec 已提交于此)。

参考 spec:`docs/superpowers/specs/2026-08-09-magpie-video-quality-config-design.md`。

---

## File Structure

| 文件 | 责任 | 任务 |
|---|---|---|
| `src/config.js`(**新建**) | 纯函数 `loadConfig(env)` + `parseBitrate(raw)`;读 env、校验、返回 `{viewport, screencast, webrtc}` | Task 1 |
| `test/config.test.js`(**新建**) | `loadConfig`/`parseBitrate` 纯单测(传 env 对象,不碰 `process.env`) | Task 1 |
| `src/browser/BrowserSession.js`(改) | 构造器收 `screencast={quality,every}`(带默认);`startScreencast` 用 `this._screencast` | Task 2 |
| `test/browser/BrowserSession.test.js`(改) | 新增:自定义 screencast opts 流进 `Page.startScreencast`(spy `_cdp.send`) | Task 2 |
| `src/streamer/streamer.html`(改) | query 解析 fps/bitrate/maxFps/degradation;`captureStream(FPS)`;`relayOffer` 内 `setParameters`;暴露 `window.__magpieCfg` | Task 3 |
| `test/streamer/streamer-params.test.js`(**新建**) | 起 http 服务加载 streamer.html,断言 query → `window.__magpieCfg` 解析正确 | Task 3 |
| `src/index.js`(改) | `loadConfig()`;`buildStreamerUrl(base,cfg)` 纯导出;`main()` 加 isMain 守卫;BrowserSession 透传 screencast | Task 4 |
| `test/index.test.js`(**新建**) | `buildStreamerUrl` 纯单测 | Task 4 |
| `CLAUDE.md`(改) | env 列表 + 模块表 + wiring 说明 | Task 5 |

---

## Task 1: config 纯模块 + 单测

**Files:**
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `loadConfig(env = process.env)` →
  ```js
  { viewport: {width, height}, screencast: {quality, every}, webrtc: {streamFps, maxBitrate, maxFramerate, degradation} }
  ```
  `every = max(1, round(1000/streamFps))`;`maxBitrate/maxFramerate/degradation` 默认 `null`。
- Produces: `parseBitrate(raw)` → 正整数 bps 或 `null`;接受 `2500000` / `2500k` / `2.5m`。

- [ ] **Step 1: 写失败测试** `test/config.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseBitrate } from "../src/config.js";

test("loadConfig: defaults when env empty", () => {
  const c = loadConfig({});
  assert.deepEqual(c.viewport, { width: 1280, height: 800 });
  assert.deepEqual(c.screencast, { quality: 80, every: 100 });
  assert.deepEqual(c.webrtc, { streamFps: 10, maxBitrate: null, maxFramerate: null, degradation: null });
});

test("loadConfig: MAGPIE_FPS=30 drives every and streamFps", () => {
  const c = loadConfig({ MAGPIE_FPS: "30" });
  assert.equal(c.screencast.every, 33);
  assert.equal(c.webrtc.streamFps, 30);
});

test("loadConfig: MAGPIE_FPS=0 clamps to 1", () => {
  const c = loadConfig({ MAGPIE_FPS: "0" });
  assert.equal(c.webrtc.streamFps, 1);
  assert.equal(c.screencast.every, 1000);
});

test("loadConfig: MAGPIE_FPS non-numeric falls back to default", () => {
  const c = loadConfig({ MAGPIE_FPS: "abc" });
  assert.equal(c.webrtc.streamFps, 10);
});

test("loadConfig: MAGPIE_QUALITY clamps / falls back", () => {
  assert.equal(loadConfig({ MAGPIE_QUALITY: "150" }).screencast.quality, 100);
  assert.equal(loadConfig({ MAGPIE_QUALITY: "0" }).screencast.quality, 1);
  assert.equal(loadConfig({ MAGPIE_QUALITY: "abc" }).screencast.quality, 80);
});

test("loadConfig: MAGPIE_WIDTH/HEIGHT clamp to range", () => {
  assert.equal(loadConfig({ MAGPIE_WIDTH: "99999" }).viewport.width, 3840);
  assert.equal(loadConfig({ MAGPIE_WIDTH: "10" }).viewport.width, 320);
  assert.equal(loadConfig({ MAGPIE_HEIGHT: "99999" }).viewport.height, 3840);
});

test("parseBitrate: accepts plain / k / M", () => {
  assert.equal(parseBitrate("2500000"), 2500000);
  assert.equal(parseBitrate("2500k"), 2500000);
  assert.equal(parseBitrate("2.5m"), 2500000);
  assert.equal(parseBitrate(undefined), null);
  assert.equal(parseBitrate(""), null);
  assert.equal(parseBitrate("abc"), null);
});

test("loadConfig: MAGPIE_MAX_BITRATE parsed into webrtc.maxBitrate", () => {
  assert.equal(loadConfig({ MAGPIE_MAX_BITRATE: "2.5m" }).webrtc.maxBitrate, 2500000);
  assert.equal(loadConfig({}).webrtc.maxBitrate, null);
  assert.equal(loadConfig({ MAGPIE_MAX_BITRATE: "abc" }).webrtc.maxBitrate, null);
});

test("loadConfig: MAGPIE_MAX_FRAMERATE", () => {
  assert.equal(loadConfig({ MAGPIE_MAX_FRAMERATE: "24" }).webrtc.maxFramerate, 24);
  assert.equal(loadConfig({ MAGPIE_MAX_FRAMERATE: "0" }).webrtc.maxFramerate, null);
  assert.equal(loadConfig({ MAGPIE_MAX_FRAMERATE: "abc" }).webrtc.maxFramerate, null);
});

test("loadConfig: MAGPIE_DEGRADATION enum", () => {
  assert.equal(loadConfig({ MAGPIE_DEGRADATION: "balanced" }).webrtc.degradation, "balanced");
  assert.equal(loadConfig({ MAGPIE_DEGRADATION: "maintain-resolution" }).webrtc.degradation, "maintain-resolution");
  assert.equal(loadConfig({ MAGPIE_DEGRADATION: "foo" }).webrtc.degradation, null);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx node --test test/config.test.js`
Expected: FAIL(import 找不到 `../src/config.js`)。

- [ ] **Step 3: 写最小实现** `src/config.js`

```js
// Pure config loader: reads MAGPIE_* env, validates, returns a structured cfg.
// Same family as coords.js / keys.js / ice-servers.js — pure & unit-tested.
// NEVER throws: bad env is clamped/fallback + console.warn, so the crash→restart
// loop can't be bricked by a typo'd env value.

const DEFAULTS = { WIDTH: 1280, HEIGHT: 800, QUALITY: 80, FPS: 10 };
const RANGE = {
  WIDTH:  [320, 3840],
  HEIGHT: [320, 3840],
  QUALITY: [1, 100],
  FPS:    [1, 60],
};
const DEGRADATIONS = ["maintain-resolution", "maintain-framerate", "balanced"];

// Parse an int env value: non-int/empty -> default; out of range -> clamp. Warns either way.
function clampInt(raw, def, [lo, hi], name) {
  if (raw === undefined || raw === null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) { console.warn(`magpie: ${name}=${raw} not an int, using default ${def}`); return def; }
  if (n < lo) { console.warn(`magpie: ${name}=${n} below ${lo}, clamped`); return lo; }
  if (n > hi) { console.warn(`magpie: ${name}=${n} above ${hi}, clamped`); return hi; }
  return n;
}

// Parse bitrate: "2500000" | "2500k" | "2.5m" -> bps; invalid -> null.
export function parseBitrate(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/i.exec(String(raw).trim());
  if (!m) { console.warn(`magpie: MAGPIE_MAX_BITRATE=${raw} invalid, ignored`); return null; }
  const mul = m[2] ? (m[2].toLowerCase() === "m" ? 1_000_000 : 1000) : 1;
  const bps = Math.round(Number(m[1]) * mul);
  if (!Number.isFinite(bps) || bps <= 0) { console.warn(`magpie: MAGPIE_MAX_BITRATE=${raw} invalid, ignored`); return null; }
  return bps;
}

export function loadConfig(env = process.env) {
  const width  = clampInt(env.MAGPIE_WIDTH,  DEFAULTS.WIDTH,  RANGE.WIDTH,  "MAGPIE_WIDTH");
  const height = clampInt(env.MAGPIE_HEIGHT, DEFAULTS.HEIGHT, RANGE.HEIGHT, "MAGPIE_HEIGHT");
  const quality = clampInt(env.MAGPIE_QUALITY, DEFAULTS.QUALITY, RANGE.QUALITY, "MAGPIE_QUALITY");
  const fps = clampInt(env.MAGPIE_FPS, DEFAULTS.FPS, RANGE.FPS, "MAGPIE_FPS");
  const every = Math.max(1, Math.round(1000 / fps));

  // Optional WebRTC sender caps: null = unset (preserves libwebrtc defaults).
  const maxBitrate = parseBitrate(env.MAGPIE_MAX_BITRATE);

  let maxFramerate = null;
  const mfRaw = env.MAGPIE_MAX_FRAMERATE;
  if (mfRaw !== undefined && mfRaw !== null && mfRaw !== "") {
    const n = Number(mfRaw);
    if (Number.isInteger(n) && n > 0) maxFramerate = n;
    else console.warn(`magpie: MAGPIE_MAX_FRAMERATE=${mfRaw} invalid, ignored`);
  }

  let degradation = null;
  if (env.MAGPIE_DEGRADATION) {
    degradation = DEGRADATIONS.includes(env.MAGPIE_DEGRADATION) ? env.MAGPIE_DEGRADATION : null;
    if (!degradation) console.warn(`magpie: MAGPIE_DEGRADATION=${env.MAGPIE_DEGRADATION} invalid, ignored`);
  }

  return {
    viewport: { width, height },
    screencast: { quality, every },
    webrtc: { streamFps: fps, maxBitrate, maxFramerate, degradation },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx node --test test/config.test.js`
Expected: PASS(全部用例)。

- [ ] **Step 5: 提交**

```bash
git add src/config.js test/config.test.js
git commit -m "$(cat <<'EOF'
feat: add pure config loader for video/screencast env

loadConfig(env) parses MAGPIE_* (width/height/quality/fps/maxBitrate/
maxFramerate/degradation) with clamp/fallback validation, never throws.
Additive defaults preserve current behavior. Unifies CDP every and
captureStream fps under one MAGPIE_FPS.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: BrowserSession 接收 screencast opts

**Files:**
- Modify: `src/browser/BrowserSession.js`(`constructor` 第 5 行、`startScreencast` 第 84-87 行)
- Test: `test/browser/BrowserSession.test.js`(追加用例)

**Interfaces:**
- Consumes: Task 1 的 `{quality, every}` 形状(由 `cfg.screencast` 提供)。
- Produces: `new BrowserSession({ ..., screencast: {quality, every} })`;不传时默认 `{quality:80, every:100}`(= 现状)。

- [ ] **Step 1: 写失败测试** —— 追加到 `test/browser/BrowserSession.test.js` 末尾

```js
test("BrowserSession: startScreencast forwards custom quality/every", async () => {
  const session = new BrowserSession({ url: FIXTURE, width: 400, height: 300, screencast: { quality: 50, every: 40 } });
  await session.start();
  try {
    const calls = [];
    const orig = session._cdp.send.bind(session._cdp);
    session._cdp.send = (method, params) => {
      if (method === "Page.startScreencast") calls.push(params);
      return orig(method, params);
    };
    await session.startScreencast(() => {});
    await session.stopScreencast();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].quality, 50);
    assert.equal(calls[0].every, 40);
    assert.equal(calls[0].maxWidth, 400);
    assert.equal(calls[0].maxHeight, 300);
  } finally {
    await session.stop();
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx node --test test/browser/BrowserSession.test.js`
Expected: FAIL(`calls[0].quality` 为 `80` —— 当前写死值,断言 50 失败)。

- [ ] **Step 3: 改实现** `src/browser/BrowserSession.js`

构造器(第 5 行)加 `screencast` 参数并存储:

```js
  constructor({ url = "https://gitee.com", width = 1280, height = 800, browser, screencast = { quality: 80, every: 100 } } = {}) {
    this._url = url;
    this._width = width;
    this._height = height;
    this._screencast = screencast;
    this._injectedBrowser = browser ?? null;
```

`startScreencast`(第 84-87 行)改用 `this._screencast`:

```js
    await this._cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: this._screencast.quality,
      every: this._screencast.every,
      maxWidth: this._width, maxHeight: this._height,
    });
```

- [ ] **Step 4: 运行确认通过**

Run: `npx node --test test/browser/BrowserSession.test.js`
Expected: PASS(新用例 + 原有 screencast/navigate/getViewport 用例全过;默认 `{quality:80,every:100}` 与旧行为一致)。

- [ ] **Step 5: 提交**

```bash
git add src/browser/BrowserSession.js test/browser/BrowserSession.test.js
git commit -m "$(cat <<'EOF'
feat: BrowserSession accepts screencast opts (quality/every)

Constructor takes screencast={quality,every} (default {80,100} preserves
current behavior). startScreencast threads them into Page.startScreencast
instead of hardcoded values.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: streamer.html 解析 query + 应用 sender caps

**Files:**
- Modify: `src/streamer/streamer.html`(script 全段)
- Test: `test/streamer/streamer-params.test.js`(新建)

**Interfaces:**
- Consumes: index.js(Task 4)拼出的 URL query:`w/h`(恒带)、`fps`(恒带)、`bitrate/maxFps/degradation`(仅设置时带)。
- Produces:`window.__magpieCfg = {FPS, BITRATE, MAXFPS, DEGRADATION}`(debug hook,供测试与运维查看);`captureStream(FPS)`;`relayOffer` 内对 sender 调 `setParameters`。

- [ ] **Step 1: 写失败测试** `test/streamer/streamer-params.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STREAMER_HTML = path.join(__dirname, "..", "..", "src", "streamer", "streamer.html");

async function serveStreamer() {
  const html = await readFile(STREAMER_HTML, "utf8");
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/streamer.html")) { res.writeHead(200, { "content-type": "text/html" }); return res.end(html); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("streamer.html: parses fps/bitrate/maxFps/degradation from query", async () => {
  const { server, base } = await serveStreamer();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/streamer.html?w=16&h=16&fps=20&bitrate=1500000&maxFps=15&degradation=maintain-resolution`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__magpieCfg, { timeout: 3000 });
    const cfg = await page.evaluate(() => window.__magpieCfg);
    assert.equal(cfg.FPS, 20);
    assert.equal(cfg.BITRATE, 1500000);
    assert.equal(cfg.MAXFPS, 15);
    assert.equal(cfg.DEGRADATION, "maintain-resolution");
  } finally {
    await browser.close();
    server.close();
  }
});

test("streamer.html: defaults when no caps in query", async () => {
  const { server, base } = await serveStreamer();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/streamer.html?w=16&h=16`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__magpieCfg, { timeout: 3000 });
    const cfg = await page.evaluate(() => window.__magpieCfg);
    assert.equal(cfg.FPS, 10);       // default
    assert.equal(cfg.BITRATE, 0);    // unset
    assert.equal(cfg.MAXFPS, 0);     // unset
    assert.equal(cfg.DEGRADATION, "");// unset
  } finally {
    await browser.close();
    server.close();
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx node --test test/streamer/streamer-params.test.js`
Expected: FAIL(`window.__magpieCfg` 不存在,`waitForFunction` 超时)。

- [ ] **Step 3: 改实现** `src/streamer/streamer.html`

把 `<script>` 内的开头(原第 7-15 行)替换为:解析新增 query、暴露 `__magpieCfg`、`captureStream(FPS)`:

```js
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  // Viewport + caps via query (?w=&h=&fps=&bitrate=&maxFps=&degradation=).
  const params = new URLSearchParams(location.search);
  const W = Number(params.get("w") || 1280);
  const H = Number(params.get("h") || 800);
  const FPS = Number(params.get("fps")) || 10;             // captureStream rate; default 10
  const BITRATE = Number(params.get("bitrate")) || 0;      // sender maxBitrate (bps); 0 = unset
  const MAXFPS = Number(params.get("maxFps")) || 0;        // sender maxFramerate; 0 = unset
  const DEGRADATION = params.get("degradation") || "";     // sender degradationPreference; "" = unset
  canvas.width = W; canvas.height = H;
  // Debug hook: parsed caps (matches the window.__* convention used elsewhere here).
  window.__magpieCfg = { FPS, BITRATE, MAXFPS, DEGRADATION };

  let stream = canvas.captureStream(FPS);
```

把 `relayOffer`(原第 52-64 行)替换为带 sender caps 的版本:

```js
  // Driven by Node via page.evaluate when a client offer arrives.
  window.relayOffer = async (offer, iceServers) => {
    if (pc) { try { pc.close(); } catch {} }
    pc = new RTCPeerConnection({ iceServers: iceServers || [] });
    const sender = pc.addTrack(stream.getVideoTracks()[0]);
    // Optional sender caps (maxBitrate/maxFramerate/degradationPreference).
    // Wrapped: browser/timing quirks must not break the offer — fall back to defaults.
    if (BITRATE || MAXFPS || DEGRADATION) {
      try {
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        if (BITRATE) p.encodings[0].maxBitrate = BITRATE;
        if (MAXFPS) p.encodings[0].maxFramerate = MAXFPS;
        if (DEGRADATION) p.degradationPreference = DEGRADATION;
        await sender.setParameters(p);
      } catch (e) { console.warn("magpie: setParameters failed", e); }
    }
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 3000);
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } };
    });
    return pc.localDescription.sdp;
  };
```

(`setInterval` 心跳、`connectInternal`、`window.__ready = true` 不动。)

- [ ] **Step 4: 运行确认通过**

Run: `npx node --test test/streamer/streamer-params.test.js`
Expected: PASS(两条解析用例)。

- [ ] **Step 5: 回归 StreamerPeer 集成测试**

Run: `npx node --test test/streamer/StreamerPeer.test.js`
Expected: PASS(确认改 query/captureStream 后端到端视频仍流通;caps 未设时 setParameters 跳过,不影响默认流程)。

- [ ] **Step 6: 提交**

```bash
git add src/streamer/streamer.html test/streamer/streamer-params.test.js
git commit -m "$(cat <<'EOF'
feat: streamer.html reads fps/bitrate/maxFps/degradation from query

captureStream(fps) replaces hardcoded 15. relayOffer applies optional
sender caps (maxBitrate/maxFramerate/degradationPreference) via
setParameters, wrapped so failures fall back to libwebrtc defaults.
Exposes window.__magpieCfg as a debug hook.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: index.js 接线(loadConfig + buildStreamerUrl)

**Files:**
- Modify: `src/index.js`
- Test: `test/index.test.js`(新建)

**Interfaces:**
- Consumes: Task 1 `loadConfig`;Task 2 `BrowserSession({screencast})`;Task 3 streamer query 契约。
- Produces: 纯导出 `buildStreamerUrl(base, cfg)`;`main()` 仅在直接运行时执行(isMain 守卫)。

- [ ] **Step 1: 写失败测试** `test/index.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStreamerUrl } from "../src/index.js";

test("buildStreamerUrl: w/h/fps always present, no caps when unset", () => {
  const url = buildStreamerUrl("http://127.0.0.1:8080", {
    viewport: { width: 1280, height: 800 },
    screencast: { quality: 80, every: 100 },
    webrtc: { streamFps: 10, maxBitrate: null, maxFramerate: null, degradation: null },
  });
  assert.equal(url, "http://127.0.0.1:8080/streamer.html?w=1280&h=800&fps=10");
});

test("buildStreamerUrl: includes caps only when set", () => {
  const url = buildStreamerUrl("http://h:1", {
    viewport: { width: 640, height: 480 },
    screencast: { quality: 80, every: 50 },
    webrtc: { streamFps: 20, maxBitrate: 2500000, maxFramerate: 15, degradation: "maintain-resolution" },
  });
  assert.equal(url, "http://h:1/streamer.html?w=640&h=480&fps=20&bitrate=2500000&maxFps=15&degradation=maintain-resolution");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx node --test test/index.test.js`
Expected: FAIL(`buildStreamerUrl` 未导出)。
注:此时直接 `import "../src/index.js"` 会触发 `main()` 启动浏览器;Step 3 加 isMain 守卫后导入即安全。

- [ ] **Step 3: 改实现** `src/index.js`

顶部新增 import 与 `loadConfig()`(替换写死的 `WIDTH/HEIGHT`):

```js
import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./browser/launch-options.js";
import { BrowserSession } from "./browser/BrowserSession.js";
import { StreamerPeer } from "./streamer/StreamerPeer.js";
import { InputChannel } from "./webrtc/InputChannel.js";
import { createServer } from "./server.js";
import { buildIceServers } from "./webrtc/ice-servers.js";
import { loadConfig } from "./config.js";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const DEFAULT_URL = process.env.MAGPIE_URL ?? "https://gitee.com";
const cfg = loadConfig();
const HOST_IP = process.env.MAGPIE_HOST_IP ?? "";
const TURN_USER = process.env.MAGPIE_TURN_USER ?? "magpie";
const TURN_PASS = process.env.MAGPIE_TURN_PASS ?? "magpie";
```

(删除原 `const WIDTH = 1280, HEIGHT = 800;`。)

在 `main()` **之前**新增纯导出 `buildStreamerUrl`:

```js
// Pure: build the streamer page URL from cfg. Exported for unit testing.
export function buildStreamerUrl(base, c) {
  const w = c.webrtc;
  const parts = [`w=${c.viewport.width}`, `h=${c.viewport.height}`, `fps=${w.streamFps}`];
  if (w.maxBitrate) parts.push(`bitrate=${w.maxBitrate}`);
  if (w.maxFramerate) parts.push(`maxFps=${w.maxFramerate}`);
  if (w.degradation) parts.push(`degradation=${w.degradation}`);
  return `${base}/streamer.html?${parts.join("&")}`;
}
```

`main()` 内:BrowserSession 透传 screencast,streamer URL 用 `buildStreamerUrl`(替换原 `${base}/streamer.html?w=${WIDTH}&h=${HEIGHT}`):

```js
  const browserSession = new BrowserSession({ url: DEFAULT_URL, width: cfg.viewport.width, height: cfg.viewport.height, browser, screencast: cfg.screencast });
```

```js
  await streamerPeer.start({ streamerUrl: buildStreamerUrl(base, cfg), iceServers: serverIceServers });
```

文件末尾把直接执行改为 isMain 守卫:

```js
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx node --test test/index.test.js`
Expected: PASS(导入不再启动浏览器;两条 URL 用例通过)。

- [ ] **Step 5: 烟测 —— 实际启动服务**

Run: `MAGPIE_FPS=20 MAGPIE_WIDTH=640 MAGPIE_HEIGHT=480 MAGPIE_MAX_BITRATE=1m MAGPIE_DEGRADATION=maintain-resolution npm start &`
然后:`curl -s http://localhost:8080/healthz` → 期望 `ok`;再 `kill %1`。
Expected: 启动日志正常,healthz 返回 `ok`,无 `every`/captureStream 相关报错。(确认接线不破坏启动。)

- [ ] **Step 6: 提交**

```bash
git add src/index.js test/index.test.js
git commit -m "$(cat <<'EOF'
feat: wire loadConfig into index.js (session opts + streamer URL)

loadConfig() replaces hardcoded WIDTH/HEIGHT. Screencast opts threaded
into BrowserSession. New pure buildStreamerUrl(base, cfg) builds the
streamer query (w/h/fps always; bitrate/maxFps/degradation only when
set). main() guarded with isMain so index.js is importable for tests.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 文档(CLAUDE.md)+ 全量回归

**Files:**
- Modify: `CLAUDE.md`(Env 行、Module map、Wiring notes)

**Interfaces:** 无(纯文档)。

- [ ] **Step 1: 改 `CLAUDE.md` Env 行**

把:

```
Env (defaults in `src/index.js`): `PORT` (8080), `HOST` (`0.0.0.0`; `127.0.0.1`
for local-only), `MAGPIE_URL` (https://gitee.com), `MAGPIE_NO_SANDBOX` (`1` only
in Docker).
```

改为:

```
Env (defaults in `src/index.js` + `src/config.js`): `PORT` (8080), `HOST`
(`0.0.0.0`; `127.0.0.1` for local-only), `MAGPIE_URL` (https://gitee.com),
`MAGPIE_NO_SANDBOX` (`1` only in Docker). Video/quality (all optional, additive —
unset = current behavior): `MAGPIE_WIDTH`/`MAGPIE_HEIGHT` (1280/800),
`MAGPIE_QUALITY` (80, jpeg 1-100), `MAGPIE_FPS` (10, drives both CDP `every` and
`captureStream`), `MAGPIE_MAX_BITRATE` (unset; bps, accepts `2500k`/`2.5m`),
`MAGPIE_MAX_FRAMERATE` (unset), `MAGPIE_DEGRADATION` (unset;
`maintain-resolution`/`maintain-framerate`/`balanced`).
```

- [ ] **Step 2: 改 `CLAUDE.md` Module map —— 新增一行**

在模块表(`| Path | Role |` 表内)插入:

```
| `src/config.js` | Pure `loadConfig(env)` + `parseBitrate`: reads/validates `MAGPIE_*` video+quality env, never throws. Drives viewport, screencast opts, and WebRTC sender caps. |
```

- [ ] **Step 3: 改 `CLAUDE.md` Wiring notes —— 追加一条**

在 "### Wiring notes (easy to get wrong)" 末尾追加:

```
- WebRTC sender caps (`MAGPIE_MAX_BITRATE`/`MAGPIE_MAX_FRAMERATE`/
  `MAGPIE_DEGRADATION`) apply **streamer-page-side** in `relayOffer` via
  `RTCRtpSender.setParameters` — not on the (recvonly) client. They're threaded
  as URL query params from `buildStreamerUrl`; the client peer is unaffected.
```

- [ ] **Step 4: 全量回归**

Run: `npm test`
Expected: 全绿(config / BrowserSession / streamer-params / StreamerPeer / launch-options / webrtc / e2e / spike / sanity)。

- [ ] **Step 5: 提交**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: document video/quality env config in CLAUDE.md

Add MAGPIE_* video env to the env list, src/config.js to the module map,
and a wiring note that sender caps apply streamer-page-side.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review(计划作者自检,已执行)

- **Spec coverage**:spec §3 env 表 → Task 1;§4 各模块改动 → Task 1-4 一一对应;§5 数据流 → Task 4;§6 错误处理 → Task 1(永不抛)+ Task 3(setParameters try/catch);§7 测试 → 各 Task 的测试步骤;§8 不在范围 → 未实现,符合。
- **Placeholder scan**:无 TBD/TODO;每个代码步骤均含完整可运行代码。
- **Type consistency**:`loadConfig` 返回形状在 Task 1 定义,Task 4 `buildStreamerUrl` 消费的 `cfg.viewport/screencast/webrtc.*` 字段名一致;`screencast={quality,every}` 在 Task 1(cfg.screencast)、Task 2(BrowserSession)、Task 4(透传)三处一致;query 参数名 `fps/bitrate/maxFps/degradation` 在 Task 3(streamer 解析)与 Task 4(buildStreamerUrl 生成)两处一致。

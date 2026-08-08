# codec 偏好 + 桌面友好默认 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 翻转 `degradation`/`maxBitrate` 为桌面友好默认(maintain-resolution + 自适应码率),并新增 `MAGPIE_CODEC_PRIORITY`(AV1/VP9 优先,H.264 最后)。

**Architecture:** `src/config.js` 新增 `defaultBitrate`/`resolveMaxBitrate`/`parseCodecPriority`,翻转两项默认;`buildStreamerUrl` 恒带 `codec=`;`streamer.html` 解析 `codec` query 并在 `relayOffer` 内 `setCodecPreferences`(按可用 codec 过滤 + 补齐成排列)。codec 可用性过滤在页内做(`RTCRtpSender.getCapabilities` 是浏览器 API,Node 拿不到)。

**Tech Stack:** Node.js ESM(无构建)、`node:test` + `node:assert/strict`、Playwright(集成测试);运行时依赖仍是 `playwright` + `ws`(本特性不新增依赖)。

## Global Constraints

- ESM(`"type":"module"`),import 带 `.js` 后缀,**无构建**,无 TypeScript。
- 运行时依赖仅 `playwright` + `ws`,**不新增依赖**。
- `node:test` + `node:assert/strict`;`npm test` = `node --test`。
- `loadConfig` 永不抛;非法 env → `console.warn` + 回退默认。
- **仅翻转 `degradation` 与 `maxBitrate` 的默认**(打破加法式);`maxFramerate` 仍默认 null(opt-in)。
- `maxBitrate` 禁用路径:`none`/`off` 或数值 ≤0 → `null`(不限速);非数值非法 → warn + 回退自适应默认。
- codec 可用性过滤**只在 streamer 页内**做;config 只解析名字列表。
- 当前分支:`feat/video-quality-config`(spec 已提交于此:`2026-08-09-magpie-codec-and-defaults-design.md`)。

参考 spec:`docs/superpowers/specs/2026-08-09-magpie-codec-and-defaults-design.md`。

---

## File Structure

| 文件 | 责任 | 任务 |
|---|---|---|
| `src/config.js`(改) | 新增 `defaultBitrate`/`resolveMaxBitrate`/`parseCodecPriority`;翻转 degradation/maxBitrate 默认;cfg 加 `webrtc.codecPriority`。移除旧 `parseBitrate` 导出 | Task 1 |
| `test/config.test.js`(改) | 默认用例改新默认;新增 bitrate resolver / defaultBitrate / codecPriority 用例;移除 parseBitrate 用例 | Task 1 |
| `src/index.js` `buildStreamerUrl`(改) | URL 恒带 `codec=` | Task 2 |
| `test/index.test.js`(改) | cfg 带 codecPriority;断言 URL 含 `codec=` | Task 2 |
| `src/streamer/streamer.html`(改) | 解析 `codec` query;`__magpieCfg` 加 `CODECS`;`relayOffer` 内 `setCodecPreferences` | Task 3 |
| `test/streamer/streamer-params.test.js`(改) | 加 `CODECS` 解析断言(含默认与自定义) | Task 3 |
| `CLAUDE.md`(改) | env 行(MAX_BITRATE 自适应 + 禁用;新增 CODEC_PRIORITY;DEGRADATION 默认)、模块表(config.js 导出名;streamer.html codec) | Task 4 |

---

## Task 1: config 层 —— 默认翻转 + bitrate resolver + codec 解析

**Files:**
- Modify: `src/config.js`(整文件替换,见 Step 3)
- Test: `test/config.test.js`(整文件替换,见 Step 1)

**Interfaces:**
- Produces(导出):`loadConfig(env = process.env)` → cfg 新增 `webrtc.codecPriority: string[]`;`webrtc.maxBitrate` 默认变自适应数值(仅禁用时 null);`webrtc.degradation` 默认 `"maintain-resolution"`(恒非空)。
- Produces(导出):`defaultBitrate(width, height) → number`、`resolveMaxBitrate(raw, width, height) → number|null`、`parseCodecPriority(raw) → string[]`。
- **移除**旧 `parseBitrate` 导出(被 `resolveMaxBitrate` 取代)。

- [ ] **Step 1: 写测试(整文件替换)** `test/config.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, defaultBitrate, resolveMaxBitrate } from "../src/config.js";

test("loadConfig: defaults when env empty", () => {
  const c = loadConfig({});
  assert.deepEqual(c.viewport, { width: 1280, height: 800 });
  assert.deepEqual(c.screencast, { quality: 80, every: 100 });
  assert.deepEqual(c.webrtc, {
    streamFps: 10,
    maxBitrate: 2560000,                 // adaptive default for 1280x800
    maxFramerate: null,
    degradation: "maintain-resolution",  // flipped default
    codecPriority: ["av1", "vp9", "vp8"],
  });
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

test("defaultBitrate: resolution-driven, clamped to [1.5M, 8M]", () => {
  assert.equal(defaultBitrate(1280, 800), 2560000);
  assert.equal(defaultBitrate(1920, 1080), 5184000);
  assert.equal(defaultBitrate(2560, 1440), 8000000);   // ceiling
  assert.equal(defaultBitrate(3840, 2160), 8000000);   // ceiling
  assert.equal(defaultBitrate(640, 480), 1500000);     // floor
});

test("resolveMaxBitrate: unset/empty -> adaptive default", () => {
  assert.equal(resolveMaxBitrate(undefined, 1280, 800), 2560000);
  assert.equal(resolveMaxBitrate(null, 1280, 800), 2560000);
  assert.equal(resolveMaxBitrate("", 1920, 1080), 5184000);
});

test("resolveMaxBitrate: numeric forms -> bps", () => {
  assert.equal(resolveMaxBitrate("2500000", 1280, 800), 2500000);
  assert.equal(resolveMaxBitrate("2500k", 1280, 800), 2500000);
  assert.equal(resolveMaxBitrate("2.5m", 1280, 800), 2500000);
});

test("resolveMaxBitrate: disable sentinels (<=0 / none / off) -> null", () => {
  assert.equal(resolveMaxBitrate("0", 1280, 800), null);
  assert.equal(resolveMaxBitrate("0k", 1280, 800), null);
  assert.equal(resolveMaxBitrate("0m", 1280, 800), null);
  assert.equal(resolveMaxBitrate("none", 1280, 800), null);
  assert.equal(resolveMaxBitrate("OFF", 1280, 800), null);
});

test("resolveMaxBitrate: invalid non-numeric -> fallback default (warn)", () => {
  assert.equal(resolveMaxBitrate("abc", 1280, 800), 2560000);
});

test("loadConfig: MAGPIE_MAX_BITRATE end-to-end", () => {
  assert.equal(loadConfig({ MAGPIE_MAX_BITRATE: "3m" }).webrtc.maxBitrate, 3000000);
  assert.equal(loadConfig({}).webrtc.maxBitrate, 2560000);                 // adaptive default
  assert.equal(loadConfig({ MAGPIE_MAX_BITRATE: "0" }).webrtc.maxBitrate, null);        // disable
  assert.equal(loadConfig({ MAGPIE_MAX_BITRATE: "none" }).webrtc.maxBitrate, null);     // disable
  assert.equal(loadConfig({ MAGPIE_MAX_BITRATE: "abc" }).webrtc.maxBitrate, 2560000);   // fallback
});

test("loadConfig: MAGPIE_MAX_FRAMERATE", () => {
  assert.equal(loadConfig({ MAGPIE_MAX_FRAMERATE: "24" }).webrtc.maxFramerate, 24);
  assert.equal(loadConfig({ MAGPIE_MAX_FRAMERATE: "0" }).webrtc.maxFramerate, null);
  assert.equal(loadConfig({ MAGPIE_MAX_FRAMERATE: "abc" }).webrtc.maxFramerate, null);
});

test("loadConfig: MAGPIE_DEGRADATION enum + flipped default", () => {
  assert.equal(loadConfig({ MAGPIE_DEGRADATION: "balanced" }).webrtc.degradation, "balanced");
  assert.equal(loadConfig({ MAGPIE_DEGRADATION: "maintain-framerate" }).webrtc.degradation, "maintain-framerate");
  assert.equal(loadConfig({}).webrtc.degradation, "maintain-resolution");               // new default
  assert.equal(loadConfig({ MAGPIE_DEGRADATION: "foo" }).webrtc.degradation, "maintain-resolution"); // bad -> default
});

test("loadConfig: MAGPIE_CODEC_PRIORITY parsing", () => {
  assert.deepEqual(loadConfig({}).webrtc.codecPriority, ["av1", "vp9", "vp8"]);
  assert.deepEqual(loadConfig({ MAGPIE_CODEC_PRIORITY: "vp9,av1" }).webrtc.codecPriority, ["vp9", "av1"]);
  assert.deepEqual(loadConfig({ MAGPIE_CODEC_PRIORITY: "av1, vp9 ,vp8" }).webrtc.codecPriority, ["av1", "vp9", "vp8"]);
  assert.deepEqual(loadConfig({ MAGPIE_CODEC_PRIORITY: "   " }).webrtc.codecPriority, ["av1", "vp9", "vp8"]);
  assert.deepEqual(loadConfig({ MAGPIE_CODEC_PRIORITY: "h264" }).webrtc.codecPriority, ["h264"]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx node --test test/config.test.js`
Expected: FAIL(`defaultBitrate`/`resolveMaxBitrate` 未导出;默认用例 maxBitrate/degradation 仍是旧值)。

- [ ] **Step 3: 写实现(整文件替换)** `src/config.js`

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
const DEFAULT_DEGRADATION = "maintain-resolution";
const DEFAULT_CODEC_PRIORITY = ["av1", "vp9", "vp8"];

// Parse an int env value: non-int/empty -> default; out of range -> clamp. Warns either way.
function clampInt(raw, def, [lo, hi], name) {
  if (raw === undefined || raw === null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) { console.warn(`magpie: ${name}=${raw} not an int, using default ${def}`); return def; }
  if (n < lo) { console.warn(`magpie: ${name}=${n} below ${lo}, clamped`); return lo; }
  if (n > hi) { console.warn(`magpie: ${name}=${n} above ${hi}, clamped`); return hi; }
  return n;
}

// Adaptive bitrate floor for desktop content: ~2.5 bps/pixel, clamped to [1.5M, 8M].
// fps intentionally excluded — the cap is detail-bound (text), not motion-bound.
export function defaultBitrate(width, height) {
  return Math.min(8_000_000, Math.max(1_500_000, Math.round(width * height * 2.5)));
}

// Resolve MAGPIE_MAX_BITRATE to a bps number, or null when explicitly disabled.
//   unset/empty      -> adaptive default (defaultBitrate)
//   none/off         -> null (disabled, no cap)
//   <n>[k|M] <= 0    -> null (disabled)
//   <n>[k|M] > 0     -> that bps
//   non-numeric      -> warn + adaptive default
export function resolveMaxBitrate(raw, width, height) {
  const def = defaultBitrate(width, height);
  if (raw === undefined || raw === null || raw === "") return def;
  const t = String(raw).trim().toLowerCase();
  if (t === "none" || t === "off") return null;
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(t);
  if (!m) { console.warn(`magpie: MAGPIE_MAX_BITRATE=${raw} invalid, using default`); return def; }
  const mul = m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1000 : 1;
  const bps = Math.round(Number(m[1]) * mul);
  return bps <= 0 ? null : bps;
}

// Parse MAGPIE_CODEC_PRIORITY -> lowercase codec-name array. Empty/blank -> default.
// No validity filtering here (the streamer page filters to codecs the browser can encode).
export function parseCodecPriority(raw) {
  if (raw === undefined || raw === null) return DEFAULT_CODEC_PRIORITY.slice();
  const parts = String(raw).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parts.length ? parts : DEFAULT_CODEC_PRIORITY.slice();
}

export function loadConfig(env = process.env) {
  const width  = clampInt(env.MAGPIE_WIDTH,  DEFAULTS.WIDTH,  RANGE.WIDTH,  "MAGPIE_WIDTH");
  const height = clampInt(env.MAGPIE_HEIGHT, DEFAULTS.HEIGHT, RANGE.HEIGHT, "MAGPIE_HEIGHT");
  const quality = clampInt(env.MAGPIE_QUALITY, DEFAULTS.QUALITY, RANGE.QUALITY, "MAGPIE_QUALITY");
  const fps = clampInt(env.MAGPIE_FPS, DEFAULTS.FPS, RANGE.FPS, "MAGPIE_FPS");
  const every = Math.max(1, Math.round(1000 / fps));

  const maxBitrate = resolveMaxBitrate(env.MAGPIE_MAX_BITRATE, width, height);

  let maxFramerate = null;
  const mfRaw = env.MAGPIE_MAX_FRAMERATE;
  if (mfRaw !== undefined && mfRaw !== null && mfRaw !== "") {
    const n = Number(mfRaw);
    if (Number.isInteger(n) && n > 0) maxFramerate = n;
    else console.warn(`magpie: MAGPIE_MAX_FRAMERATE=${mfRaw} invalid, ignored`);
  }

  let degradation = DEFAULT_DEGRADATION;
  const degRaw = env.MAGPIE_DEGRADATION;
  if (degRaw !== undefined && degRaw !== null && degRaw !== "") {
    if (DEGRADATIONS.includes(degRaw)) degradation = degRaw;
    else console.warn(`magpie: MAGPIE_DEGRADATION=${degRaw} invalid, using default`);
  }

  return {
    viewport: { width, height },
    screencast: { quality, every },
    webrtc: {
      streamFps: fps,
      maxBitrate,
      maxFramerate,
      degradation,
      codecPriority: parseCodecPriority(env.MAGPIE_CODEC_PRIORITY),
    },
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
feat: flip desktop-friendly defaults + codec priority in config

degradation defaults to maintain-resolution; maxBitrate defaults to an
adaptive value (defaultBitrate: ~2.5bps/px clamped [1.5M,8M]) with an
explicit disable path (none/off or <=0 -> null). Add codecPriority
parsing (default av1,vp9,vp8). Replace parseBitrate with resolveMaxBitrate
(distinct value/disable/invalid outcomes). Still never throws.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: buildStreamerUrl —— 恒带 codec 参数

**Files:**
- Modify: `src/index.js`(`buildStreamerUrl` 函数,约第 25-32 行)
- Test: `test/index.test.js`(整文件替换)

**Interfaces:**
- Consumes: Task 1 的 `cfg.webrtc.codecPriority: string[]`。
- Produces: `buildStreamerUrl` 输出 URL 恒含 `codec=<comma-joined>`。

- [ ] **Step 1: 写测试(整文件替换)** `test/index.test.js`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStreamerUrl } from "../src/index.js";

test("buildStreamerUrl: w/h/fps/codec always present; caps only when set", () => {
  const url = buildStreamerUrl("http://127.0.0.1:8080", {
    viewport: { width: 1280, height: 800 },
    screencast: { quality: 80, every: 100 },
    webrtc: { streamFps: 10, maxBitrate: null, maxFramerate: null, degradation: null, codecPriority: ["av1", "vp9", "vp8"] },
  });
  assert.equal(url, "http://127.0.0.1:8080/streamer.html?w=1280&h=800&fps=10&codec=av1,vp9,vp8");
});

test("buildStreamerUrl: includes bitrate/maxFps/degradation when set; custom codec order", () => {
  const url = buildStreamerUrl("http://h:1", {
    viewport: { width: 640, height: 480 },
    screencast: { quality: 80, every: 50 },
    webrtc: { streamFps: 20, maxBitrate: 2500000, maxFramerate: 15, degradation: "maintain-resolution", codecPriority: ["vp9", "av1"] },
  });
  assert.equal(url, "http://h:1/streamer.html?w=640&h=480&fps=20&codec=vp9,av1&bitrate=2500000&maxFps=15&degradation=maintain-resolution");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx node --test test/index.test.js`
Expected: FAIL(URL 不含 `codec=`,且 `w.codecPriority` 当前未被读取——断言的 URL 不匹配)。

- [ ] **Step 3: 改实现** `src/index.js` 的 `buildStreamerUrl`

把现有函数(查找 `export function buildStreamerUrl(base, c)`)整体替换为:

```js
// Pure: build the streamer page URL from cfg. Exported for unit testing.
export function buildStreamerUrl(base, c) {
  const w = c.webrtc;
  const parts = [
    `w=${c.viewport.width}`,
    `h=${c.viewport.height}`,
    `fps=${w.streamFps}`,
    `codec=${w.codecPriority.join(",")}`,
  ];
  if (w.maxBitrate) parts.push(`bitrate=${w.maxBitrate}`);
  if (w.maxFramerate) parts.push(`maxFps=${w.maxFramerate}`);
  if (w.degradation) parts.push(`degradation=${w.degradation}`);
  return `${base}/streamer.html?${parts.join("&")}`;
}
```

(其余 `index.js` 内容不变。)

- [ ] **Step 4: 运行确认通过**

Run: `npx node --test test/index.test.js`
Expected: PASS(两条 URL 用例)。

- [ ] **Step 5: 提交**

```bash
git add src/index.js test/index.test.js
git commit -m "$(cat <<'EOF'
feat: buildStreamerUrl always emits codec= query param

Thread cfg.webrtc.codecPriority into the streamer URL (comma-joined),
always present (has a default). bitrate/maxFps/degradation unchanged
(conditional on set/non-null).

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: streamer.html —— codec query 解析 + setCodecPreferences

**Files:**
- Modify: `src/streamer/streamer.html`(params 段、`__magpieCfg`、`relayOffer`)
- Test: `test/streamer/streamer-params.test.js`(整文件替换)

**Interfaces:**
- Consumes: Task 2 的 URL query `codec=av1,vp9,vp8`。
- Produces:页内 `CODECS: string[]`;`relayOffer` 内对 sender 所属 transceiver 调 `setCodecPreferences(排列后的 caps)`。

- [ ] **Step 1: 写测试(整文件替换)** `test/streamer/streamer-params.test.js`

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

test("streamer.html: parses fps/bitrate/maxFps/degradation/codec from query", async () => {
  const { server, base } = await serveStreamer();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/streamer.html?w=16&h=16&fps=20&bitrate=1500000&maxFps=15&degradation=maintain-resolution&codec=vp9,av1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__magpieCfg, { timeout: 3000 });
    const cfg = await page.evaluate(() => window.__magpieCfg);
    assert.equal(cfg.FPS, 20);
    assert.equal(cfg.BITRATE, 1500000);
    assert.equal(cfg.MAXFPS, 15);
    assert.equal(cfg.DEGRADATION, "maintain-resolution");
    assert.deepEqual(cfg.CODECS, ["vp9", "av1"]);
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
    assert.equal(cfg.FPS, 10);
    assert.equal(cfg.BITRATE, 0);
    assert.equal(cfg.MAXFPS, 0);
    assert.equal(cfg.DEGRADATION, "");
    assert.deepEqual(cfg.CODECS, ["av1", "vp9", "vp8"]);
  } finally {
    await browser.close();
    server.close();
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx node --test test/streamer/streamer-params.test.js`
Expected: FAIL(`cfg.CODECS` 为 undefined → `deepEqual` 失败)。

- [ ] **Step 3: 改实现** `src/streamer/streamer.html`

先 Read 该文件,然后做三处精确 Edit:

**Edit A** —— params 段加 `CODECS`(把现有 `DEGRADATION` 那行之后、`canvas.width` 之前插入):

old:
```
  const DEGRADATION = params.get("degradation") || "";     // sender degradationPreference; "" = unset
  canvas.width = W; canvas.height = H;
```
new:
```
  const DEGRADATION = params.get("degradation") || "";     // sender degradationPreference; "" = unset
  const CODECS = (params.get("codec") || "av1,vp9,vp8").split(",").map((s) => s.trim()).filter(Boolean); // preferred codec order
  canvas.width = W; canvas.height = H;
```

**Edit B** —— `__magpieCfg` 加 `CODECS`:

old:
```
  window.__magpieCfg = { FPS, BITRATE, MAXFPS, DEGRADATION };
```
new:
```
  window.__magpieCfg = { FPS, BITRATE, MAXFPS, DEGRADATION, CODECS };
```

**Edit C** —— `relayOffer` 内,`const sender = pc.addTrack(...)` 之后、`if (BITRATE || MAXFPS || DEGRADATION)` 之前,插入 codec 偏好块:

old:
```
    const sender = pc.addTrack(stream.getVideoTracks()[0]);
    // Optional sender caps (maxBitrate/maxFramerate/degradationPreference).
```
new:
```
    const sender = pc.addTrack(stream.getVideoTracks()[0]);
    // Codec preferences: prefer CODECS order over the browser defaults.
    // Build a permutation of the available caps (matched first, the rest appended
    // in original order so e.g. H.264 stays negotiable, just deprioritized).
    try {
      const caps = RTCRtpSender.getCapabilities("video");
      if (caps && caps.codecs && caps.codecs.length) {
        const preferred = [];
        for (const name of CODECS) {
          for (const codec of caps.codecs) {
            if (codec.mimeType.split("/")[1].toLowerCase() === name && !preferred.includes(codec)) preferred.push(codec);
          }
        }
        for (const codec of caps.codecs) if (!preferred.includes(codec)) preferred.push(codec);
        const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
        if (transceiver) transceiver.setCodecPreferences(preferred);
      }
    } catch (e) { console.warn("magpie: setCodecPreferences failed", e); }
    // Optional sender caps (maxBitrate/maxFramerate/degradationPreference).
```

(`connectInternal`、`setInterval` 心跳、`setParameters` 块、`window.__ready` 均不变。)

- [ ] **Step 4: 运行确认通过**

Run: `npx node --test test/streamer/streamer-params.test.js`
Expected: PASS(两条解析用例,含 `CODECS`)。

- [ ] **Step 5: 回归 —— 确认 setCodecPreferences 不破坏 relayOffer**

Run: `npx node --test test/streamer/StreamerPeer.test.js`
Expected: PASS(该测试驱动真实 `relayOffer`;新加的 `setCodecPreferences` 块在每次 offer 都会执行,若它抛错未被 catch 会导致 offer 失败、video 不通——此测试通过即证明该路径不破坏端到端视频)。

- [ ] **Step 6: 提交**

```bash
git add src/streamer/streamer.html test/streamer/streamer-params.test.js
git commit -m "$(cat <<'EOF'
feat: streamer.html applies codec preferences via setCodecPreferences

Parse ?codec= query (default av1,vp9,vp8) into CODECS; expose in
window.__magpieCfg. In relayOffer, reorder RTCRtpSender.getCapabilities
codecs to put preferred ones first (matched-by-name, all profile variants),
appending the rest (e.g. H.264) so they remain negotiable but
deprioritized. AV1 unsupported by the build -> absent from caps -> auto
falls back to VP9. Wrapped so failures don't break the offer.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 文档(CLAUDE.md)+ 全量回归

**Files:**
- Modify: `CLAUDE.md`(env 行、config.js 模块表行、streamer.html 模块表行)

**Interfaces:** 无(纯文档)。

- [ ] **Step 1: 改 env 行**

把 CLAUDE.md 里的 env 段(以 `` `MAGPIE_MAX_BITRATE` (unset; bps, accepts `` 开头的那两行相关内容)更新。定位这一段:

```
`MAGPIE_QUALITY` (80, jpeg 1-100), `MAGPIE_FPS` (10, drives both CDP `every` and
`captureStream`), `MAGPIE_MAX_BITRATE` (unset; bps, accepts `2500k`/`2.5m`),
`MAGPIE_MAX_FRAMERATE` (unset), `MAGPIE_DEGRADATION` (unset;
`maintain-resolution`/`maintain-framerate`/`balanced`).
```

替换为:

```
`MAGPIE_QUALITY` (80, jpeg 1-100), `MAGPIE_FPS` (10, drives both CDP `every` and
`captureStream`), `MAGPIE_MAX_BITRATE` (adaptive default from viewport, ~2.5bps/px
clamped [1.5M,8M]; `0`/`none`/`off` to disable; bps, accepts `2500k`/`2.5m`),
`MAGPIE_MAX_FRAMERATE` (unset), `MAGPIE_DEGRADATION` (`maintain-resolution`;
`maintain-resolution`/`maintain-framerate`/`balanced`), `MAGPIE_CODEC_PRIORITY`
(`av1,vp9,vp8`; preferred video codec order, H.264 falls last).
```

- [ ] **Step 2: 改 config.js 模块表行**

old:
```
| `src/config.js` | Pure `loadConfig(env)` + `parseBitrate`: reads/validates `MAGPIE_*` video+quality env, never throws. Drives viewport, screencast opts, and WebRTC sender caps. |
```
new:
```
| `src/config.js` | Pure `loadConfig(env)` + `defaultBitrate`/`resolveMaxBitrate`/`parseCodecPriority`: reads/validates `MAGPIE_*` video+quality env, never throws. Drives viewport, screencast opts, and WebRTC sender caps + codec order. |
```

- [ ] **Step 3: 改 streamer.html 模块表行**

old:
```
| `src/streamer/streamer.html` | canvas + `captureStream(FPS)` (default 10, via `?fps=`) + page-side `RTCPeerConnection`; receives JPEG frames on `/internal`; applies optional sender caps from `?bitrate=&maxFps=&degradation=`; sets `window.__ready=true` and exposes `window.__magpieCfg`. |
```
new:
```
| `src/streamer/streamer.html` | canvas + `captureStream(FPS)` (default 10, via `?fps=`) + page-side `RTCPeerConnection`; receives JPEG frames on `/internal`; applies sender caps from `?bitrate=&maxFps=&degradation=` and codec order from `?codec=` via `setCodecPreferences`; sets `window.__ready=true` and exposes `window.__magpieCfg`. |
```

- [ ] **Step 4: 全量回归**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: document codec-priority + flipped defaults in CLAUDE.md

Update env list (MAX_BITRATE adaptive default + disable path; DEGRADATION
default maintain-resolution; new MAGPIE_CODEC_PRIORITY), config.js module
row (resolveMaxBitrate/defaultBitrate/parseCodecPriority), and streamer.html
row (setCodecPreferences from ?codec=).

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review(计划作者自检,已执行)

- **Spec coverage**:spec §2(默认翻转 + 码率公式 + 禁用规则)→ Task 1;§3(codec 解析 / URL / 页内 setCodecPreferences)→ Task 1(config 解析)+ Task 2(URL)+ Task 3(页内);§4 cfg 形状 → Task 1;§5 模块改动 → Task 1-4;§6 错误处理 → Task 1(warn + 回退)+ Task 3(try/catch + caps 排列不变量);§7 测试 → 各 Task 测试步骤;§8 不在范围 → 未实现,符合。
- **Placeholder scan**:无 TBD/TODO;每个代码步骤含完整可运行代码。
- **Type consistency**:`cfg.webrtc.codecPriority: string[]` 在 Task 1(产出)、Task 2(`w.codecPriority.join(",")`)、Task 3(URL `codec=` split 回数组)三处一致;`defaultBitrate`/`resolveMaxBitrate`/`parseCodecPriority` 签名在 Task 1 定义、Task 1 测试调用一致;`CODECS` 变量名在 Task 3 的 Edit A(定义)/Edit B(__magpieCfg)/Edit C(relayOffer)一致。
- **`parseBitrate` 移除**:仅 `test/config.test.js` 与 `CLAUDE.md` 引用;Task 1 测试改为 `resolveMaxBitrate`/`defaultBitrate`,Task 4 改 CLAUDE.md。`src/index.js` 不导入 `parseBitrate`,无破坏。

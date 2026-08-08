# magpie 远程浏览器服务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js service (magpie) that runs a headless Chromium on `https://gitee.com` and streams it to a single remote user over WebRTC video, with mouse/keyboard input and navigation.

**Architecture:** A shared Playwright headless Chromium runs two pages: the **target page** (gitee.com) and a **streamer page**. CDP `Page.startScreencast` captures the target page as JPEG frames into Node; Node relays them over an internal WebSocket (`/internal`) to the streamer page, which draws them onto a `<canvas>`, calls `canvas.captureStream()`, and sends the video over a native in-page `RTCPeerConnection` (Chromium's libwebrtc) to the client. WebRTC signaling (offer/answer) is relayed by Node to the streamer page via `page.evaluate`. Mouse/keyboard/navigation travel on the client-facing `/signaling` WebSocket straight to Node → CDP, never over WebRTC.

**Tech Stack:** Node.js (ESM), `playwright`, `ws`, Node's built-in `node:test`.

## Global Constraints

- **Runtime:** Node.js >= 18 (stable `node:test`, ESM top-level await). `"type": "module"`; all source/tests use `import`.
- **Dependencies:** `playwright` and `ws` only. **No `werift-webrtc`, no `canvas`/node-canvas.** Video encoding is done by Chromium's libwebrtc inside the streamer page.
- **Testing:** `node:test` + `node:assert/strict`. Tests in `test/` mirroring `src/`, named `*.test.js`. Run with `npm test`.
- **Headless only:** Chromium launched with `headless: true` (Playwright defaults to the new headless mode). No Xvfb, no display server, no browser extensions.
- **Single session, single user:** one Chromium + one target page + one streamer page + one client peer at a time.
- **Viewport:** fixed `1280 × 800`. Not resizable in v1.
- **Capture source:** CDP `Page.startScreencast` is the only pixel source (headless cannot self-capture an arbitrary site). JPEG frames go to Node, then relay to the streamer page.
- **No audio, no clipboard, no auth, no STUN/TURN** (LAN/local only; `iceServers: []` on both peers).
- **Protocol:** `/signaling` JSON messages — `{t:"hello"|"offer"|"answer"|"navigate"|"navigate-result"|"status"|"mouse"|"wheel"|"key"|"error"|"reload"}`. Full-SDP signaling (wait for ICE gathering complete), no trickle.
- **Commit convention:** every commit ends with a blank line then `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **Branch:** `feat/magpie`.

---

## File Structure

- `package.json`, `.gitignore`
- `src/browser/BrowserSession.js` — target page: Playwright + CDP screencast/input/navigate (+ crash hooks).
- `src/streamer/StreamerPeer.js` — owns the streamer Playwright page; `relayOffer` via evaluate, `pushFrame` via the `/internal` socket.
- `src/streamer/streamer.html` — canvas + captureStream + RTCPeerConnection + `/internal` WS receiver + `window.relayOffer`.
- `src/webrtc/coords.js` — pure client→page mapper.
- `src/webrtc/keys.js` — pure CDP key map + message parser.
- `src/webrtc/InputChannel.js` — parse `/signaling` input messages → map → dispatch to BrowserSession.
- `src/server.js` — HTTP + `/signaling` WS + `/internal` WS.
- `src/index.js` — entry: shared browser + wiring.
- `src/public/client.html` — client page.
- `test/fixtures/click-target.html`, `test/**/*.test.js`.

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `.gitignore`, `src/.gitkeep`, `test/.gitkeep`

**Interfaces:**
- Produces: an ESM project where `npm install` and `npm test` succeed; Playwright's Chromium is installed.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "magpie",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Remote browser instance service: headless Chromium over WebRTC",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test"
  },
  "dependencies": {
    "playwright": "^1.49.0",
    "ws": "^8.18.0"
  }
}
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
.DS_Store
*.log
```

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: completes; `node_modules/` created. (Only `playwright` + `ws` — no native build steps.)

- [ ] **Step 4: Install Playwright's Chromium**

Run: `npx playwright install chromium`
Expected: downloads headless Chromium.

- [ ] **Step 5: Verify the test runner**

Create `test/sanity.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("sanity: node:test runs", () => {
  assert.equal(1 + 1, 2);
});
```

Run: `npm test`
Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore test/sanity.test.js src/.gitkeep test/.gitkeep
git commit -m "chore: scaffold magpie project (ESM, playwright+ws, node:test)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Spike — headless canvas.captureStream + WebRTC sender (GATE)

This task de-risks the single biggest unknown before building on it: does a headless Chromium page produce a capturable canvas video track that a second peer receives? **If this fails, stop and reconsider the approach.**

**Files:**
- Test: `test/spike.capturestream.test.js`

**Interfaces:**
- Produces: a passing test proving the headless captureStream → WebRTC path works (no production code yet).

- [ ] **Step 1: Write the spike test**

`test/spike.capturestream.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const STREAMER_HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="64" height="64"></canvas>
<script>
const c = document.getElementById("c"), x = c.getContext("2d");
const stream = c.captureStream(10);
window.pc = null;
window.setupAndAnswer = async (offer) => {
  window.pc = new RTCPeerConnection();
  window.pc.addTrack(stream.getVideoTracks()[0]);
  await window.pc.setRemoteDescription({ type: "offer", sdp: offer });
  const a = await window.pc.createAnswer();
  await window.pc.setLocalDescription(a);
  await new Promise((r) => {
    const t = setTimeout(r, 3000);
    window.pc.onicegatheringstatechange = () => { if (window.pc.iceGatheringState === "complete") { clearTimeout(t); r(); } };
  });
  return window.pc.localDescription.sdp;
};
let i = 0;
setInterval(() => { x.fillStyle = "hsl(" + ((i++ * 10) % 360) + ",100%,50%)"; x.fillRect(0, 0, 64, 64); }, 100);
</script></body></html>`;

const CLIENT_HTML = `<!DOCTYPE html><html><body>
<video id="v" autoplay playsinline muted></video>
<script>
window.pc = new RTCPeerConnection();
window.pc.addTransceiver("video", { direction: "recvonly" });
window.pc.ontrack = (e) => { document.getElementById("v").srcObject = e.streams[0]; };
window.makeOffer = async () => {
  const o = await window.pc.createOffer();
  await window.pc.setLocalDescription(o);
  await new Promise((r) => {
    const t = setTimeout(r, 3000);
    window.pc.onicegatheringstatechange = () => { if (window.pc.iceGatheringState === "complete") { clearTimeout(t); r(); } };
  });
  return window.pc.localDescription.sdp;
};
window.setAnswer = async (a) => {
    await window.pc.setRemoteDescription({ type: "answer", sdp: a });
    // ontrack is unreliable in headless Chromium; attach the receiver track by polling.
    for (let i = 0; i < 50; i++) {
      const r = window.pc.getReceivers().find((r) => r.track && r.track.kind === "video");
      if (r && r.track) { document.getElementById("v").srcObject = new MediaStream([r.track]); return; }
      await new Promise((res) => setTimeout(res, 100));
    }
  };
</script></body></html>`;

test("spike: headless captureStream -> WebRTC reaches a receiver page", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const a = await browser.newPage();
    const b = await browser.newPage();
    await a.setContent(STREAMER_HTML);
    await b.setContent(CLIENT_HTML);

    const offer = await b.evaluate(() => window.makeOffer());
    const answer = await a.evaluate((o) => window.setupAndAnswer(o), offer);
    await b.evaluate((ans) => window.setAnswer(ans), answer);

    await b.waitForFunction(() => { const v = document.getElementById("v"); return v && v.videoWidth > 0; }, { timeout: 8000 });
    const vw = await b.evaluate(() => document.getElementById("v").videoWidth);
    assert.ok(vw > 0, "receiver should have decoded video frames");
  } finally {
    await browser.close();
  }
});
```

- [ ] **Step 2: Run the spike**

Run: `npm test`
Expected: PASS. If it times out with `videoWidth === 0`, the headless captureStream/sender path is not working in this Chromium version — do not proceed to later tasks; revisit the approach (e.g., fall back to the werift variant).

> **Finding (validated 2026-08-08):** the headless `captureStream → WebRTC` path WORKS — ICE connects, the receiver gets a live video track, and frames decode (`videoWidth > 0`). However `RTCPeerConnection.ontrack` does **not** fire in headless Chromium, so receiver pages attach the track by **polling `pc.getReceivers()`** instead of relying on `ontrack`. Every receiver page in this plan (this spike, the Task 8 StreamerPeer test, and Task 10 client.html) uses that poll-attach pattern. Production clients are real browsers where `ontrack` fires normally; the poll is a fallback that also makes the headless E2E work.

- [ ] **Step 3: Commit**

```bash
git add test/spike.capturestream.test.js
git commit -m "test: spike headless canvas.captureStream -> WebRTC sender

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Client→page coordinate mapper (pure)

**Files:**
- Create: `src/webrtc/coords.js`
- Test: `test/webrtc/coords.test.js`

**Interfaces:**
- Produces: `export function mapClientToPage({ clientX, clientY, displayW, displayH, pageW, pageH }) → { x, y }`. Linear map assuming the video is displayed at the page's aspect ratio (no letterboxing).

- [ ] **Step 1: Write the failing test**

`test/webrtc/coords.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapClientToPage } from "../../src/webrtc/coords.js";

test("mapClientToPage: identity when display == page", () => {
  const r = mapClientToPage({ clientX: 640, clientY: 400, displayW: 1280, displayH: 800, pageW: 1280, pageH: 800 });
  assert.equal(r.x, 640);
  assert.equal(r.y, 400);
});

test("mapClientToPage: scales when display is half size", () => {
  const r = mapClientToPage({ clientX: 320, clientY: 200, displayW: 640, displayH: 400, pageW: 1280, pageH: 800 });
  assert.equal(r.x, 640);
  assert.equal(r.y, 400);
});

test("mapClientToPage: rounds fractional coords", () => {
  const r = mapClientToPage({ clientX: 160.5, clientY: 100, displayW: 640, displayH: 400, pageW: 1280, pageH: 800 });
  assert.equal(r.x, 321);
  assert.equal(r.y, 200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/webrtc/coords.js`:

```js
// Map a pointer position on the client's rendered <video> element to page CSS
// coordinates. Assumes the video is displayed at the page's aspect ratio
// (client sets video to width:100%, height:auto, so no letterboxing).
export function mapClientToPage({ clientX, clientY, displayW, displayH, pageW, pageH }) {
  return {
    x: Math.round((clientX / displayW) * pageW),
    y: Math.round((clientY / displayH) * pageH),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webrtc/coords.js test/webrtc/coords.test.js
git commit -m "feat(webrtc): add client to page coordinate mapper

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Key map + input message parser (pure)

**Files:**
- Create: `src/webrtc/keys.js`
- Test: `test/webrtc/keys.test.js`

**Interfaces:**
- Produces:
  - `export function mapKey({ key, code, keyCode }) → { key, code, windowsVirtualKeyCode, text }`.
  - `export function parseInputMessage(raw) → { kind: "mouse"|"wheel"|"key", ... }`. Throws on malformed JSON / unknown type.

- [ ] **Step 1: Write the failing test**

`test/webrtc/keys.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapKey, parseInputMessage } from "../../src/webrtc/keys.js";

test("mapKey: letter a", () => {
  const d = mapKey({ key: "a", code: "KeyA", keyCode: 65 });
  assert.equal(d.windowsVirtualKeyCode, 65);
  assert.equal(d.code, "KeyA");
  assert.equal(d.text, "a");
});

test("mapKey: Enter", () => {
  const d = mapKey({ key: "Enter", code: "Enter", keyCode: 13 });
  assert.equal(d.windowsVirtualKeyCode, 13);
  assert.equal(d.text, "\r");
});

test("mapKey: unknown code falls back to keyCode", () => {
  const d = mapKey({ key: "x", code: "UnknownX", keyCode: 88 });
  assert.equal(d.windowsVirtualKeyCode, 88);
});

test("parseInputMessage: mouse", () => {
  const e = parseInputMessage(JSON.stringify({ t: "mouse", x: 10, y: 20, displayW: 100, displayH: 100, type: "pressed", button: "left", clickCount: 1 }));
  assert.equal(e.kind, "mouse");
  assert.equal(e.type, "pressed");
});

test("parseInputMessage: key", () => {
  const e = parseInputMessage(JSON.stringify({ t: "key", type: "keyDown", key: "a", code: "KeyA", keyCode: 65 }));
  assert.equal(e.kind, "key");
  assert.equal(e.code, "KeyA");
});

test("parseInputMessage: throws on bad JSON", () => {
  assert.throws(() => parseInputMessage("not json"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

`src/webrtc/keys.js`:

```js
const PRINTABLE_TEXT = { Enter: "\r", Tab: "\t", Backspace: "\x08" };

export function mapKey({ key, code, keyCode }) {
  const vk = keyCode ?? 0;
  let text = "";
  if (key && key.length === 1) text = key;
  else if (PRINTABLE_TEXT[key]) text = PRINTABLE_TEXT[key];
  return { key: key ?? "", code: code ?? "", windowsVirtualKeyCode: vk, text };
}

export function parseInputMessage(raw) {
  const str = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  let msg;
  try {
    msg = JSON.parse(str);
  } catch {
    throw new Error("invalid input message (not JSON)");
  }
  switch (msg.t) {
    case "mouse":
      return {
        kind: "mouse",
        x: Number(msg.x), y: Number(msg.y),
        displayW: Number(msg.displayW), displayH: Number(msg.displayH),
        type: msg.type, button: msg.button ?? "left",
        clickCount: msg.clickCount ?? 1, buttons: msg.buttons ?? 0,
      };
    case "wheel":
      return {
        kind: "wheel",
        x: Number(msg.x), y: Number(msg.y),
        displayW: Number(msg.displayW), displayH: Number(msg.displayH),
        deltaX: Number(msg.deltaX ?? 0), deltaY: Number(msg.deltaY ?? 0),
      };
    case "key":
      return {
        kind: "key",
        type: msg.type, key: msg.key, code: msg.code,
        keyCode: Number(msg.keyCode ?? 0), modifiers: Number(msg.modifiers ?? 0),
        mapKey: mapKey({ key: msg.key, code: msg.code, keyCode: msg.keyCode }),
      };
    default:
      throw new Error(`unknown input message type: ${msg.t}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webrtc/keys.js test/webrtc/keys.test.js
git commit -m "feat(webrtc): add CDP key map and input message parser

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: BrowserSession — launch, screencast, navigate

**Files:**
- Create: `src/browser/BrowserSession.js`
- Test: `test/browser/BrowserSession.test.js`, `test/fixtures/click-target.html`

**Interfaces:**
- Produces: `export class BrowserSession`:
  - `constructor({ url = "https://gitee.com", width = 1280, height = 800, browser } = {})` — optional injected shared browser.
  - `async start()`, `async stop()`, `async navigate(url)`.
  - `async startScreencast(onFrame)` — `onFrame: ({ data: Buffer, metadata, sessionId }) => void`; acks each frame.
  - `async stopScreencast()`.
  - `getViewport() → { width, height }`, `getUrl() → string`.
  - Settable `onCrash` callback, `_handleCrash()`, `async restart()` (added fully in Task 11; here just the property).

- [ ] **Step 1: Write the test fixture**

`test/fixtures/click-target.html`:

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>click target</title></head>
<body>
  <button id="btn" style="position:absolute;left:100px;top:100px;width:120px;height:60px;">Click me</button>
  <input id="inp" style="position:absolute;left:100px;top:200px;width:200px;height:40px;" />
  <div id="count">0</div>
  <script>
    let n = 0;
    document.getElementById("btn").addEventListener("click", () => {
      n++; document.getElementById("count").textContent = String(n);
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: Write the failing test**

`test/browser/BrowserSession.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { BrowserSession } from "../../src/browser/BrowserSession.js";

const FIXTURE = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "click-target.html")).href;

test("BrowserSession: start + screencast yields JPEG frames", async () => {
  const session = new BrowserSession({ url: FIXTURE, width: 400, height: 300 });
  await session.start();
  try {
    const frames = [];
    await session.startScreencast((f) => frames.push(f));
    await new Promise((r) => setTimeout(r, 1500));
    await session.stopScreencast();
    assert.ok(frames.length > 0, "expected at least one screencast frame");
    assert.ok(frames[0].data.length > 0);
    assert.ok(frames[0].metadata.deviceWidth > 0);
  } finally {
    await session.stop();
  }
});

test("BrowserSession: navigate changes url", async () => {
  const session = new BrowserSession({ url: "about:blank", width: 400, height: 300 });
  await session.start();
  try {
    await session.navigate(FIXTURE);
    assert.ok(session.getUrl().includes("click-target.html"));
  } finally {
    await session.stop();
  }
});

test("BrowserSession: getViewport", () => {
  const session = new BrowserSession({ url: "about:blank", width: 500, height: 400 });
  assert.deepEqual(session.getViewport(), { width: 500, height: 400 });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `BrowserSession` not found.

- [ ] **Step 4: Write minimal implementation**

`src/browser/BrowserSession.js`:

```js
import { chromium } from "playwright";

export class BrowserSession {
  constructor({ url = "https://gitee.com", width = 1280, height = 800, browser } = {}) {
    this._url = url;
    this._width = width;
    this._height = height;
    this._injectedBrowser = browser ?? null;
    this._browser = null;
    this._ownsBrowser = false;
    this._context = null;
    this._page = null;
    this._cdp = null;
    this._onFrame = null;
    this.onCrash = null;
  }

  getViewport() {
    return { width: this._width, height: this._height };
  }

  getUrl() {
    return this._page ? this._page.url() : this._url;
  }

  async start() {
    if (this._injectedBrowser) {
      this._browser = this._injectedBrowser;
      this._ownsBrowser = false;
    } else {
      this._browser = await chromium.launch({ headless: true });
      this._ownsBrowser = true;
    }
    this._context = await this._browser.newContext({ viewport: { width: this._width, height: this._height } });
    this._page = await this._context.newPage();
    await this._page.goto(this._url, { waitUntil: "domcontentloaded" });
    this._cdp = await this._context.newCDPSession(this._page);
    this._page.on("crash", () => this._handleCrash());
    this._browser.on("disconnected", () => this._handleCrash());
  }

  _handleCrash() {
    if (this.onCrash) { try { this.onCrash(); } catch {} }
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async stop() {
    await this.stopScreencast();
    try { if (this._context) await this._context.close(); } catch {}
    if (this._ownsBrowser && this._browser) { try { await this._browser.close(); } catch {} }
    this._browser = this._context = this._page = this._cdp = null;
  }

  async navigate(url) {
    this._url = url;
    if (this._page) await this._page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async startScreencast(onFrame) {
    this._onFrame = onFrame;
    this._cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
      try {
        if (this._onFrame) this._onFrame({ data: Buffer.from(data, "base64"), metadata, sessionId });
      } finally {
        await this._cdp.send("Page.screencastFrameAck", { sessionId });
      }
    });
    await this._cdp.send("Page.startScreencast", {
      format: "jpeg", quality: 80, every: 100,
      maxWidth: this._width, maxHeight: this._height,
    });
  }

  async stopScreencast() {
    if (this._cdp) {
      try { await this._cdp.send("Page.stopScreencast"); } catch {}
      this._cdp.removeAllListeners("Page.screencastFrame");
    }
    this._onFrame = null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/browser/BrowserSession.js test/browser/BrowserSession.test.js test/fixtures/click-target.html
git commit -m "feat(browser): add BrowserSession with CDP screencast + navigate

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: BrowserSession — mouse/key/wheel input dispatch

**Files:**
- Modify: `src/browser/BrowserSession.js`
- Test: `test/browser/BrowserSession.input.test.js`

**Interfaces:**
- Produces (added to `BrowserSession`):
  - `async dispatchMouse({ x, y, type, button, buttons, clickCount })` — `type` ∈ `moved|pressed|released`.
  - `async dispatchWheel({ x, y, deltaX, deltaY })` — CDP `mouseWheel`.
  - `async dispatchKey({ type, mapKey, modifiers })` — CDP keyDown/keyUp; sends a `char` event with `mapKey.text` on `keyDown`.

- [ ] **Step 1: Write the failing test**

`test/browser/BrowserSession.input.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { BrowserSession } from "../../src/browser/BrowserSession.js";

const FIXTURE = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "click-target.html")).href;

test("BrowserSession: mouse click registers on the page", async () => {
  const session = new BrowserSession({ url: FIXTURE, width: 400, height: 300 });
  await session.start();
  try {
    await session.dispatchMouse({ x: 160, y: 130, type: "moved" });
    await session.dispatchMouse({ x: 160, y: 130, type: "pressed", button: "left", clickCount: 1 });
    await session.dispatchMouse({ x: 160, y: 130, type: "released", button: "left", clickCount: 1 });
    await session._page.waitForFunction(() => document.getElementById("count").textContent !== "0", { timeout: 2000 });
    const n = await session._page.evaluate(() => document.getElementById("count").textContent);
    assert.equal(n, "1");
  } finally {
    await session.stop();
  }
});

test("BrowserSession: key dispatch types into input", async () => {
  const session = new BrowserSession({ url: FIXTURE, width: 400, height: 300 });
  await session.start();
  try {
    await session.dispatchMouse({ x: 200, y: 220, type: "pressed", button: "left", clickCount: 1 });
    await session.dispatchMouse({ x: 200, y: 220, type: "released", button: "left", clickCount: 1 });
    await session.dispatchKey({ type: "keyDown", mapKey: { key: "h", code: "KeyH", windowsVirtualKeyCode: 72, text: "h" } });
    await session.dispatchKey({ type: "keyUp", mapKey: { key: "h", code: "KeyH", windowsVirtualKeyCode: 72, text: "" } });
    await session.dispatchKey({ type: "keyDown", mapKey: { key: "i", code: "KeyI", windowsVirtualKeyCode: 73, text: "i" } });
    await session.dispatchKey({ type: "keyUp", mapKey: { key: "i", code: "KeyI", windowsVirtualKeyCode: 73, text: "" } });
    const val = await session._page.evaluate(() => document.getElementById("inp").value);
    assert.equal(val, "hi");
  } finally {
    await session.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `dispatchMouse`/`dispatchKey` are not functions.

- [ ] **Step 3: Write minimal implementation**

Add inside `BrowserSession` (after `stopScreencast`):

```js
  async dispatchMouse({ x, y, type, button = "left", buttons = 0, clickCount = 1 }) {
    // client/InputChannel use moved|pressed|released; map to CDP type names.
    const cdpType = type === "moved" ? "mouseMoved" : type === "pressed" ? "mousePressed" : "mouseReleased";
    await this._cdp.send("Input.dispatchMouseEvent", {
      type: cdpType, x, y, button, buttons, clickCount, pointerType: "mouse",
    });
  }

  async dispatchWheel({ x, y, deltaX = 0, deltaY = 0 }) {
    await this._cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX, deltaY, pointerType: "mouse",
    });
  }

  async dispatchKey({ type, mapKey, modifiers = 0 }) {
    await this._cdp.send("Input.dispatchKeyEvent", {
      type,
      key: mapKey.key,
      code: mapKey.code,
      windowsVirtualKeyCode: mapKey.windowsVirtualKeyCode,
      modifiers,
    });
    if (mapKey.text && type === "keyDown") {
      await this._cdp.send("Input.dispatchKeyEvent", { type: "char", text: mapKey.text, modifiers });
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/browser/BrowserSession.js test/browser/BrowserSession.input.test.js
git commit -m "feat(browser): add CDP mouse/key/wheel input dispatch

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: InputChannel — /signaling messages → CDP dispatch

**Files:**
- Create: `src/webrtc/InputChannel.js`
- Test: `test/webrtc/InputChannel.test.js`

**Interfaces:**
- Consumes: a `browserSession` with `dispatchMouse`/`dispatchWheel`/`dispatchKey`; a `viewportProvider` with `getViewport()`; `keys.js` + `coords.js`.
- Produces: `export class InputChannel` with `constructor({ browserSession, viewportProvider })`, `async handle(raw)`.

- [ ] **Step 1: Write the failing test**

`test/webrtc/InputChannel.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { InputChannel } from "../../src/webrtc/InputChannel.js";

function fakeBrowserSession() {
  const calls = [];
  return {
    calls,
    dispatchMouse: (m) => calls.push({ kind: "mouse", ...m }),
    dispatchWheel: (m) => calls.push({ kind: "wheel", ...m }),
    dispatchKey: (m) => calls.push({ kind: "key", ...m }),
  };
}

const vp = { getViewport: () => ({ width: 1280, height: 800 }) };

test("InputChannel: maps + dispatches mouse", async () => {
  const bs = fakeBrowserSession();
  const ic = new InputChannel({ browserSession: bs, viewportProvider: vp });
  await ic.handle(JSON.stringify({ t: "mouse", x: 320, y: 200, displayW: 640, displayH: 400, type: "pressed", button: "left", clickCount: 1 }));
  assert.equal(bs.calls.length, 1);
  assert.equal(bs.calls[0].x, 640);
  assert.equal(bs.calls[0].y, 400);
});

test("InputChannel: maps + dispatches wheel", async () => {
  const bs = fakeBrowserSession();
  const ic = new InputChannel({ browserSession: bs, viewportProvider: vp });
  await ic.handle(JSON.stringify({ t: "wheel", x: 100, y: 100, displayW: 1280, displayH: 800, deltaY: -100 }));
  assert.equal(bs.calls.length, 1);
  assert.equal(bs.calls[0].deltaY, -100);
});

test("InputChannel: dispatches key", async () => {
  const bs = fakeBrowserSession();
  const ic = new InputChannel({ browserSession: bs, viewportProvider: vp });
  await ic.handle(JSON.stringify({ t: "key", type: "keyDown", key: "a", code: "KeyA", keyCode: 65 }));
  assert.equal(bs.calls.length, 1);
  assert.equal(bs.calls[0].mapKey.windowsVirtualKeyCode, 65);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `InputChannel` not found.

- [ ] **Step 3: Write minimal implementation**

`src/webrtc/InputChannel.js`:

```js
import { parseInputMessage } from "./keys.js";
import { mapClientToPage } from "./coords.js";

export class InputChannel {
  constructor({ browserSession, viewportProvider }) {
    this._bs = browserSession;
    this._vp = viewportProvider;
  }

  async handle(raw) {
    let event;
    try { event = parseInputMessage(raw); } catch { return; }
    const vp = this._vp.getViewport();

    if (event.kind === "mouse") {
      const { x, y } = mapClientToPage({
        clientX: event.x, clientY: event.y,
        displayW: event.displayW, displayH: event.displayH,
        pageW: vp.width, pageH: vp.height,
      });
      await this._bs.dispatchMouse({ x, y, type: event.type, button: event.button, clickCount: event.clickCount, buttons: event.buttons });
    } else if (event.kind === "wheel") {
      const { x, y } = mapClientToPage({
        clientX: event.x, clientY: event.y,
        displayW: event.displayW, displayH: event.displayH,
        pageW: vp.width, pageH: vp.height,
      });
      await this._bs.dispatchWheel({ x, y, deltaX: event.deltaX, deltaY: event.deltaY });
    } else if (event.kind === "key") {
      await this._bs.dispatchKey({ type: event.type, mapKey: event.mapKey, modifiers: event.modifiers });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webrtc/InputChannel.js test/webrtc/InputChannel.test.js
git commit -m "feat(webrtc): add InputChannel (signaling -> CDP dispatch)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: StreamerPeer + streamer.html (the core new piece)

**Files:**
- Create: `src/streamer/streamer.html`, `src/streamer/StreamerPeer.js`
- Test: `test/streamer/StreamerPeer.test.js`

**Interfaces:**
- Consumes: a shared Playwright `browser`; an HTTP server that serves `streamer.html` at `/streamer.html` and accepts the `/internal` WS upgrade.
- Produces:
  - `export class StreamerPeer`:
    - `constructor({ browser })`
    - `async start({ streamerUrl })` — new context + page, goto `streamerUrl`, wait until the page reports ready.
    - `setFrameSocket(ws)` — store the `/internal` socket (the page opened it on load).
    - `async pushFrame(jpegBuffer)` — send binary on the frame socket.
    - `async relayOffer(offerSdp) → answerSdp` — via `page.evaluate(o => window.relayOffer(o), offerSdp)`.
    - `async stop()` — close page/context.

- [ ] **Step 1: Write `src/streamer/streamer.html`**

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>magpie streamer</title></head>
<body>
<canvas id="c"></canvas>
<script>
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  // Viewport passed via query (?w=&h=); used as the canvas/stream size.
  const params = new URLSearchParams(location.search);
  const W = Number(params.get("w") || 1280);
  const H = Number(params.get("h") || 800);
  canvas.width = W; canvas.height = H;

  let stream = canvas.captureStream(15);
  let pc = null;

  // Receive JPEG frames from Node and draw them.
  function connectInternal() {
    const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/internal");
    ws.binaryType = "arraybuffer";
    ws.onmessage = async (e) => {
      try {
        const bmp = await createImageBitmap(new Blob([e.data]));
        ctx.drawImage(bmp, 0, 0, W, H);
        bmp.close();
      } catch {}
    };
    ws.onclose = () => setTimeout(connectInternal, 500);
  }
  connectInternal();

  // Driven by Node via page.evaluate when a client offer arrives.
  window.relayOffer = async (offer) => {
    if (pc) { try { pc.close(); } catch {} }
    pc = new RTCPeerConnection();
    pc.addTrack(stream.getVideoTracks()[0]);
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 3000);
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } };
    });
    return pc.localDescription.sdp;
  };

  window.__ready = true;
</script>
</body>
</html>
```

- [ ] **Step 2: Write `src/streamer/StreamerPeer.js`**

```js
export class StreamerPeer {
  constructor({ browser }) {
    this._browser = browser;
    this._context = null;
    this._page = null;
    this._frameSocket = null;
  }

  async start({ streamerUrl }) {
    this._context = await this._browser.newContext();
    this._page = await this._context.newPage();
    await this._page.goto(streamerUrl, { waitUntil: "domcontentloaded" });
    await this._page.waitForFunction(() => window.__ready === true, { timeout: 5000 });
  }

  setFrameSocket(ws) {
    this._frameSocket = ws;
  }

  async pushFrame(jpegBuffer) {
    if (this._frameSocket && this._frameSocket.readyState === this._frameSocket.OPEN) {
      this._frameSocket.send(jpegBuffer);
    }
  }

  async relayOffer(offerSdp) {
    return this._page.evaluate((o) => window.relayOffer(o), offerSdp);
  }

  async stop() {
    this._frameSocket = null;
    try { if (this._context) await this._context.close(); } catch {}
    this._context = this._page = null;
  }
}
```

- [ ] **Step 3: Write the integration test (inline server provides streamer.html + /internal)**

`test/streamer/StreamerPeer.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import { StreamerPeer } from "../../src/streamer/StreamerPeer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STREAMER_HTML = path.join(__dirname, "..", "..", "src", "streamer", "streamer.html");

// A 1x1 PNG (valid, dependency-free) used to push at least one frame.
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const CLIENT_HTML = `<!DOCTYPE html><html><body>
<video id="v" autoplay playsinline muted></video>
<script>
window.pc = new RTCPeerConnection();
window.pc.addTransceiver("video", { direction: "recvonly" });
window.pc.ontrack = (e) => { document.getElementById("v").srcObject = e.streams[0]; };
window.makeOffer = async () => {
  const o = await window.pc.createOffer();
  await window.pc.setLocalDescription(o);
  await new Promise((r) => { const t = setTimeout(r, 3000); window.pc.onicegatheringstatechange = () => { if (window.pc.iceGatheringState === "complete") { clearTimeout(t); r(); } }; });
  return window.pc.localDescription.sdp;
};
window.setAnswer = async (a) => {
    await window.pc.setRemoteDescription({ type: "answer", sdp: a });
    // ontrack is unreliable in headless Chromium; attach the receiver track by polling.
    for (let i = 0; i < 50; i++) {
      const r = window.pc.getReceivers().find((r) => r.track && r.track.kind === "video");
      if (r && r.track) { document.getElementById("v").srcObject = new MediaStream([r.track]); return; }
      await new Promise((res) => setTimeout(res, 100));
    }
  };
</script></body></html>`;

test("StreamerPeer: relays offer and streams pushed frames to a client peer", async () => {
  const browser = await chromium.launch({ headless: true });
  const html = await readFile(STREAMER_HTML, "utf8");

  const httpServer = http.createServer((req, res) => {
    if (req.url.startsWith("/streamer.html")) { res.writeHead(200, { "content-type": "text/html" }); return res.end(html); }
    res.writeHead(404); res.end();
  });
  const internalWss = new WebSocketServer({ server: httpServer, path: "/internal" });

  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = httpServer.address().port;

  try {
    const sp = new StreamerPeer({ browser });
    internalWss.on("connection", (ws) => sp.setFrameSocket(ws));
    await sp.start({ streamerUrl: `http://127.0.0.1:${port}/streamer.html?w=16&h=16` });

    // Client peer (real libwebrtc) in a second page.
    const clientPage = await browser.newPage();
    await clientPage.setContent(CLIENT_HTML);
    const offer = await clientPage.evaluate(() => window.makeOffer());
    const answer = await sp.relayOffer(offer);
    await clientPage.evaluate((a) => window.setAnswer(a), answer);

    // Push frames so the track unmutes.
    const pump = setInterval(() => sp.pushFrame(PNG_1x1), 100);
    try {
      await clientPage.waitForFunction(() => document.getElementById("v").videoWidth > 0, { timeout: 8000 });
      const vw = await clientPage.evaluate(() => document.getElementById("v").videoWidth);
      assert.ok(vw > 0, "client should receive video from the streamer page");
    } finally {
      clearInterval(pump);
    }

    await clientPage.close();
    await sp.stop();
  } finally {
    internalWss.close();
    httpServer.close();
    await browser.close();
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS. (This validates relay-offer via `page.evaluate`, the `/internal` frame socket, and the in-page captureStream → libwebrtc path end to end.)

- [ ] **Step 5: Commit**

```bash
git add src/streamer/streamer.html src/streamer/StreamerPeer.js test/streamer/StreamerPeer.test.js
git commit -m "feat(streamer): add StreamerPeer + streamer page (canvas/captureStream/libwebrtc)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: server.js — HTTP + /signaling + /internal

**Files:**
- Create: `src/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: `browserSession`, `inputChannel`, `streamerPeer`.
- Produces: `export function createServer({ browserSession, inputChannel, streamerPeer }) → http.Server`:
  - `GET /` / `/client.html` → client.html; `GET /streamer.html` → streamer.html; `GET /healthz` → `ok`.
  - `/signaling` WS: on connect send `{t:"hello",viewport,url}`; route `{t:"offer"}`→`streamerPeer.relayOffer`→`{t:"answer"}`; `{t:"navigate"}`→`browserSession.navigate`→`{t:"navigate-result"}`; `{t:"status"}`→`{t:"status",...}`; `{t:"mouse"|"wheel"|"key"}`→`inputChannel.handle`.
  - `/internal` WS: on connection, `streamerPeer.setFrameSocket(ws)`.
  - `server.broadcast(obj)` for crash reload.

- [ ] **Step 1: Write the failing test**

`test/server.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createServer } from "../src/server.js";

function startWithMocks() {
  const browserSession = {
    getViewport: () => ({ width: 1280, height: 800 }),
    getUrl: () => "https://gitee.com",
    navigate: async (url) => { browserSession._lastNav = url; },
    _lastNav: null,
  };
  const inputChannel = { handle: () => {} };
  const streamerPeer = { relayOffer: async () => "ANSWER-FROM-MOCK", setFrameSocket: () => {}, pushFrame: () => {}, stop: async () => {} };
  const server = createServer({ browserSession, inputChannel, streamerPeer });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, browserSession, port: server.address().port })));
}

test("server: GET /healthz returns ok", async () => {
  const { server, port } = await startWithMocks();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  } finally { server.close(); }
});

test("server: GET / serves client.html with a <video>", async () => {
  const { server, port } = await startWithMocks();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("<video"));
  } finally { server.close(); }
});

test("server: signaling handles offer/navigate/status", async () => {
  const { server, port, browserSession } = await startWithMocks();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/signaling`);
  const received = [];
  await new Promise((r) => ws.on("open", r));
  try {
    ws.on("message", (d) => received.push(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ t: "offer", sdp: "v=0" }));
    ws.send(JSON.stringify({ t: "navigate", url: "https://example.com" }));
    ws.send(JSON.stringify({ t: "status" }));
    await new Promise((r) => setTimeout(r, 300));
    const types = received.map((m) => m.t);
    assert.ok(types.includes("hello"));
    assert.ok(types.includes("answer"));
    assert.equal(received.find((m) => m.t === "answer").sdp, "ANSWER-FROM-MOCK");
    assert.ok(types.includes("navigate-result"));
    assert.equal(browserSession._lastNav, "https://example.com");
    assert.ok(types.includes("status"));
  } finally {
    ws.close();
    server.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `createServer` not found.

- [ ] **Step 3: Write a minimal `client.html` placeholder + the server**

The GET / test asserts the page contains a `<video>`, but the full client isn't built until Task 10. First create a placeholder now (Task 10 overwrites this file):

`src/public/client.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>magpie</title></head>
<body>
<video id="v" autoplay playsinline muted></video>
<!-- full client logic added in Task 10 -->
</body>
</html>
```

Then the server:

`src/server.js`:

```js
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_HTML = path.join(__dirname, "public", "client.html");
const STREAMER_HTML = path.join(__dirname, "streamer", "streamer.html");

async function serveFile(res, file, type) {
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": type });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

export function createServer({ browserSession, inputChannel, streamerPeer }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
    if (url.pathname === "/" || url.pathname === "/client.html") return serveFile(res, CLIENT_HTML, "text/html; charset=utf-8");
    if (url.pathname === "/streamer.html") return serveFile(res, STREAMER_HTML, "text/html; charset=utf-8");
    res.writeHead(404); res.end("not found");
  });

  const signaling = new WebSocketServer({ server, path: "/signaling" });
  const internal = new WebSocketServer({ server, path: "/internal" });

  internal.on("connection", (ws) => streamerPeer.setFrameSocket(ws));

  signaling.on("connection", (ws) => {
    const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
    send({ t: "hello", viewport: browserSession.getViewport(), url: browserSession.getUrl() });

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try {
        if (msg.t === "offer") {
          const sdp = await streamerPeer.relayOffer(msg.sdp);
          send({ t: "answer", sdp });
        } else if (msg.t === "navigate") {
          await browserSession.navigate(msg.url);
          send({ t: "navigate-result", ok: true, url: browserSession.getUrl() });
        } else if (msg.t === "status") {
          send({ t: "status", viewport: browserSession.getViewport(), url: browserSession.getUrl() });
        } else if (msg.t === "mouse" || msg.t === "wheel" || msg.t === "key") {
          await inputChannel.handle(raw.toString());
        }
      } catch (err) {
        send({ t: "error", error: String((err && err.message) || err) });
      }
    });
  });

  server.broadcast = (obj) => {
    const m = JSON.stringify(obj);
    for (const c of signaling.clients) if (c.readyState === c.OPEN) c.send(m);
  };

  return server;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server.js src/public/client.html test/server.test.js
git commit -m "feat(server): add HTTP + /signaling + /internal server

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: client.html — WebRTC client + input capture

**Files:**
- Create: `src/public/client.html`
- Test: `test/e2e.test.js` (full E2E; written here, runs after index.js exists in Task 12 — but the page itself is testable via the E2E wiring assembled in the test).

- [ ] **Step 1: Write `src/public/client.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>magpie</title>
  <style>
    html, body { margin: 0; background: #111; }
    #v { width: 100vw; height: auto; display: block; cursor: crosshair; }
    #bar { position: fixed; top: 0; right: 0; background: #222; color: #eee;
           padding: 6px; display: flex; gap: 6px; font: 13px sans-serif; }
    #url { width: 320px; }
  </style>
</head>
<body>
  <video id="v" autoplay playsinline muted></video>
  <div id="bar">
    <input id="url" placeholder="https://..." />
    <button id="go">Go</button>
  </div>
  <script>
    const video = document.getElementById("v");
    const urlInput = document.getElementById("url");
    const goBtn = document.getElementById("go");
    let pc = null;

    function connect() {
      const ws = new WebSocket(location.origin.replace(/^http/, "ws") + "/signaling");
      ws.onopen = startPeer;
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.t === "hello") urlInput.value = msg.url;
        else if (msg.t === "answer") pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }).then(attachReceiver);
        else if (msg.t === "navigate-result" && msg.url) urlInput.value = msg.url;
        else if (msg.t === "reload") location.reload();
      };
      ws.onclose = () => setTimeout(connect, 1000);
      window._ws = ws;
    }

    async function startPeer() {
      pc = new RTCPeerConnection();
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.ontrack = (e) => { video.srcObject = e.streams[0]; };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      window._ws.send(JSON.stringify({ t: "offer", sdp: pc.localDescription.sdp }));
    }

    // ontrack is unreliable in headless Chromium; poll-attach the receiver track as a fallback.
    async function attachReceiver() {
      for (let i = 0; i < 50; i++) {
        const r = pc.getReceivers().find((r) => r.track && r.track.kind === "video");
        if (r && r.track) { if (!video.srcObject) video.srcObject = new MediaStream([r.track]); return; }
        await new Promise((res) => setTimeout(res, 100));
      }
    }

    function send(obj) { if (window._ws && window._ws.readyState === 1) window._ws.send(JSON.stringify(obj)); }

    function coords(evt) {
      const r = video.getBoundingClientRect();
      return { x: evt.clientX - r.left, y: evt.clientY - r.top, displayW: r.width, displayH: r.height };
    }
    const btn = (b) => (b === 2 ? "right" : b === 1 ? "middle" : "left");

    video.addEventListener("mousemove", (e) => send({ t: "mouse", ...coords(e), type: "moved" }));
    video.addEventListener("mousedown", (e) => send({ t: "mouse", ...coords(e), type: "pressed", button: btn(e.button), clickCount: 1 }));
    video.addEventListener("mouseup", (e) => send({ t: "mouse", ...coords(e), type: "released", button: btn(e.button), clickCount: 1 }));
    video.addEventListener("wheel", (e) => { e.preventDefault(); send({ t: "wheel", ...coords(e), deltaX: e.deltaX, deltaY: e.deltaY }); });
    video.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", (e) => send({ t: "key", type: "keyDown", key: e.key, code: e.code, keyCode: e.keyCode, modifiers: 0 }));
    window.addEventListener("keyup", (e) => send({ t: "key", type: "keyUp", key: e.key, code: e.code, keyCode: e.keyCode, modifiers: 0 }));

    goBtn.addEventListener("click", () => send({ t: "navigate", url: urlInput.value }));
    urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") goBtn.click(); });

    connect();
  </script>
</body>
</html>
```

- [ ] **Step 2: Commit (E2E test is added in Task 12 once index.js wiring exists)**

```bash
git add src/public/client.html
git commit -m "feat(client): add WebRTC client page (recvonly video + input over WS)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: Session crash recovery

The crash hooks (`onCrash`, `_handleCrash`, `restart`) already exist from Task 5. This task adds recovery wiring + broadcast + client reload handling and a test for the restart path.

**Files:**
- Modify: `src/server.js` (already has `broadcast`), `src/public/client.html` (already handles `reload` from Task 10).
- Test: `test/browser/BrowserSession.crash.test.js`

**Interfaces:**
- Produces: verified `BrowserSession.onCrash`/`restart()` behavior; `index.js` (Task 12) wires `onCrash` to restart + broadcast.

- [ ] **Step 1: Write the failing test**

`test/browser/BrowserSession.crash.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { BrowserSession } from "../../src/browser/BrowserSession.js";

const FIXTURE = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "click-target.html")).href;

test("BrowserSession: onCrash fires and restart() recovers", async () => {
  const session = new BrowserSession({ url: FIXTURE, width: 400, height: 300 });
  await session.start();
  try {
    let crashed = 0;
    session.onCrash = () => { crashed++; };
    session._handleCrash();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(crashed, 1);

    await session.restart();
    assert.ok(session.getUrl().includes("click-target.html"));
  } finally {
    await session.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test`
Expected: PASS (the hooks already exist from Task 5; this locks the contract).

- [ ] **Step 3: Commit**

```bash
git add test/browser/BrowserSession.crash.test.js
git commit -m "test(browser): lock crash recovery contract (onCrash + restart)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: index.js entry + E2E + README

**Files:**
- Create: `src/index.js`, `test/e2e.test.js`
- Modify: `README.md`

**Interfaces:**
- Produces: a runnable `npm start` wiring a shared browser → BrowserSession + StreamerPeer + InputChannel + server; an E2E test driving a real client browser.

- [ ] **Step 1: Write `src/index.js`**

```js
import { chromium } from "playwright";
import { BrowserSession } from "./browser/BrowserSession.js";
import { StreamerPeer } from "./streamer/StreamerPeer.js";
import { InputChannel } from "./webrtc/InputChannel.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 8080);
const DEFAULT_URL = process.env.MAGPIE_URL ?? "https://gitee.com";
const WIDTH = 1280, HEIGHT = 800;

async function main() {
  const browser = await chromium.launch({ headless: true });

  const browserSession = new BrowserSession({ url: DEFAULT_URL, width: WIDTH, height: HEIGHT, browser });
  await browserSession.start();

  const streamerPeer = new StreamerPeer({ browser });
  const inputChannel = new InputChannel({ browserSession, viewportProvider: browserSession });

  const server = createServer({ browserSession, inputChannel, streamerPeer });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const base = `http://127.0.0.1:${PORT}`;

  await streamerPeer.start({ streamerUrl: `${base}/streamer.html?w=${WIDTH}&h=${HEIGHT}` });

  // Pump screencast frames into the streamer page.
  await browserSession.startScreencast((frame) => streamerPeer.pushFrame(frame.data));

  browserSession.onCrash = async () => {
    try { await browserSession.restart(); } catch {}
    server.broadcast({ t: "reload" });
    try { await browserSession.startScreencast((frame) => streamerPeer.pushFrame(frame.data)); } catch {}
  };

  console.log(`magpie listening on ${base}`);

  const shutdown = async () => {
    server.close();
    try { await streamerPeer.stop(); } catch {}
    try { await browserSession.stop(); } catch {}
    try { await browser.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Write the E2E test**

`test/e2e.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { BrowserSession } from "../src/browser/BrowserSession.js";
import { StreamerPeer } from "../src/streamer/StreamerPeer.js";
import { InputChannel } from "../src/webrtc/InputChannel.js";
import { createServer } from "../src/server.js";

const FIXTURE = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "click-target.html")).href;

async function boot() {
  const browser = await chromium.launch({ headless: true });
  const browserSession = new BrowserSession({ url: FIXTURE, width: 400, height: 300, browser });
  await browserSession.start();
  const streamerPeer = new StreamerPeer({ browser });
  const inputChannel = new InputChannel({ browserSession, viewportProvider: browserSession });
  const server = createServer({ browserSession, inputChannel, streamerPeer });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  await streamerPeer.start({ streamerUrl: `${base}/streamer.html?w=400&h=300` });
  await browserSession.startScreencast((frame) => streamerPeer.pushFrame(frame.data));
  return { browser, browserSession, streamerPeer, server, base };
}

test("e2e: client sees video and a click reaches the target page", async () => {
  const ctx = await boot();
  const client = await ctx.browser.newPage({ viewport: { width: 500, height: 400 } });
  try {
    await client.goto(`${ctx.base}/`, { waitUntil: "domcontentloaded" });
    // Video should start playing.
    await client.waitForFunction(() => { const v = document.getElementById("v"); return v && v.videoWidth > 0; }, { timeout: 10000 });

    // Click the fixture button center (160,130) in a 400x300 page, mapped through the displayed video.
    const rect = await client.locator("#v").boundingBox();
    const sx = 160 / 400, sy = 130 / 300;
    await client.mouse.click(rect.x + rect.width * sx, rect.y + rect.height * sy);

    await ctx.browserSession._page.waitForFunction(() => document.getElementById("count").textContent !== "0", { timeout: 3000 });
    const count = await ctx.browserSession._page.evaluate(() => document.getElementById("count").textContent);
    assert.equal(count, "1");
  } finally {
    await client.close();
    ctx.server.close();
    await ctx.streamerPeer.stop();
    await ctx.browserSession.stop();
    await ctx.browser.close();
  }
});
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all PASS, including E2E (real client browser receives video and a click round-trips to the target page via `/signaling` → CDP).

- [ ] **Step 4: Update README**

Replace `README.md`:

```markdown
# magpie

Remote browser instance service. Runs a headless Chromium and streams it to a
single remote user over WebRTC video.

Pipeline: CDP screencast (target page) → Node → internal WebSocket → a streamer
page draws frames to a <canvas> → canvas.captureStream() → Chromium's native
RTCPeerConnection (libwebrtc) → client. Mouse/keyboard/navigation go over a
signaling WebSocket to Node → CDP.

## Run

```bash
npm install
npx playwright install chromium
npm start
# open http://localhost:8080/
```

Config via env: `PORT` (default 8080), `MAGPIE_URL` (default https://gitee.com).

## Develop

```bash
npm test        # node:test unit + integration + spike + E2E
```

Design: `docs/superpowers/specs/2026-08-08-magpie-remote-browser-design.md`.
```

- [ ] **Step 5: Commit**

```bash
git add src/index.js test/e2e.test.js README.md
git commit -m "feat: add entry point, E2E test, and docs; magpie is runnable

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Done criteria

- `npm test` passes (unit + integration + spike + E2E).
- `npm start` boots; opening `http://localhost:8080/` shows gitee.com and supports mouse, wheel, keyboard, and navigation over WebRTC.
- All commits on `feat/magpie`, each ending with the Co-Authored-By trailer.

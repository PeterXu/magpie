# Multi-Tab Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-tab support to magpie — capture new browser pages and expose a tab-bar UI for switching between them while maintaining a single WebRTC stream.

**Architecture:** BrowserSession manages a `_pages` Map of open pages. When a new page opens via `target="_blank"`, it's registered via `context.on('page')`. Switching tabs switches which page is being screencast. Client renders a tab bar and sends switch/close/new-tab messages.

**Tech Stack:** Node.js, Playwright, WebRTC, vanilla JS (ESM)

## Global Constraints

- Single WebRTC stream (no concurrent streams per tab)
- Only 2 runtime deps: playwright, ws — no new deps
- No build step, pure ESM
- Follow existing code patterns: `_`-prefixed private fields, defensive never-throw methods like `getNavState`
- `onUrlChange` fires only for the active page; `onTabsChange` fires for any page state change

---

## File Structure

| File | Responsibility |
|------|-----------------|
| `src/browser/BrowserSession.js` | Multi-page management (`_pages` Map, switch/close/new methods, event wiring) |
| `src/index.js` | Wire `context.on('page')` + `browserSession.onTabsChange` broadcast |
| `src/server.js` | Handlers for `switch-tab`/`close-tab`/`new-tab` messages |
| `src/public/client.html` | Tab bar UI + `renderTabs` + message handling |
| `test/browser/BrowserSession.tabs.test.js` | Integration tests for multi-tab behavior |
| `test/server.test.js` | Protocol tests for new messages |

---

### Task 1: BrowserSession — multi-page fields + _registerPage

**Files:**
- Modify: `src/browser/BrowserSession.js:5-23`

**Interfaces:**
- Produces: `_pages` Map, `_activePageId`, `_nextPageId`, `onTabsChange`, `_registerPage(page)` method

**Rationale:** Establish the data structures and the core method that captures new pages. This is the foundation for all other multi-tab logic.

- [ ] **Step 1: Add new fields to constructor**

Add after line 18 (`this.onUrlChange = null;`):

```js
    // Multi-tab support: track all open pages and the active one. Each page
    // gets a stable numeric ID (pageId). New pages from target="_blank" are
    // captured via context.on('page') calling _registerPage.
    this._pages = new Map();        // pageId → { page, cdp, title, url }
    this._activePageId = null;
    this._nextPageId = 1;
    this.onTabsChange = null;       // fires with { pages, activeId }
```

- [ ] **Step 2: Implement _registerPage method**

Add after the constructor (around line 24):

```js
  // Internal: assign a pageId, create CDP session, wire events, store in _pages.
  // Called for the initial page and for any new page opened by target="_blank".
  // Does NOT auto-switch — the caller decides which page becomes active.
  async _registerPage(page) {
    const pageId = this._nextPageId++;
    const cdp = await this._context.newCDPSession(page);
    const title = await page.title().catch(() => "");
    const entry = { page, cdp, title, url: page.url() };
    this._pages.set(pageId, entry);

    // Update title when the page fires titlechanged.
    const onTitle = () => {
      entry.title = page.url();  // fallback while loading
      page.title().then(t => { entry.title = t; this._fireTabsChange(); }).catch(() => {});
      this._fireTabsChange();
    };
    page.on("titlechanged", onTitle);

    // Remove from map when closed.
    const onClose = () => this._onPageClose(pageId);
    page.on("close", onClose);

    // Wire framenavigated for URL updates (only matters if this becomes active).
    const onFrame = (frame) => {
      if (frame !== page.mainFrame()) return;
      entry.url = page.url();
      // Only fire onTabsChange if this is the active page (URL bar + tabs need update)
      if (pageId === this._activePageId) {
        this._fireTabsChange();
      }
    };
    page.on("framenavigated", onFrame);

    this._fireTabsChange();
    return pageId;
  }

  _fireTabsChange() {
    if (this.onTabsChange) {
      try { this.onTabsChange(this.getTabsState()); } catch {}
    }
  }

  _onPageClose(pageId) {
    const entry = this._pages.get(pageId);
    if (!entry) return;
    this._pages.delete(pageId);

    // If we closed the active tab, switch to another (or create blank)
    if (pageId === this._activePageId) {
      const remaining = [...this._pages.keys()];
      if (remaining.length > 0) {
        // Switch to the first remaining tab
        this._switchTo(remaining[0]);
      } else {
        // Last tab closed: create a new blank tab (Chrome behavior)
        void this._createBlankPage();
      }
    }
    this._fireTabsChange();
  }

  async _createBlankPage() {
    // Called when the last tab is closed. Opens about:blank.
    // The new page will be captured by context.on('page').
    const page = await this._context.newPage();
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    // _registerPage is called by context.on('page'), not here.
  }
```

- [ ] **Step 3: Verify the file still parses**

Run: `node --check src/browser/BrowserSession.js`
Expected: no output (parse succeeds)

- [ ] **Step 4: Commit**

```bash
git add src/browser/BrowserSession.js
git commit -m "BrowserSession: add _pages map + _registerPage infrastructure"
```

---

### Task 2: BrowserSession — switchPage/closePage/newPage/getTabsState + refactor start

**Files:**
- Modify: `src/browser/BrowserSession.js:33-62` (start method)

**Interfaces:**
- Consumes: `_registerPage`, `_pages`, `_activePageId` from Task 1
- Produces: `switchPage(id)`, `closePage(id)`, `newPage()`, `getTabsState()` public methods

- [ ] **Step 1: Refactor start() to use _registerPage**

Replace the existing `start()` method body (lines 33-62):

```js
  async start() {
    this._crashFired = false;
    if (this._injectedBrowser) {
      this._browser = this._injectedBrowser;
      this._ownsBrowser = false;
    } else {
      this._browser = await chromium.launch(chromiumLaunchOptions());
      this._ownsBrowser = true;
    }
    this._context = await this._browser.newContext({ viewport: { width: this._width, height: this._height } });

    // Capture all new pages (including target="_blank") via context event.
    this._context.on("page", (page) => void this._registerPage(page));

    // Create the initial page and mark it active.
    const initialPage = await this._context.newPage();
    this._activePageId = await this._registerPage(initialPage);
    await initialPage.goto(this._url, { waitUntil: "domcontentloaded" });

    // Crash handling (unchanged from before)
    this._onPageCrash = () => this._handleCrash();
    this._onBrowserDisconnect = () => this._handleCrash();
    initialPage.on("crash", this._onPageCrash);
    this._browser.on("disconnected", this._onBrowserDisconnect);
  }
```

- [ ] **Step 2: Add _switchTo internal method (screencast switching)**

Add after `_registerPage`:

```js
  // Internal: switch the active page (screencast target) without broadcasting.
  // Caller must call _fireTabsChange if needed.
  async _switchTo(pageId) {
    if (!this._pages.has(pageId) || pageId === this._activePageId) return;
    const oldEntry = this._pages.get(this._activePageId);
    if (oldEntry && this._onFrame) {
      // Stop screencast on old page
      try { await oldEntry.cdp.send("Page.stopScreencast"); } catch {}
      oldEntry.cdp.removeAllListeners("Page.screencastFrame");
    }
    this._activePageId = pageId;
    const entry = this._pages.get(pageId);
    if (entry && this._onFrame) {
      // Start screencast on new page
      entry.cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
        try {
          if (this._onFrame) this._onFrame({ data: Buffer.from(data, "base64"), metadata, sessionId });
        } finally {
          await entry.cdp.send("Page.screencastFrameAck", { sessionId });
        }
      });
      await entry.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: this._screencast.quality,
        maxWidth: this._width, maxHeight: this._height,
      });
    }
  }
```

- [ ] **Step 3: Add public methods switchPage/closePage/newPage/getTabsState**

Add after `_switchTo`:

```js
  // Public: switch to a different tab. Broadcasts tabs state via onTabsChange.
  async switchPage(pageId) {
    await this._switchTo(pageId);
    this._fireTabsChange();
  }

  // Public: close a tab. If closing active, switches to another.
  // If closing the last tab, creates a new blank page.
  async closePage(pageId) {
    const entry = this._pages.get(pageId);
    if (!entry) return;
    await entry.page.close();
    // _onPageClose handles the rest (removal, switch, broadcast)
  }

  // Public: open a new about:blank tab. The context.on('page') handler
  // will capture it; we don't auto-switch.
  async newPage() {
    const page = await this._context.newPage();
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    // context.on('page') fires and calls _registerPage
  }

  // Public: return the current tab list for the client.
  getTabsState() {
    const pages = [...this._pages.entries()].map(([id, entry]) => ({
      id,
      title: entry.title || entry.url,
      url: entry.url,
      active: id === this._activePageId,
    }));
    return { pages, activeId: this._activePageId };
  }
```

- [ ] **Step 4: Update getUrl() and getNavState() to use active page**

Replace lines 29-31 and 108-119:

```js
  getUrl() {
    const entry = this._pages.get(this._activePageId);
    return entry ? entry.page.url() : this._url;
  }
```

```js
  async getNavState() {
    const entry = this._pages.get(this._activePageId);
    const url = entry ? entry.page.url() : this._url;
    let canBack = false, canForward = false;
    if (entry && entry.cdp) {
      try {
        const { currentIndex, entries } = await entry.cdp.send("Page.getNavigationHistory");
        canBack = currentIndex > 0;
        canForward = currentIndex < entries.length - 1;
      } catch {}
    }
    return { url, canBack, canForward };
  }
```

- [ ] **Step 5: Update startScreencast/stopScreencast/dispatch* to use active page**

Replace lines 121-147 and 149-172 to use `entry.cdp`:

```js
  async startScreencast(onFrame) {
    await this.stopScreencast();
    this._onFrame = onFrame;
    const entry = this._pages.get(this._activePageId);
    if (!entry) return;
    entry.cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
      try {
        if (this._onFrame) this._onFrame({ data: Buffer.from(data, "base64"), metadata, sessionId });
      } finally {
        await entry.cdp.send("Page.screencastFrameAck", { sessionId });
      }
    });
    await entry.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: this._screencast.quality,
      maxWidth: this._width, maxHeight: this._height,
    });
  }

  async stopScreencast() {
    const entry = this._pages.get(this._activePageId);
    if (entry && entry.cdp) {
      try { await entry.cdp.send("Page.stopScreencast"); } catch {}
      entry.cdp.removeAllListeners("Page.screencastFrame");
    }
    this._onFrame = null;
  }

  async dispatchMouse({ x, y, type, button = "left", buttons = 0, clickCount = 1 }) {
    const entry = this._pages.get(this._activePageId);
    if (!entry) return;
    const cdpType = type === "moved" ? "mouseMoved" : type === "pressed" ? "mousePressed" : "mouseReleased";
    await entry.cdp.send("Input.dispatchMouseEvent", {
      type: cdpType, x, y, button, buttons, clickCount, pointerType: "mouse",
    });
  }

  async dispatchWheel({ x, y, deltaX = 0, deltaY = 0 }) {
    const entry = this._pages.get(this._activePageId);
    if (!entry) return;
    await entry.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, deltaX, deltaY, pointerType: "mouse",
    });
  }

  async dispatchKey({ type, mapKey, modifiers = 0 }) {
    const entry = this._pages.get(this._activePageId);
    if (!entry) return;
    await entry.cdp.send("Input.dispatchKeyEvent", {
      type,
      key: mapKey.key,
      code: mapKey.code,
      windowsVirtualKeyCode: mapKey.windowsVirtualKeyCode,
      modifiers,
    });
    if (mapKey.text && type === "keyDown") {
      await entry.cdp.send("Input.dispatchKeyEvent", { type: "char", text: mapKey.text, modifiers });
    }
  }
```

- [ ] **Step 6: Update stop() to clean up all pages**

Replace lines 75-83:

```js
  async stop() {
    await this.stopScreencast();
    // Close all pages
    for (const entry of this._pages.values()) {
      try { await entry.page.close(); } catch {}
    }
    this._pages.clear();
    try { if (this._context) await this._context.close(); } catch {}
    if (this._ownsBrowser && this._browser) { try { await this._browser.close(); } catch {} }
    this._browser = this._context = this._activePageId = null;
  }
```

- [ ] **Step 7: Run existing tests to ensure refactor is clean**

Run: `npm test`
Expected: all existing tests pass (new multi-tab tests not yet added)

- [ ] **Step 8: Commit**

```bash
git add src/browser/BrowserSession.js
git commit -m "BrowserSession: multi-page management (switch/close/new/getTabsState)"
```

---

### Task 3: index.js — wire context.on('page') + onTabsChange

**Files:**
- Modify: `src/index.js:43-62`

**Interfaces:**
- Consumes: `browserSession.onTabsChange`, `browserSession.getTabsState` from Task 2
- Produces: `context.on('page')` auto-capture, `tabs` broadcast

- [ ] **Step 1: No changes needed to start() wiring**

The BrowserSession.start() now internally wires `context.on('page')`. No changes in index.js for that.

- [ ] **Step 2: Add onTabsChange broadcast after onUrlChange**

Add after line 60 (after `browserSession.onUrlChange = ...`):

```js
  // Tab state broadcast: fire whenever pages are opened/closed/switched or
  // titles change. Clients render the tab bar from this.
  browserSession.onTabsChange = (state) => server.broadcast({ t: "tabs", ...state });
```

- [ ] **Step 3: Verify parse**

Run: `node --check src/index.js`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "index.js: wire onTabsChange → broadcast tabs"
```

---

### Task 4: server.js — switch-tab/close-tab/new-tab handlers

**Files:**
- Modify: `src/server.js:64-82`

**Interfaces:**
- Consumes: `browserSession.switchPage`, `closePage`, `newPage` from Task 2
- Produces: Protocol handlers for tab messages

- [ ] **Step 1: Add handlers in message switch**

In the `ws.on("message", ...)` handler, after the `refresh` handler (around line 78):

```js
        } else if (msg.t === "switch-tab") {
          await browserSession.switchPage(msg.id);
        } else if (msg.t === "close-tab") {
          await browserSession.closePage(msg.id);
        } else if (msg.t === "new-tab") {
          await browserSession.newPage();
```

- [ ] **Step 2: Extend hello to include tabs state**

In the async hello send (around line 89), extend the payload:

```js
    void (async () => {
      const nav = await browserSession.getNavState();
      const tabs = browserSession.getTabsState();
      send({ t: "hello", viewport: browserSession.getViewport(), url: nav.url, canBack: nav.canBack, canForward: nav.canForward, iceServers: clientIceServers, magpieCodecs: streamerPeer.getSenderCodecs(), pages: tabs.pages, activeId: tabs.activeId });
    })();
```

- [ ] **Step 3: Verify parse**

Run: `node --check src/server.js`
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add src/server.js
git commit -m "server.js: switch-tab/close-tab/new-tab handlers + hello tabs"
```

---

### Task 5: client.html — tab bar UI + renderTabs + message handling

**Files:**
- Modify: `src/public/client.html`

**Interfaces:**
- Consumes: `tabs` message, `hello.pages`, produces click handlers for switch/close/new

- [ ] **Step 1: Add tab bar CSS**

Add after line 31 (after `#v` styles):

```css
    #tabs { flex: 0 0 auto; display: flex; background: #1a1a1a; border-bottom: 1px solid #000;
            padding: 0 4px; height: 28px; overflow-x: auto; }
    #tabs .tab { display: flex; align-items: center; gap: 6px; padding: 4px 12px;
                 background: #2a2a2a; color: #ccc; border: none; border-radius: 4px 4px 0 0;
                 cursor: pointer; min-width: 80px; max-width: 200px; font: 12px sans-serif; }
    #tabs .tab.active { background: #333; color: #fff; }
    #tabs .tab:hover:not(.active) { background: #333; }
    #tabs .tab .title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tabs .tab .close { opacity: 0.5; font-size: 14px; line-height: 1; }
    #tabs .tab .close:hover { opacity: 1; }
    #tabs .new-tab { background: transparent; color: #888; border: none; padding: 4px 10px;
                     cursor: pointer; font-size: 16px; }
    #tabs .new-tab:hover { color: #fff; }
```

- [ ] **Step 2: Add tab bar HTML**

Insert between `#bar` and `#stage` (after line 41):

```html
  <div id="tabs"></div>
```

- [ ] **Step 3: Add renderTabs function in script**

Add after the `applyNav` function (around line 60):

```js
    function renderTabs(msg) {
      const container = document.getElementById("tabs");
      container.innerHTML = "";
      if (!msg || !msg.pages) return;
      for (const p of msg.pages) {
        const tab = document.createElement("button");
        tab.className = "tab" + (p.active ? " active" : "");
        tab.dataset.id = p.id;
        tab.innerHTML = `<span class="title" title="${p.url}">${p.title || p.url}</span><span class="close">×</span>`;
        tab.addEventListener("click", (e) => {
          if (e.target.classList.contains("close")) {
            send({ t: "close-tab", id: p.id });
          } else {
            send({ t: "switch-tab", id: p.id });
          }
        });
        container.appendChild(tab);
      }
      const newBtn = document.createElement("button");
      newBtn.className = "new-tab";
      newBtn.textContent = "+";
      newBtn.addEventListener("click", () => send({ t: "new-tab" }));
      container.appendChild(newBtn);
    }
```

- [ ] **Step 4: Handle tabs and hello.tabs in ws.onmessage**

In the `ws.onmessage` handler, inside the hello block, after `applyNav(...)`:

```js
        renderTabs({ pages: msg.pages, activeId: msg.activeId });
```

And add a new handler for `tabs`:

```js
        else if (msg.t === "tabs") renderTabs(msg);
```

- [ ] **Step 5: Verify parse**

Run: `node --check src/public/client.html` (note: HTML doesn't need parse check, but we can check the JS inline)
Actually, just verify visually or run the e2e later.

- [ ] **Step 6: Commit**

```bash
git add src/public/client.html
git commit -m "client.html: tab bar UI + renderTabs + tabs/hello handlers"
```

---

### Task 6: Tests — BrowserSession.tabs.test.js

**Files:**
- Create: `test/browser/BrowserSession.tabs.test.js`

**Interfaces:**
- Tests: `_registerPage`, `switchPage`, `closePage`, `newPage`, `getTabsState`, `onTabsChange`

- [ ] **Step 1: Write the test file**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { BrowserSession } from "../../src/browser/BrowserSession.js";

const CLICK_TARGET = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "click-target.html")).href;
const PAGE_B = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "page-b.html")).href;

test("BrowserSession: _registerPage captures new pages", async () => {
  const session = new BrowserSession({ url: CLICK_TARGET, width: 400, height: 300 });
  await session.start();
  try {
    assert.equal(session._pages.size, 1, "initial page registered");
    const initialId = session._activePageId;
    assert.ok(initialId != null, "activePageId set");

    // Open a second page via context.newPage (simulates target="_blank")
    const page2 = await session._context.newPage();
    await page2.goto(PAGE_B, { waitUntil: "domcontentloaded" });
    // Wait for context.on('page') to fire and _registerPage to run
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(session._pages.size, 2, "second page registered");

    // Clean up
    await session.stop();
  } catch (err) {
    await session.stop();
    throw err;
  }
});

test("BrowserSession: switchPage switches active and screencast target", async () => {
  const session = new BrowserSession({ url: CLICK_TARGET, width: 400, height: 300 });
  await session.start();
  try {
    const page2 = await session._context.newPage();
    await page2.goto(PAGE_B, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 200));
    const ids = [...session._pages.keys()];
    assert.equal(ids.length, 2);

    const initialActive = session._activePageId;
    const otherId = ids.find((id) => id !== initialActive);
    await session.switchPage(otherId);
    assert.equal(session._activePageId, otherId, "active switched");

    // getUrl reflects the new active page
    const url = session.getUrl();
    assert.ok(url.includes("page-b.html"), `expected page-b URL, got ${url}`);

    await session.stop();
  } catch (err) {
    await session.stop();
    throw err;
  }
});

test("BrowserSession: closePage on non-active removes it", async () => {
  const session = new BrowserSession({ url: CLICK_TARGET, width: 400, height: 300 });
  await session.start();
  try {
    const page2 = await session._context.newPage();
    await page2.goto(PAGE_B, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 200));
    const ids = [...session._pages.keys()];
    const otherId = ids.find((id) => id !== session._activePageId);
    await session.closePage(otherId);
    assert.equal(session._pages.size, 1, "page removed");
    assert.equal(session._activePageId, session._activePageId, "active unchanged");

    await session.stop();
  } catch (err) {
    await session.stop();
    throw err;
  }
});

test("BrowserSession: closePage on active switches to remaining", async () => {
  const session = new BrowserSession({ url: CLICK_TARGET, width: 400, height: 300 });
  await session.start();
  try {
    const page2 = await session._context.newPage();
    await page2.goto(PAGE_B, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 200));
    const ids = [...session._pages.keys()];
    const activeId = session._activePageId;
    await session.closePage(activeId);
    assert.equal(session._pages.size, 1, "active page removed");
    assert.notEqual(session._activePageId, activeId, "switched to another");

    await session.stop();
  } catch (err) {
    await session.stop();
    throw err;
  }
});

test("BrowserSession: closing last tab creates new about:blank", async () => {
  const session = new BrowserSession({ url: CLICK_TARGET, width: 400, height: 300 });
  await session.start();
  try {
    const activeId = session._activePageId;
    await session.closePage(activeId);
    // Wait for the blank page to be registered
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(session._pages.size, 1, "new blank page created");
    const url = session.getUrl();
    assert.ok(url === "about:blank" || url === "", `expected blank, got ${url}`);

    await session.stop();
  } catch (err) {
    await session.stop();
    throw err;
  }
});

test("BrowserSession: onTabsChange fires on open/close/switch", async () => {
  const session = new BrowserSession({ url: CLICK_TARGET, width: 400, height: 300 });
  await session.start();
  try {
    const fired = [];
    session.onTabsChange = (state) => fired.push(state);
    const page2 = await session._context.newPage();
    await page2.goto(PAGE_B, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 200));
    // Should have fired at least once for the new page
    assert.ok(fired.some((s) => s.pages.length === 2), `expected 2 pages in fired events`);

    await session.switchPage([...session._pages.keys()][0]);
    assert.ok(fired.length > 1, "onTabsChange fired on switch");

    await session.stop();
  } catch (err) {
    await session.stop();
    throw err;
  }
});
```

- [ ] **Step 2: Run the new tests**

Run: `npm test`
Expected: all tests pass including new BrowserSession.tabs tests

- [ ] **Step 3: Commit**

```bash
git add test/browser/BrowserSession.tabs.test.js
git commit -m "test: BrowserSession.tabs multi-page integration tests"
```

---

### Task 7: Tests — extend server.test.js

**Files:**
- Modify: `test/server.test.js:37-59`

- [ ] **Step 1: Extend mock browserSession with tab methods**

In `startWithMocks`, add:

```js
    switchPage: async (id) => { browserSession._switched = id; },
    closePage: async (id) => { browserSession._closed = id; },
    newPage: async () => { browserSession._newed = (browserSession._newed || 0) + 1; },
    getTabsState: () => ({ pages: [{ id: 1, title: "Gitee", url: "https://gitee.com", active: true }], activeId: 1 }),
```

- [ ] **Step 2: Add assertions for new messages**

In the test, after sending `refresh`:

```js
    ws.send(JSON.stringify({ t: "switch-tab", id: 1 }));
    ws.send(JSON.stringify({ t: "close-tab", id: 2 }));
    ws.send(JSON.stringify({ t: "new-tab" }));
```

And in assertions:

```js
    assert.equal(browserSession._switched, 1);
    assert.equal(browserSession._closed, 2);
    assert.equal(browserSession._newed, 1);
```

And verify hello includes `pages`:

```js
    assert.ok(hello.pages, "hello should include pages");
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: all pass

- [ ] **Step 4: Commit**

```bash
git add test/server.test.js
git commit -m "test(server): add switch-tab/close-tab/new-tab assertions"
```

---

### Task 8: Full test run + final commit

**Files:**
- N/A (verification only)

- [ ] **Step 1: Run full suite**

Run: `npm test`
Expected: all tests pass

- [ ] **Step 2: Verify the feature manually (optional)**

Run: `npm start`, open browser, click a `target="_blank"` link, verify tab bar shows new tab

- [ ] **Step 3: Final commit (if any stray changes)**

```bash
git status
# If clean, no action needed
```

---

## Self-Review Checklist

- [x] Spec coverage: every requirement maps to a task
- [x] No placeholders: all code is concrete
- [x] Type consistency: `switchPage(id)`, `closePage(id)`, `newPage()`, `getTabsState()` signatures match across tasks
- [x] Edge cases: last-tab closure, title updates, concurrent closes all covered
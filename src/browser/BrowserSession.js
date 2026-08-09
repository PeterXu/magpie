import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./launch-options.js";

export class BrowserSession {
  constructor({ url = "about:blank", width = 1280, height = 800, browser, screencast = { quality: 80 } } = {}) {
    this._url = url;
    this._width = width;
    this._height = height;
    this._screencast = screencast;
    this._injectedBrowser = browser ?? null;
    this._browser = null;
    this._ownsBrowser = false;
    this._context = null;
    this._onFrame = null;
    this.onCrash = null;
    this.onUrlChange = null;        // fires with {url,canBack,canForward} on main-frame navigation
    // Multi-tab support: track all open pages and the active one. Each page
    // gets a stable numeric ID (pageId). New pages from target="_blank" are
    // captured via context.on('page') calling _registerPage.
    this._pages = new Map();        // pageId → { page, cdp, title, url }
    this._activePageId = null;
    this._nextPageId = 1;
    this.onTabsChange = null;       // fires with { pages, activeId }
    this._crashFired = false;
    this._onPageCrash = null;
    this._onBrowserDisconnect = null;
    this._onFrameNavigated = null;
  }

  // Backward-compatible getters for tests and external code.
  // Return the active page/cdp, or null if none.
  get _page() {
    const entry = this._pages.get(this._activePageId);
    return entry ? entry.page : null;
  }

  get _cdp() {
    const entry = this._pages.get(this._activePageId);
    return entry ? entry.cdp : null;
  }

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

    // Crash handling for this page.
    const onCrash = () => {
      if (pageId === this._activePageId) this._handleCrash();
    };
    page.on("crash", onCrash);

    // Wire framenavigated for URL updates (only matters if this becomes active).
    const onFrame = (frame) => {
      if (frame !== page.mainFrame()) return;
      entry.url = page.url();
      // Only fire onTabsChange if this is the active page (URL bar + tabs need update)
      if (pageId === this._activePageId) {
        this._fireTabsChange();
        // Fire onUrlChange for URL bar sync (covers navigate, back/forward, reload, and passive navigations)
        if (this.onUrlChange) {
          void (async () => {
            const nav = await this.getNavState();
            try { this.onUrlChange(nav); } catch {}
          })();
        }
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

  // Internal: switch the active page (screencast target) without broadcasting.
  // Caller must call _fireTabsChange if needed.
  async _switchTo(pageId) {
    if (!this._pages.has(pageId) || pageId === this._activePageId) return;
    const oldEntry = this._pages.get(this._activePageId);
    if (oldEntry && oldEntry.cdp && this._onFrame) {
      // Stop screencast on old page (ignore errors if page already closed)
      try { await oldEntry.cdp.send("Page.stopScreencast"); } catch {}
      try { oldEntry.cdp.removeAllListeners("Page.screencastFrame"); } catch {}
    }
    this._activePageId = pageId;
    const entry = this._pages.get(pageId);
    if (entry && entry.cdp && this._onFrame) {
      // Start screencast on new page (ignore errors if page closing)
      try {
        entry.cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
          try {
            if (this._onFrame) this._onFrame({ data: Buffer.from(data, "base64"), metadata, sessionId });
          } finally {
            try { await entry.cdp.send("Page.screencastFrameAck", { sessionId }); } catch {}
          }
        });
        await entry.cdp.send("Page.startScreencast", {
          format: "jpeg",
          quality: this._screencast.quality,
          maxWidth: this._width, maxHeight: this._height,
        });
      } catch {}
    }
  }

  // Public: switch to a different tab. Broadcasts tabs state via onTabsChange.
  async switchPage(pageId) {
    await this._switchTo(pageId);
    this._fireTabsChange();
    // Broadcast URL change for the newly active tab
    if (this.onUrlChange) {
      const nav = await this.getNavState();
      try { this.onUrlChange(nav); } catch {}
    }
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

  _onPageClose(pageId) {
    const entry = this._pages.get(pageId);
    if (!entry) return;
    this._pages.delete(pageId);

    // If we closed the active tab, switch to another (or create blank)
    if (pageId === this._activePageId) {
      const remaining = [...this._pages.keys()];
      if (remaining.length > 0) {
        // Switch to the first remaining tab (async, errors ignored)
        this._switchTo(remaining[0]).catch(() => {});
      } else {
        // Last tab closed: create a new blank tab (Chrome behavior)
        this._createBlankPage().catch(() => {});
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

  getTabsState() {
    const pages = [...this._pages.entries()].map(([id, entry]) => ({
      id,
      title: entry.title || entry.url,
      url: entry.url,
      active: id === this._activePageId,
    }));
    return { pages, activeId: this._activePageId };
  }

  getViewport() {
    return { width: this._width, height: this._height };
  }

  getUrl() {
    const entry = this._pages.get(this._activePageId);
    return entry ? entry.page.url() : this._url;
  }

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
    // Returns the pageId so we can await registration for the initial page.
    let resolveInitialId;
    const initialIdPromise = new Promise(r => { resolveInitialId = r; });
    this._context.on("page", (page) => {
      this._registerPage(page).then(id => {
        // First page created becomes the active page
        if (resolveInitialId) {
          this._activePageId = id;
          resolveInitialId(id);
          resolveInitialId = null;  // Only for first page
        } else if (this._pages.size === 1 && !this._pages.has(this._activePageId)) {
          // Last tab closed, new blank page created - make it active
          this._activePageId = id;
        }
      });
    });

    // Create the initial page. The event handler above will register it.
    await this._context.newPage();
    await initialIdPromise;  // Wait for registration to complete
    await this._page.goto(this._url, { waitUntil: "domcontentloaded" });

    // Crash handling for browser disconnect (page crash handled in _registerPage)
    this._onBrowserDisconnect = () => this._handleCrash();
    this._browser.on("disconnected", this._onBrowserDisconnect);
  }

  _handleCrash() {
    if (this._crashFired) return;
    this._crashFired = true;
    if (this.onCrash) { try { this.onCrash(); } catch {} }
  }

  async restart() {
    await this.stop();
    await this.start();
  }

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

  async navigate(url) {
    // Normalize: add https:// if no protocol present (matches browser behavior)
    if (url && !/^[a-z]+:\/\//i.test(url) && !url.startsWith("about:")) {
      url = "https://" + url;
    }
    this._url = url;
    const entry = this._pages.get(this._activePageId);
    if (entry) await entry.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  // History navigation. Playwright resolves null (no throw) when there's nothing
  // to go back/forward to; the client disables the button then, but we stay
  // defensive. framenavigated broadcasts the new URL after these resolve.
  async goBack() {
    const entry = this._pages.get(this._activePageId);
    if (entry) await entry.page.goBack({ waitUntil: "domcontentloaded" });
  }

  async goForward() {
    const entry = this._pages.get(this._activePageId);
    if (entry) await entry.page.goForward({ waitUntil: "domcontentloaded" });
  }

  async reload() {
    const entry = this._pages.get(this._activePageId);
    if (entry) await entry.page.reload({ waitUntil: "domcontentloaded" });
  }

  // {url, canBack, canForward} for the client toolbar. Never throws: on any CDP
  // error returns all-false so the hello/broadcast path shows a conservative
  // (both disabled) state instead of failing.
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

  async startScreencast(onFrame) {
    await this.stopScreencast();
    this._onFrame = onFrame;
    const entry = this._pages.get(this._activePageId);
    if (!entry || !entry.cdp) return;
    entry.cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
      try {
        if (this._onFrame) this._onFrame({ data: Buffer.from(data, "base64"), metadata, sessionId });
      } finally {
        try { await entry.cdp.send("Page.screencastFrameAck", { sessionId }); } catch {}
      }
    });
    try {
      await entry.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: this._screencast.quality,
        maxWidth: this._width, maxHeight: this._height,
      });
    } catch {}
  }

  async stopScreencast() {
    const entry = this._pages.get(this._activePageId);
    if (entry && entry.cdp) {
      try { await entry.cdp.send("Page.stopScreencast"); } catch {}
      try { entry.cdp.removeAllListeners("Page.screencastFrame"); } catch {}
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
}

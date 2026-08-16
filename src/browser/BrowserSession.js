import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./launch-options.js";
import { BLANK_HTML } from "./blank-page.js";

export class BrowserSession {
  // userDataDir set (and no injected browser) -> persistent mode: Chromium
  // profile on disk via launchPersistentContext, login state survives restarts.
  constructor({ url = "about:blank", width = 1280, height = 800, browser, userDataDir = null, screencast = { quality: 80 } } = {}) {
    this._url = url;
    this._width = width;
    this._height = height;
    this._screencast = screencast;
    this._injectedBrowser = browser ?? null;
    this._userDataDir = userDataDir;
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
    this._resolveNewPageId = null;  // resolver for newPage() to wait for registration
    this._newPageInProgress = false; // lock to prevent concurrent newPage() calls
    this._crashFired = false;
    this._intentionalStop = false;
    this._onPageCrash = null;
    this._onBrowserDisconnect = null;
    this._onFrameNavigated = null;
    this.onClipboardChange = null;  // fires with {text} on remote clipboard read
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

      // Update title on navigation (more reliable than titlechanged event)
      let titleChanged = false;
      page.title().then(t => {
        if (t && t !== entry.title) {
          entry.title = t;
          titleChanged = true;
          // Only fire if not active (active page fires below anyway)
          if (pageId !== this._activePageId) {
            this._fireTabsChange();
          }
        }
      }).catch(() => {});

      // If this is the active page, fire navigation updates
      if (pageId === this._activePageId) {
        this._fireTabsChange();
        // Fire onUrlChange for URL bar sync
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
  // will capture it and auto-switch to the new tab.
  async newPage() {
    // Prevent concurrent calls (race condition protection)
    if (this._newPageInProgress) {
      return; // Ignore if already creating a new page
    }

    this._newPageInProgress = true;

    try {
      // Create a promise to wait for the new page registration
      let resolveNewId;
      const newIdPromise = new Promise(r => { resolveNewId = r; });

      // Set resolver that will be called when the page registers
      this._resolveNewPageId = resolveNewId;

      const page = await this._context.newPage();
      await page.setContent(BLANK_HTML, { waitUntil: "domcontentloaded" });

      // Wait for _registerPage to complete and resolve the promise
      const pageId = await newIdPromise;

      // Switch to the new tab
      await this.switchPage(pageId);
    } finally {
      this._newPageInProgress = false;
      this._resolveNewPageId = null; // Always clear resolver
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
        // Switch to the last remaining tab (most recent before this one)
        // and broadcast the URL change
        this.switchPage(remaining[remaining.length - 1]).catch(() => {});
      } else {
        // Last tab closed: create a new blank tab (Chrome behavior)
        this._createBlankPage().catch(() => {});
      }
    }
    this._fireTabsChange();
  }

  async _createBlankPage() {
    // Called when the last tab is closed. Opens a blank page with magpie watermark.
    // The new page will be captured by context.on('page').
    const page = await this._context.newPage();
    await page.setContent(BLANK_HTML, { waitUntil: "domcontentloaded" });
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

  getBrowser() {
    return this._browser;
  }

  // Public: the active page (e.g. the streamer page host). Null when stopped.
  getActivePage() {
    return this._page;
  }

  getUrl() {
    const entry = this._pages.get(this._activePageId);
    return entry ? entry.page.url() : this._url;
  }

  async start({ url } = {}) {
    if (url !== undefined) this._url = url;
    this._crashFired = false;
    this._intentionalStop = false;
    let initialPages = null;
    if (this._injectedBrowser) {
      this._browser = this._injectedBrowser;
      this._ownsBrowser = false;
    } else if (this._userDataDir) {
      // Persistent mode: the context IS the browser process. browser() is null
      // here — no new contexts can be derived (why StreamerPeer self-launches).
      // Same tick as launch: snapshot before any page event can interleave.
      this._context = await chromium.launchPersistentContext(this._userDataDir, {
        ...chromiumLaunchOptions(),
        viewport: { width: this._width, height: this._height },
      });
      initialPages = this._context.pages();
      this._ownsBrowser = false;
    } else {
      this._browser = await chromium.launch(chromiumLaunchOptions());
      this._ownsBrowser = true;
    }
    if (!this._context) {
      this._context = await this._browser.newContext({ viewport: { width: this._width, height: this._height } });
    }

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
        } else if (this._resolveNewPageId) {
          // User-initiated newPage() - resolve the promise and auto-switch
          this._resolveNewPageId(id);
          this._resolveNewPageId = null;
        } else {
          // Auto-switch to new tabs: target="_blank" links or other automatic openings
          // This matches browser behavior and provides better UX
          this.switchPage(id).catch(() => {});
        }
      });
    });

    // Persistent mode: the context may come up with restored pages already
    // present — they were created before the listener existed, so they never
    // fire context.on("page"). Register them directly (first becomes active).
    // Fresh mode: create the initial page, which the event handler registers.
    if (initialPages && initialPages.length > 0) {
      for (const page of initialPages) {
        const id = await this._registerPage(page);
        if (resolveInitialId) {
          this._activePageId = id;
          resolveInitialId(id);
          resolveInitialId = null;
        }
      }
      // Restored pages keep their URLs — do NOT navigate them. That would wipe
      // the restored session's tabs. Navigating away is a user action.
    } else {
      await this._context.newPage();
      await initialIdPromise;  // Wait for registration to complete
    }
    // Navigate the initial page to the configured URL — unless it's a restored
    // page that already has a real URL (navigating would wipe the session).
    // A persistent context ALWAYS starts with one page; on a fresh profile it
    // is about:blank (navigate), after a restore it is the session's URL (keep).
    // Chromium's default launch doesn't session-restore, but a profile can
    // still come up on a non-blank URL (crash-restore, startup prefs).
    const keepRestored = !!(initialPages && this._page && this._page.url() !== "about:blank");
    if (!keepRestored) {
      if (this._url === "about:blank") {
        await this._page.setContent(BLANK_HTML, { waitUntil: "domcontentloaded" });
      } else {
        await this._page.goto(this._url, { waitUntil: "domcontentloaded" });
      }
    }

    // Crash handling for browser disconnect (page crash handled in _registerPage).
    // `disconnected` also fires on an intentional close() — guarded by _intentionalStop
    // so a deliberate stop() isn't misread as a crash.
    this._onBrowserDisconnect = () => {
      if (this._intentionalStop) return;
      this._handleCrash();
    };
    if (this._browser) {
      this._browser.on("disconnected", this._onBrowserDisconnect);
    } else {
      // Persistent mode has no browser object (browser() is null); context
      // close is the equivalent signal (fires on crash AND intentional close,
      // same _intentionalStop guard applies).
      this._context.on("close", this._onBrowserDisconnect);
    }
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
    this._intentionalStop = true;
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
    if (!entry) return;
    // Use BLANK_HTML for about:blank, otherwise navigate
    if (url === "about:blank") {
      await entry.page.setContent(BLANK_HTML, { waitUntil: "domcontentloaded" });
    } else {
      await entry.page.goto(url, { waitUntil: "domcontentloaded" });
    }
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
    // Only send char event if no Ctrl/Command modifier (otherwise shortcuts like Ctrl+A would type 'a')
    const hasModifier = modifiers & 0b111; // Alt=1, Ctrl=2, Meta=4, Shift=8
    const isCtrlOrMeta = modifiers & 0b110; // Ctrl=2 or Meta=4
    if (mapKey.text && type === "keyDown" && !isCtrlOrMeta) {
      await entry.cdp.send("Input.dispatchKeyEvent", { type: "char", text: mapKey.text, modifiers });
    }
  }

  // Clipboard operations: insert text into remote browser, read clipboard on copy/cut
  async insertText(text) {
    const entry = this._pages.get(this._activePageId);
    if (!entry) {
      console.log('[BrowserSession] insertText: no active page');
      return;
    }

    // Limit text length (prevent oversized content)
    const maxLength = 100000; // 100KB
    const safeText = text.substring(0, maxLength);

    //console.log('[BrowserSession] insertText: inserting', safeText.length, 'chars into page', this._activePageId);

    try {
      await entry.cdp.send("Input.insertText", { text: safeText });
      //console.log('[BrowserSession] insertText: success');
    } catch (err) {
      console.error('[BrowserSession] CDP insertText failed:', err);
      // Fallback: send char by char
      await this._fallbackInsertText(entry, safeText);
    }
  }

  async _fallbackInsertText(entry, text) {
    for (const char of text) {
      await entry.cdp.send("Input.dispatchKeyEvent", {
        type: "char",
        text: char
      });
    }
  }

  async handleCopy(cut = false) {
    const entry = this._pages.get(this._activePageId);
    if (!entry) return;

    // Send Ctrl/Command+C or X
    const isMac = process.platform === 'darwin';
    const modifiers = isMac ? 4 : 2;
    const key = cut ? 'x' : 'c';
    const code = cut ? 'KeyX' : 'KeyC';

    // Send keyDown
    await entry.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      modifiers
    });

    // Send keyUp to release modifier
    await entry.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      modifiers
    });

    // Wait for browser to process copy operation
    await new Promise(resolve => setTimeout(resolve, 200));

    // Read selected text from remote browser and sync to client clipboard
    try {
      const result = await entry.cdp.send("Runtime.evaluate", {
        expression: "window.getSelection().toString()",
        awaitPromise: false
      });

      if (result.result && result.result.value && this.onClipboardChange) {
        this.onClipboardChange({ text: result.result.value });
      }
    } catch (err) {
      console.error('Failed to read remote clipboard:', err);
    }
  }
}

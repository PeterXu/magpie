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
    this._page = null;
    this._cdp = null;
    this._onFrame = null;
    this.onCrash = null;
    this.onUrlChange = null;        // fires with {url,canBack,canForward} on main-frame navigation
    this._crashFired = false;
    this._onPageCrash = null;
    this._onBrowserDisconnect = null;
    this._onFrameNavigated = null;
  }

  getViewport() {
    return { width: this._width, height: this._height };
  }

  getUrl() {
    return this._page ? this._page.url() : this._url;
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
    this._page = await this._context.newPage();
    await this._page.goto(this._url, { waitUntil: "domcontentloaded" });
    this._cdp = await this._context.newCDPSession(this._page);
    this._onPageCrash = () => this._handleCrash();
    this._onBrowserDisconnect = () => this._handleCrash();
    this._page.on("crash", this._onPageCrash);
    this._browser.on("disconnected", this._onBrowserDisconnect);
    // URL-bar sync: fire onUrlChange({url,canBack,canForward}) whenever the
    // TOP-LEVEL frame navigates — covers Go, back/forward/reload AND passive
    // link-clicks/form-submit/redirects inside the remote page. iframes and SPA
    // history.pushState (not a real navigation) are intentionally ignored.
    this._onFrameNavigated = (frame) => {
      if (frame !== this._page.mainFrame()) return;
      void (async () => {
        const nav = await this.getNavState();
        if (this.onUrlChange) { try { this.onUrlChange(nav); } catch {} }
      })();
    };
    this._page.on("framenavigated", this._onFrameNavigated);
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
    try { if (this._context) await this._context.close(); } catch {}
    if (this._ownsBrowser && this._browser) { try { await this._browser.close(); } catch {} }
    if (this._page && this._onPageCrash) { this._page.off("crash", this._onPageCrash); }
    if (this._page && this._onFrameNavigated) { this._page.off("framenavigated", this._onFrameNavigated); }
    if (this._browser && this._onBrowserDisconnect) { this._browser.off("disconnected", this._onBrowserDisconnect); }
    this._browser = this._context = this._page = this._cdp = null;
  }

  async navigate(url) {
    this._url = url;
    if (this._page) await this._page.goto(url, { waitUntil: "domcontentloaded" });
  }

  // History navigation. Playwright resolves null (no throw) when there's nothing
  // to go back/forward to; the client disables the button then, but we stay
  // defensive. framenavigated broadcasts the new URL after these resolve.
  async goBack() {
    if (this._page) await this._page.goBack({ waitUntil: "domcontentloaded" });
  }

  async goForward() {
    if (this._page) await this._page.goForward({ waitUntil: "domcontentloaded" });
  }

  async reload() {
    if (this._page) await this._page.reload({ waitUntil: "domcontentloaded" });
  }

  // {url, canBack, canForward} for the client toolbar. Never throws: on any CDP
  // error returns all-false so the hello/broadcast path shows a conservative
  // (both disabled) state instead of failing.
  async getNavState() {
    const url = this.getUrl();
    let canBack = false, canForward = false;
    if (this._cdp) {
      try {
        const { currentIndex, entries } = await this._cdp.send("Page.getNavigationHistory");
        canBack = currentIndex > 0;
        canForward = currentIndex < entries.length - 1;
      } catch {}
    }
    return { url, canBack, canForward };
  }

  async startScreencast(onFrame) {
    await this.stopScreencast();
    this._onFrame = onFrame;
    this._cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
      try {
        if (this._onFrame) this._onFrame({ data: Buffer.from(data, "base64"), metadata, sessionId });
      } finally {
        await this._cdp.send("Page.screencastFrameAck", { sessionId });
      }
    });
    // No everyNthFrame: it's a frame-divisor subsampler (see src/config.js) that
    // starves static pages when >1. CDP defaults to 1 = emit per repaint; the
    // output-fps cap lives in canvas.captureStream(fps) on the streamer page.
    await this._cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: this._screencast.quality,
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

  async dispatchMouse({ x, y, type, button = "left", buttons = 0, clickCount = 1 }) {
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
}

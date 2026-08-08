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

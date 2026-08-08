export class StreamerPeer {
  constructor({ browser }) {
    this._browser = browser;
    this._context = null;
    this._page = null;
    this._frameSocket = null;
  }

  async start({ streamerUrl, iceServers = [] }) {
    this._iceServers = iceServers;
    this._context = await this._browser.newContext();
    this._page = await this._context.newPage();
    await this._page.goto(streamerUrl, { waitUntil: "domcontentloaded" });
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

  getSenderCodecs() {
    return this._senderCodecs || [];
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
    return this._page.evaluate((opts) => window.relayOffer(opts.offer, opts.iceServers), { offer: offerSdp, iceServers: this._iceServers ?? [] });
  }

  async stop() {
    this._frameSocket = null;
    try { if (this._context) await this._context.close(); } catch {}
    this._context = this._page = null;
  }
}

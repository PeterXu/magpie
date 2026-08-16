import logger from '../utils/logger.js';

export class StreamerPeer {
  // streamerUrl may be deferred to start() (tests bind an ephemeral port).
  constructor({ streamerUrl = null, iceServers = [] } = {}) {
    this._streamerUrl = streamerUrl;
    this._iceServers = iceServers;
    this._page = null;
    this._frameSocket = null;
  }

  // The streamer page IS the dedicated streamer BrowserSession's active page
  // (plain launch, no userDataDir — never in the user profile). The session
  // owns the browser/context/page lifecycle; this class only drives the page,
  // so no second context is spawned alongside the session's unused initial one.
  // The remote session's CDP screencast is bridged to pushFrame() by index.js.
  async start({ browserSession, streamerUrl }) {
    this._streamerUrl = streamerUrl ?? this._streamerUrl;
    this._page = browserSession.getActivePage();
    if (!this._page) {
      throw new Error("StreamerPeer: streamer session has no active page (start it first)");
    }

    // Surface page-side failures: parse errors, uncaught exceptions, failed
    // module requests (404/CORS/MIME), and browser-reported console errors.
    // Verbose page logs (ICE gathering, connection lifecycle) opt in via env.
    const verbose = !!process.env.MAGPIE_DEBUG_STREAMER;
    this._page.on("console", (msg) => {
      const type = msg.type();
      if (type === "error" || type === "warning" || verbose) {
        const fn = type === "error" ? console.error : type === "warning" ? console.warn : console.log;
        fn(`[Streamer] ${type}: ${msg.text()}`);
      }
    });
    this._page.on("pageerror", (err) => console.error(`[Streamer] pageerror: ${err.message}`));
    this._page.on("requestfailed", (req) =>
      console.error(`[Streamer] requestfailed: ${req.url()} ${req.failure()?.errorText || ""}`));

    await this._page.goto(this._streamerUrl, { waitUntil: "domcontentloaded" });
    await this._page.waitForFunction(() => window.__ready === true, undefined, { timeout: 5000 });
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

  async handle(msg) {
    logger.log('[InternalSignal] receive message', msg.t);
    switch (msg.t) {
      case 'hi':
        return {
          t: 'hello',
          id: 'internal'
        }
      default:
        return null;
    }
  }

  setFrameSocket(ws) {
    this._frameSocket = ws;
  }

  async pushFrame(jpegBuffer) {
    if (this._frameSocket && this._frameSocket.readyState === this._frameSocket.OPEN) {
      this._frameSocket.send(jpegBuffer);
    } else {
      // Debug: log when frames are dropped due to missing socket
      if (!this._frameSocket) {
        console.error('[StreamerPeer] pushFrame: _frameSocket is null - WebSocket not connected yet?');
      } else if (this._frameSocket.readyState !== this._frameSocket.OPEN) {
        console.error('[StreamerPeer] pushFrame: WebSocket not open, state=', this._frameSocket.readyState);
      }
    }
  }

  async relayOffer(message) {
    return this._page.evaluate((opts) => window.relayOffer(opts.message, opts.iceServers), { message, iceServers: this._iceServers ?? [] });
  }

  // Page/context/browser lifecycle belongs to the streamer BrowserSession;
  // stop() only detaches so the session's stop() can tear everything down.
  async stop() {
    this._page = null;
    this._frameSocket = null;
  }
}

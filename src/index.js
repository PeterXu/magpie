import { BrowserSession } from "./browser/BrowserSession.js";
import { StreamerPeer } from "./streamer/StreamerPeer.js";
import { InputChannel } from "./utils/InputChannel.js";
import { createApp, serve } from "./app.js";
import { WebSocketManager } from "./websocket/WebSocketManager.js";
import { loadConfig } from "./config.js";
import { loadEnvFile } from "./env.js";
import { IdleTimeoutManager } from "./utils/IdleTimeoutManager.js";
import { fileURLToPath } from "node:url";
import { SessionHandler } from './handlers/signaling/SessionHandler.js';
import { SessionRegistry } from "./session/SessionRegistry.js";

// Populate process.env from .env (cwd) before any env is read. Real/shell env
// wins over the file. Dependency-free — see src/env.js.
loadEnvFile();

// Load config
const cfg = loadConfig();

// This is Remote browser session: the browser the user sees and controls. Persistent
// (login state on disk) when MAGPIE_USER_DATA_DIR is set, plain launch
// otherwise. In persistent mode browser() is null — nothing may derive
// contexts from it, which is why the streamer has its own session below.
function createBrowserSession({ wsManager, streamerPeer }) {
  const browserSession = new BrowserSession({ url: cfg.DEFAULT_URL, width: cfg.viewport.width, height: cfg.viewport.height, userDataDir: cfg.USER_DATA_DIR, screencast: cfg.screencast, freezeBackground: cfg.FREEZE_BACKGROUND });

  // URL-bar sync: every main-frame navigation in the remote page (Go,
  // back/forward/reload, or a passive link-click) broadcasts the new nav state
  // to all clients. See the BrowserSession framenavigated listener.
  browserSession.onUrlChange = (nav) => wsManager.broadcast({ t: "nav", ...nav });

  // Tab state broadcast: fire whenever pages are opened/closed/switched or
  // titles change. Clients render the tab bar from this.
  browserSession.onTabsChange = (state) => wsManager.broadcast({ t: "tabs", ...state });

  // Handle clipboard changes from remote browser
  browserSession.onClipboardChange = (data) => {
    wsManager.broadcast({ t: "clipboard", text: data.text });
  };

  // Crash recovery restarts only the remote browser. The streamer page lives
  // in its own Chromium (separate crash domain) and its client-facing
  // RTCPeerConnection survives; re-wiring the screencast bridge resumes video.
  browserSession.onCrash = async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try { await browserSession.restart(); } catch (err) { console.error("onCrash: restart failed", err); }
    wsManager.broadcast({ t: "reload" });
    try { wireScreencast(); } catch (err) { console.error("onCrash: screencast rewire failed", err); }
  };

  // Screencast bridge: remote browser's CDP frames → streamer page canvas.
  // Re-wired after every browserSession start (crash restart / idle restart);
  // startScreencast() replaces the previous callback.
  const wireScreencast = () =>
    browserSession.startScreencast((frame) => streamerPeer.pushFrame(frame.data));

  return { browserSession, wireScreencast };
}

// SessionRegistry needs context + pages with CDP sessions, available only
// after browserSession.start(). Returns a getter function to delay instantiation.
function createSessionRegistryGetter({ browserSession }) {
  let registry = null;  // Singleton instance
  return {
    getRegistry: () => {
      if (!browserSession._context || browserSession._pages.size === 0) return null;
      // Reuse instance to preserve check results across calls
      if (!registry) {
        registry = new SessionRegistry({ browserSession });
      }
      return registry;
    }
  };
}

// Streamer session: hosts the streamer page (canvas → WebRTC). Always a plain
// launch — never in the user profile — so StreamerPeer can borrow a context
// from its browser and profile data stays clean of streamer traffic.
// Viewport can be tiny: the canvas resolution comes from the streamer URL's
// w/h params (canvas.width/height + captureStream read the backing store,
// never the layout), so a small window only saves compositor memory.
// If it crashes, the streamer page (and every client's RTCPeerConnection
// endpoint) dies — onCrash restarts it and clients re-offer via reload.
function createStreamerSession({ wsManager, streamerPeer }) {
  // freezeBackground: false — the streamer page must NEVER be frozen. It's a
  // single-page session (no _switchTo would ever freeze it anyway), but make
  // that explicit: a frozen streamer page would stop drawing frames and
  // answering relayOffer, killing every client's video.
  const streamerSession = new BrowserSession({ url: "about:blank", width: 320, height: 240, freezeBackground: false });

  streamerSession.onCrash = async () => {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      await streamerSession.restart();
      await streamerPeer.start({ browserSession: streamerSession });
    } catch (err) {
      console.error("[StreamerCrash] recovery failed", err);
      return;
    }
    // The old RTCPeerConnections died with the streamer page; a client page
    // reload re-runs the whole offer/answer handshake against the new one.
    wsManager.broadcast({ t: "reload" });
  };

  return streamerSession;
}

async function main() {
  // Server-side peer (streamer page) reaches TURN by container name (Docker internal);
  // client-side peer reaches it via the host IP. Both empty when HOST_IP unset
  // (native run -> pure host candidates).
  // 验证ICE servers配置
  console.log('[magpie] ICE Config, HOST_IP:', cfg.net.HOST_IP || '(not set)');
  console.log('[magpie] ICE Config, clientIceServers:', JSON.stringify(cfg.clientIceServers()));

  // Create WebSocket manager for broadcasting
  const wsManager = new WebSocketManager();

  // Create SteamerPeer for streamer.html
  const streamerPeer = new StreamerPeer({
    streamerUrl: cfg.buildStreamerUrl('streamer.html'),
    iceServers: cfg.serverIceServers()
  });

  // Two browser sessions with separate lifecycles and crash domains:
  // - browserSession: the user's reload-broadcasting browser (persistent profile when configured)
  // - streamerSession: hosts the streamer page (plain launch, no profile)
  const { browserSession, wireScreencast } = createBrowserSession({ wsManager, streamerPeer });
  const streamerSession = createStreamerSession({ wsManager, streamerPeer });

  // Create InputChannel for processing BrowserSession events
  const inputChannel = new InputChannel({ browserSession });

  // Create idle timeout manager
  const idleTimeoutManager = new IdleTimeoutManager({
    timeoutMinutes: cfg.IDLE_TIMEOUT_MINUTES
  });

  // Listen for connection changes
  wsManager.on('connection-change', (clientCount) => {
    idleTimeoutManager.handleConnectionChange(clientCount);
  });

  // Handle idle timeout stop event
  idleTimeoutManager.onStop = async () => {
    try {
      await streamerPeer.stop();
      await browserSession.stop();
      await streamerSession.stop();
    } catch (err) {
      console.error('[IdleTimeout] Stop error:', err);
    }
  };

  // Handle idle timeout restart event
  idleTimeoutManager.onRestart = async () => {
    await ensureBrowserStarted();
  };

  async function ensureBrowserStarted() {
    try {
      // about:blank keeps the user profile clean; in persistent mode login
      // state is on disk anyway — restart restores it automatically.
      if (!browserSession._context) {
        await browserSession.start({ url: "about:blank" });
        await streamerSession.start();
        await streamerPeer.start({ browserSession: streamerSession });
        wireScreencast();
      }
    } catch (err) {
      console.error('[IdleTimeout] Restart error:', err);
    }
  }

  // Start idle timeout manager with initial client count
  idleTimeoutManager.start(wsManager.clients.size);

  // Create signal session handler
  const sessionHandler = new SessionHandler({
    browserSession,
    streamerPeer,
    inputChannel,
    clientIceServers: cfg.clientIceServers()
  });

  // Create SessionRegistry getter
  const sessionRegistryGetter = createSessionRegistryGetter({ browserSession });

  // Create Hono app with all dependencies
  const { app, wsRoutes } = await createApp({
    streamerPeer,
    sessionHandler,
    wsManager,
    env: cfg.auth,
    getSessionRegistry: sessionRegistryGetter.getRegistry,
    ensureBrowserStarted
  });

  // Start the server
  const server = serve({ fetch: app.fetch, port: cfg.net.PORT, hostname: cfg.net.HOST });

  // Handle WebSocket upgrades
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);

    for (const { wsServer, path } of wsRoutes) {
      if (pathname === path) {
        wsServer.handleUpgrade(request, socket, head, (ws) => {
          wsServer.emit('connection', ws, request);
        });
        return;
      }
    }

    // No WebSocket route matched
    socket.destroy();
  });
 
  console.log(`[magpie] listening on ${cfg.net.HOST}:${cfg.net.PORT}`);

  // start browsers and streamPeer (remote first — streamer borrows nothing
  // from it, but the screencast bridge needs the remote pages up)
  await browserSession.start();
  await streamerSession.start();
  // StreamerPeer drives the streamer session's own initial page — no extra
  // context/page is created alongside it.
  await streamerPeer.start({ browserSession: streamerSession });
  wireScreencast();

  const shutdown = async () => {
    server.close();
    await idleTimeoutManager.stop();
    // Graceful close so the persistent profile flushes to disk and Chromium
    // doesn't leave a SingletonLock in the userDataDir. Streamer first (it
    // borrows a context from streamerSession's browser).
    try { await streamerPeer.stop(); } catch (err) { console.error("[magpie] streamer stop failed", err); }
    try { await streamerSession.stop(); } catch (err) { console.error("[magpie] streamer browser stop failed", err); }
    try { await browserSession.stop(); } catch (err) { console.error("[magpie] remote browser stop failed", err); }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

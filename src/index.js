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

// Populate process.env from .env (cwd) before any env is read. Real/shell env
// wins over the file. Dependency-free — see src/env.js.
loadEnvFile();

// Load config
const cfg = loadConfig();

function createBrowserSession({ wsManager, streamerPeer }) {
  const browserSession = new BrowserSession({ url: cfg.DEFAULT_URL, width: cfg.viewport.width, height: cfg.viewport.height, screencast: cfg.screencast });
  
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

  browserSession.onCrash = async () => {
    try { await streamerPeer.stop(); } catch (err) { console.error("onCrash: streamerPeer stop failed", err); }
    await new Promise(resolve => setTimeout(resolve, 1000));
    try { await browserSession.restart(); } catch (err) { console.error("onCrash: restart failed", err); }
    wsManager.broadcast({ t: "reload" });
    try { await streamerPeer.start({ browserSession }); } catch (err) { console.error("onCrash: streamerPeer start failed", err); }
  };

  return browserSession;
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

  // Create BrowserSession
  const browserSession = createBrowserSession({ wsManager, streamerPeer });

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
    } catch (err) {
      console.error('[IdleTimeout] Stop error:', err);
    }
  };

  // Handle idle timeout restart event
  idleTimeoutManager.onRestart = async () => {
    try {
      await browserSession.start();
      await streamerPeer.start({browserSession});
    } catch (err) {
      console.error('[IdleTimeout] Restart error:', err);
    }
  };

  // Start idle timeout manager with initial client count
  idleTimeoutManager.start(wsManager.clients.size);

  // Create signal session handler
  const sessionHandler = new SessionHandler({
    browserSession,
    streamerPeer,
    inputChannel,
    clientIceServers: cfg.clientIceServers()
  });

  // Create Hono app with all dependencies
  const { app, wsRoutes } = createApp({
    streamerPeer,
    sessionHandler,
    wsManager,
    env: cfg.auth
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

  // start browser and streamPeer
  await browserSession.start();
  await streamerPeer.start({ browserSession });

  const shutdown = async () => {
    server.close();
    await idleTimeoutManager.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./browser/launch-options.js";
import { BrowserSession } from "./browser/BrowserSession.js";
import { StreamerPeer } from "./streamer/StreamerPeer.js";
import { InputChannel } from "./webrtc/InputChannel.js";
import { createServer } from "./server.js";
import { buildIceServers } from "./webrtc/ice-servers.js";
import { loadConfig } from "./config.js";
import { loadEnvFile } from "./env.js";
import { fileURLToPath } from "node:url";

// Populate process.env from .env (cwd) before any env is read. Real/shell env
// wins over the file. Dependency-free — see src/env.js.
loadEnvFile();

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const DEFAULT_URL = process.env.MAGPIE_URL ?? "about:blank";
const cfg = loadConfig();
const HOST_IP = process.env.MAGPIE_HOST_IP ?? "";
const TURN_USER = process.env.MAGPIE_TURN_USER ?? "magpie";
const TURN_PASS = process.env.MAGPIE_TURN_PASS ?? "magpie";
const TURN_HOST = process.env.MAGPIE_TURN_HOST ?? "iceturn"; // Container name for Docker, or custom TURN host

// Server-side peer (streamer page) reaches TURN by container name (Docker internal);
// client-side peer reaches it via the host IP. Both empty when HOST_IP unset
// (native run -> pure host candidates).
const serverIceServers = HOST_IP ? buildIceServers({ host: TURN_HOST, user: TURN_USER, pass: TURN_PASS }) : [];
const clientIceServers = buildIceServers({ host: HOST_IP, user: TURN_USER, pass: TURN_PASS });

// 验证ICE servers配置
console.log('[ICE Config] HOST_IP:', HOST_IP || '(not set)');
console.log('[ICE Config] clientIceServers:', JSON.stringify(clientIceServers));

// Pure: build the streamer page URL from cfg. Exported for unit testing.
export function buildStreamerUrl(base, c) {
  const w = c.webrtc;
  const parts = [
    `w=${c.viewport.width}`,
    `h=${c.viewport.height}`,
    `fps=${w.streamFps}`,
  ];
  if (w.maxBitrate) parts.push(`bitrate=${w.maxBitrate}`);
  if (w.maxFramerate) parts.push(`maxFps=${w.maxFramerate}`);
  if (w.degradation) parts.push(`degradation=${w.degradation}`);
  return `${base}/streamer.html?${parts.join("&")}`;
}

async function main() {
  const browser = await chromium.launch(chromiumLaunchOptions());

  const browserSession = new BrowserSession({ url: DEFAULT_URL, width: cfg.viewport.width, height: cfg.viewport.height, browser, screencast: cfg.screencast });
  await browserSession.start();

  const streamerPeer = new StreamerPeer({ browser });
  const inputChannel = new InputChannel({ browserSession, viewportProvider: browserSession });

  const server = createServer({ browserSession, inputChannel, streamerPeer, clientIceServers });
  await new Promise((r) => server.listen(PORT, HOST, r));
  const base = `http://127.0.0.1:${PORT}`;

  await streamerPeer.start({ streamerUrl: buildStreamerUrl(base, cfg), iceServers: serverIceServers });

  // Pump screencast frames into the streamer page.
  await browserSession.startScreencast((frame) => streamerPeer.pushFrame(frame.data));

  // URL-bar sync: every main-frame navigation in the remote page (Go,
  // back/forward/reload, or a passive link-click) broadcasts the new nav state
  // to all clients. See the BrowserSession framenavigated listener.
  browserSession.onUrlChange = (nav) => server.broadcast({ t: "nav", ...nav });

  // Tab state broadcast: fire whenever pages are opened/closed/switched or
  // titles change. Clients render the tab bar from this.
  browserSession.onTabsChange = (state) => server.broadcast({ t: "tabs", ...state });

  // Handle clipboard changes from remote browser
  browserSession.onClipboardChange = (data) => {
    server.broadcast({ t: "clipboard", text: data.text });
  };

  browserSession.onCrash = async () => {
    try { await browserSession.restart(); } catch (err) { console.error("onCrash: restart failed", err); }
    server.broadcast({ t: "reload" });
    try { await browserSession.startScreencast((frame) => streamerPeer.pushFrame(frame.data)); } catch (err) { console.error("onCrash: screencast restart failed", err); }
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

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

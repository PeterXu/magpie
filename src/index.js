import { chromium } from "playwright";
import { chromiumLaunchOptions } from "./browser/launch-options.js";
import { BrowserSession } from "./browser/BrowserSession.js";
import { StreamerPeer } from "./streamer/StreamerPeer.js";
import { InputChannel } from "./webrtc/InputChannel.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const DEFAULT_URL = process.env.MAGPIE_URL ?? "https://gitee.com";
const WIDTH = 1280, HEIGHT = 800;

async function main() {
  const browser = await chromium.launch(chromiumLaunchOptions());

  const browserSession = new BrowserSession({ url: DEFAULT_URL, width: WIDTH, height: HEIGHT, browser });
  await browserSession.start();

  const streamerPeer = new StreamerPeer({ browser });
  const inputChannel = new InputChannel({ browserSession, viewportProvider: browserSession });

  const server = createServer({ browserSession, inputChannel, streamerPeer });
  await new Promise((r) => server.listen(PORT, HOST, r));
  const base = `http://127.0.0.1:${PORT}`;

  await streamerPeer.start({ streamerUrl: `${base}/streamer.html?w=${WIDTH}&h=${HEIGHT}` });

  // Pump screencast frames into the streamer page.
  await browserSession.startScreencast((frame) => streamerPeer.pushFrame(frame.data));

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

main().catch((err) => { console.error(err); process.exit(1); });

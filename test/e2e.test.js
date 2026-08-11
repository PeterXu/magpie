import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { BrowserSession } from "../src/browser/BrowserSession.js";
import { StreamerPeer } from "../src/streamer/StreamerPeer.js";
import { InputChannel } from "../src/webrtc/InputChannel.js";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { WebSocketManager } from "../src/websocket/WebSocketManager.js";

const FIXTURE = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "click-target.html")).href;

async function boot() {
  const browser = await chromium.launch({ headless: true });
  const browserSession = new BrowserSession({ url: FIXTURE, width: 400, height: 300, browser });
  await browserSession.start();
  const streamerPeer = new StreamerPeer({ browser });
  const inputChannel = new InputChannel({ browserSession, viewportProvider: browserSession });

  // Create WebSocket manager
  const wsManager = new WebSocketManager();

  // Create Hono app
  const { app, wsRoutes } = createApp({ browserSession, streamerPeer, inputChannel, clientIceServers: [], wsManager });

  // Start server using Hono's serve function
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });

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

    socket.destroy();
  });

  // Wait for server to be ready
  await new Promise((resolve) => {
    server.on('listening', resolve);
    // Timeout after 1 second if listening event doesn't fire
    setTimeout(resolve, 100);
  });

  const address = server.address();
  if (!address) {
    throw new Error('Server not listening');
  }

  const base = `http://127.0.0.1:${address.port}`;
  await streamerPeer.start({ streamerUrl: `${base}/streamer.html?w=400&h=300` });
  await browserSession.startScreencast((frame) => streamerPeer.pushFrame(frame.data));
  return { browser, browserSession, streamerPeer, server, base };
}

test("e2e: client sees video and a click reaches the target page", async () => {
  const ctx = await boot();
  const client = await ctx.browser.newPage({ viewport: { width: 500, height: 400 } });
  try {
    await client.goto(`${ctx.base}/`, { waitUntil: "domcontentloaded" });

    // Switch to WebRTC panel (button is in this panel)
    await client.click('[data-panel="webrtc"]');

    // Click the connect button to establish WebSocket connection
    await client.click('#connectBtn');

    // Wait for connection status to show connected (status-dot gets .connected class)
    await client.waitForSelector('.status-dot.connected', { timeout: 5000 });

    // Video should start playing.
    await client.waitForFunction(() => { const v = document.getElementById("v"); return v && v.videoWidth > 0; }, { timeout: 10000 });

    // Wait a bit for WebRTC connection to fully establish
    await new Promise(resolve => setTimeout(resolve, 500));

    // Click the fixture button center (160,130) in a 400x300 page, mapped through the displayed video.
    const rect = await client.locator("#v").boundingBox();
    const sx = 160 / 400, sy = 130 / 300;
    await client.mouse.click(rect.x + rect.width * sx, rect.y + rect.height * sy);

    await ctx.browserSession._page.waitForFunction(() => document.getElementById("count").textContent !== "0", { timeout: 3000 });
    const count = await ctx.browserSession._page.evaluate(() => document.getElementById("count").textContent);
    assert.equal(count, "1");

    // Offerer-side codec selection: the client's offer must be narrowed to a
    // single preferred codec (the encoder follows the offer's m-line order).
    const offer = await client.evaluate(() => window._lastOffer);
    const real = new Set();
    for (const line of (offer || "").split("\r\n")) {
      if (line.startsWith("a=rtpmap:")) {
        const name = line.split(" ")[1].split("/")[0].toLowerCase();
        if (!["rtx", "red", "ulpfec", "flexfec-03"].includes(name)) real.add(name);
      }
    }
    assert.equal(real.size, 1, `offer video m-line should have one real codec, got ${[...real]}`);
    assert.ok(["av1", "vp9", "vp8", "h264"].includes([...real][0]), `unexpected codec ${[...real][0]}`);
  } finally {
    await client.close();
    ctx.server.close();
    await ctx.streamerPeer.stop();
    await ctx.browserSession.stop();
    await ctx.browser.close();
  }
});

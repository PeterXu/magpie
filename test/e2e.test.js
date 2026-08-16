import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { BrowserSession } from "../src/browser/BrowserSession.js";
import { StreamerPeer } from "../src/streamer/StreamerPeer.js";
import { InputChannel } from "../src/utils/InputChannel.js";
import { SessionHandler } from '../src/handlers/signaling/SessionHandler.js';
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { WebSocketManager } from "../src/websocket/WebSocketManager.js";
import { Jwt } from 'hono/utils/jwt';

const FIXTURE = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "click-target.html")).href;

async function boot() {
  const browser = await chromium.launch({ headless: true });
  // If anything below throws mid-boot, tear down what we already own.
  // Leaked handles (browser, http server) keep the event loop alive and hang
  // node --test.
  let browserSession = null;
  let streamerSession = null;
  let server = null;
  try {
    browserSession = new BrowserSession({ url: FIXTURE, width: 400, height: 300, browser });
    await browserSession.start();
    // Dedicated streamer session (same shape as index.js's createStreamerSession):
    // the streamer page is its active page, separate from the remote session.
    streamerSession = new BrowserSession({ url: "about:blank", width: 320, height: 240, browser });
    await streamerSession.start();
    const streamerPeer = new StreamerPeer();  // URL known after listen()
    const inputChannel = new InputChannel({ browserSession });

    // Create WebSocket manager
    const wsManager = new WebSocketManager();

    // Create Session handler
    const sessionHandler = new SessionHandler({
      browserSession,
      streamerPeer,
      inputChannel,
      clientIceServers: []
    });

    // Create Hono app with empty auth config (no auth required for e2e tests)
    const { app, wsRoutes } = createApp({
      streamerPeer,
      sessionHandler,
      wsManager,
      env: {
        ADMIN_USER: 'admin',
        ADMIN_PASSWORD: '',  // Empty password disables auth
        JWT_SECRET: 'test-secret',
        JWT_EXPIRES_IN: 86400
      }
    });

    // Start server using Hono's serve function
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });

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
    await streamerPeer.start({ browserSession: streamerSession, streamerUrl: `${base}/streamer.html?w=400&h=300` });
    // Screencast bridge (index.js responsibility in production): remote CDP
    // frames → streamer page canvas.
    await browserSession.startScreencast((frame) => streamerPeer.pushFrame(frame.data));
    return { browser, browserSession, streamerSession, streamerPeer, server, base };
  } catch (err) {
    try { if (server) server.close(); } catch {}
    try { if (streamerSession) await streamerSession.stop(); } catch {}
    try { if (browserSession) await browserSession.stop(); } catch {}
    try { await browser.close(); } catch {}
    throw err;
  }
}

test("e2e: client sees video and a click reaches the target page", async () => {
  const ctx = await boot();
  const client = await ctx.browser.newPage({ viewport: { width: 500, height: 400 } });

  // Generate a test token for authentication
  const testPayload = { sub: 'test-user', role: 'admin', iat: Math.floor(Date.now() / 1000) };
  const testToken = await Jwt.sign(testPayload, 'test-secret');

  // Add init script to set token before page loads
  await client.addInitScript((token) => {
    localStorage.setItem('token', token);
  }, testToken);

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
    await ctx.streamerSession.stop();
    await ctx.browserSession.stop();
    await ctx.browser.close();
  }
});

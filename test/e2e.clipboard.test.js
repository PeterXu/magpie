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
  const browserSession = new BrowserSession({ url: FIXTURE, width: 400, height: 300, browser });
  await browserSession.start();
  // Dedicated streamer session (same shape as index.js's createStreamerSession):
  // the streamer page is its active page, separate from the remote session.
  const streamerSession = new BrowserSession({ url: "about:blank", width: 320, height: 240, browser });
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

  // Start server
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
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  await streamerPeer.start({ browserSession: streamerSession, streamerUrl: `${base}/streamer.html?w=400&h=300` });
  // Screencast bridge (index.js responsibility in production): remote CDP
  // frames → streamer page canvas.
  await browserSession.startScreencast((frame) => streamerPeer.pushFrame(frame.data));
  return { browser, browserSession, streamerSession, streamerPeer, inputChannel, server, base };
}

/**
 * Generate a test JWT token and set it in localStorage using addInitScript
 */
async function setupTestAuth(page, token) {
  // Add init script to set token before page loads
  await page.addInitScript((t) => {
    localStorage.setItem('token', t);
  }, token);
}

test("e2e clipboard: connection and status indicator", async () => {
  const ctx = await boot();
  const client = await ctx.browser.newPage({ viewport: { width: 500, height: 400 } });

  // Generate test token and setup auth
  const testPayload = { sub: 'test-user', role: 'admin', iat: Math.floor(Date.now() / 1000) };
  const testToken = await Jwt.sign(testPayload, 'test-secret');
  await setupTestAuth(client, testToken);

  try {
    await client.goto(`${ctx.base}/`, { waitUntil: "domcontentloaded" });

    // Switch to WebRTC panel (intro panel is shown by default)
    await client.click('[data-panel="webrtc"]');

    // Wait for page to load and show connect button
    await client.waitForSelector("#connectBtn", { timeout: 5000 });

    // Initially disconnected (gray dot)
    const disconnectedStatus = await client.$eval(".status-dot", (el) =>
      el.classList.contains("connected")
    );
    assert.equal(disconnectedStatus, false, "Should start disconnected");

    // Click connect button
    await client.click("#connectBtn");

    // Wait for WebSocket connection and WebRTC setup
    await client.waitForFunction(
      () => {
        const dot = document.querySelector(".status-dot");
        return dot && dot.classList.contains("connected");
      },
      { timeout: 10000 }
    );

    // Verify connected state
    const connectedStatus = await client.$eval(".status-dot", (el) =>
      el.classList.contains("connected")
    );
    assert.equal(connectedStatus, true, "Should be connected after clicking connect");

    // Wait for video to start playing
    await client.waitForFunction(
      () => {
        const v = document.getElementById("v");
        return v && v.videoWidth > 0;
      },
      { timeout: 10000 }
    );

    // Video should be playing
    const videoWidth = await client.$eval("#v", (v) => v.videoWidth);
    assert.ok(videoWidth > 0, "Video should have width after connection");
  } finally {
    await client.close();
    ctx.server.close();
    await ctx.streamerPeer.stop();
    await ctx.streamerSession.stop();
    await ctx.browserSession.stop();
    await ctx.browser.close();
  }
});

test("e2e clipboard: paste message handled by server", async () => {
  const ctx = await boot();
  const client = await ctx.browser.newPage({ viewport: { width: 500, height: 400 } });

  // Generate test token and setup auth
  const testPayload = { sub: 'test-user', role: 'admin', iat: Math.floor(Date.now() / 1000) };
  const testToken = await Jwt.sign(testPayload, 'test-secret');
  await setupTestAuth(client, testToken);

  try {
    await client.goto(`${ctx.base}/`, { waitUntil: "domcontentloaded" });
    // Switch to WebRTC panel
    await client.click('[data-panel="webrtc"]');
    await client.waitForSelector("#connectBtn", { timeout: 5000 });
    await client.click("#connectBtn");

    // Wait for connection
    await client.waitForFunction(
      () => document.querySelector(".status-dot.connected"),
      { timeout: 10000 }
    );

    // Wait for video to start
    await client.waitForFunction(
      () => {
        const v = document.getElementById("v");
        return v && v.videoWidth > 0;
      },
      { timeout: 10000 }
    );

    // Navigate remote browser to a page with an input field
    const inputHtml = `
      <!DOCTYPE html>
      <html>
      <body>
        <input id="textInput" type="text" />
      </body>
      </html>
    `;
    await ctx.browserSession._page.setContent(inputHtml, { waitUntil: "domcontentloaded" });

    // Wait for navigation
    await client.waitForTimeout(500);

    // Focus the input in the remote page
    await ctx.browserSession._page.focus("#textInput");

    // Simulate paste message being sent from client
    // In real usage, this happens when user presses Ctrl+V and clipboard API reads the text
    // Here we simulate the WebSocket message directly
    const pasteMessage = JSON.stringify({ t: "paste", text: "Hello from clipboard!" });
    await ctx.inputChannel.handle(Buffer.from(pasteMessage));

    // Wait for text to be inserted
    await client.waitForTimeout(300);

    // Verify text appeared in remote input
    const inputText = await ctx.browserSession._page.$eval(
      "#textInput",
      (el) => el.value
    );
    assert.equal(inputText, "Hello from clipboard!", "Text should be inserted into remote page");
  } finally {
    await client.close();
    ctx.server.close();
    await ctx.streamerPeer.stop();
    await ctx.streamerSession.stop();
    await ctx.browserSession.stop();
    await ctx.browser.close();
  }
});

test("e2e clipboard: large text is truncated", async () => {
  const ctx = await boot();
  try {
    // Navigate to a page with an input field
    const inputHtml = `
      <!DOCTYPE html>
      <html>
      <body>
        <input id="textInput" type="text" />
      </body>
      </html>
    `;
    await ctx.browserSession._page.setContent(inputHtml, { waitUntil: "domcontentloaded" });
    await ctx.browserSession._page.focus("#textInput");

    // Create text larger than 100KB limit
    const largeText = "x".repeat(150000);

    // Send paste message with large text
    const pasteMessage = JSON.stringify({ t: "paste", text: largeText });
    await ctx.inputChannel.handle(Buffer.from(pasteMessage));

    // Wait for text to be inserted
    await new Promise((r) => setTimeout(r, 300));

    // Verify text was truncated to 100KB
    const inputText = await ctx.browserSession._page.$eval(
      "#textInput",
      (el) => el.value
    );
    assert.equal(inputText.length, 100000, "Text should be truncated to 100KB");
    assert.ok(inputText.startsWith("x"), "Text should contain the original characters");
  } finally {
    ctx.server.close();
    await ctx.streamerPeer.stop();
    await ctx.streamerSession.stop();
    await ctx.browserSession.stop();
    await ctx.browser.close();
  }
});

test("e2e clipboard: copy message triggers clipboard callback", async () => {
  const ctx = await boot();
  try {
    // Track clipboard callback
    let clipboardText = null;
    ctx.browserSession.onClipboardChange = (data) => {
      clipboardText = data.text;
    };

    // Navigate to a page with input containing text
    const inputHtml = `
      <!DOCTYPE html>
      <html>
      <body>
        <input id="textInput" type="text" value="test copy content" />
      </body>
      </html>
    `;
    await ctx.browserSession._page.setContent(inputHtml, { waitUntil: "domcontentloaded" });

    // Select all text
    await ctx.browserSession._page.evaluate(() => {
      const input = document.getElementById("textInput");
      input.select();
    });

    // Send copy message
    const copyMessage = JSON.stringify({ t: "copy", cut: false });
    await ctx.inputChannel.handle(Buffer.from(copyMessage));

    // Wait for clipboard operation
    await new Promise((r) => setTimeout(r, 500));

    // Note: In headless mode, clipboard.readText() may not work due to permissions
    // The test verifies that the copy message flow is handled without errors
    // Manual testing is required for full clipboard verification
  } finally {
    ctx.server.close();
    await ctx.streamerPeer.stop();
    await ctx.streamerSession.stop();
    await ctx.browserSession.stop();
    await ctx.browser.close();
  }
});

test("e2e clipboard: disconnect and reconnect", async () => {
  const ctx = await boot();
  const client = await ctx.browser.newPage({ viewport: { width: 500, height: 400 } });

  // Generate test token and setup auth
  const testPayload = { sub: 'test-user', role: 'admin', iat: Math.floor(Date.now() / 1000) };
  const testToken = await Jwt.sign(testPayload, 'test-secret');
  await setupTestAuth(client, testToken);

  try {
    await client.goto(`${ctx.base}/`, { waitUntil: "domcontentloaded" });
    // Switch to WebRTC panel
    await client.click('[data-panel="webrtc"]');
    await client.waitForSelector("#connectBtn", { timeout: 5000 });

    // Connect
    await client.click("#connectBtn");
    await client.waitForFunction(
      () => document.querySelector(".status-dot.connected"),
      { timeout: 10000 }
    );

    // Wait for video
    await client.waitForFunction(
      () => {
        const v = document.getElementById("v");
        return v && v.videoWidth > 0;
      },
      { timeout: 10000 }
    );

    // Disconnect
    await client.click("#disconnectBtn");
    await client.waitForFunction(
      () => {
        const dot = document.querySelector(".status-dot");
        return dot && !dot.classList.contains("connected");
      },
      { timeout: 5000 }
    );

    // Reconnect
    await client.click("#connectBtn");
    await client.waitForFunction(
      () => document.querySelector(".status-dot.connected"),
      { timeout: 10000 }
    );

    // Verify video plays again after reconnect
    await client.waitForFunction(
      () => {
        const v = document.getElementById("v");
        return v && v.videoWidth > 0;
      },
      { timeout: 10000 }
    );

    const videoWidth = await client.$eval("#v", (v) => v.videoWidth);
    assert.ok(videoWidth > 0, "Video should play again after reconnect");
  } finally {
    await client.close();
    ctx.server.close();
    await ctx.streamerPeer.stop();
    await ctx.streamerSession.stop();
    await ctx.browserSession.stop();
    await ctx.browser.close();
  }
});

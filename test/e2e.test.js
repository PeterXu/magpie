import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { BrowserSession } from "../src/browser/BrowserSession.js";
import { StreamerPeer } from "../src/streamer/StreamerPeer.js";
import { InputChannel } from "../src/webrtc/InputChannel.js";
import { createServer } from "../src/server.js";

const FIXTURE = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "click-target.html")).href;

async function boot() {
  const browser = await chromium.launch({ headless: true });
  const browserSession = new BrowserSession({ url: FIXTURE, width: 400, height: 300, browser });
  await browserSession.start();
  const streamerPeer = new StreamerPeer({ browser });
  const inputChannel = new InputChannel({ browserSession, viewportProvider: browserSession });
  const server = createServer({ browserSession, inputChannel, streamerPeer });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  await streamerPeer.start({ streamerUrl: `${base}/streamer.html?w=400&h=300` });
  await browserSession.startScreencast((frame) => streamerPeer.pushFrame(frame.data));
  return { browser, browserSession, streamerPeer, server, base };
}

test("e2e: client sees video and a click reaches the target page", async () => {
  const ctx = await boot();
  const client = await ctx.browser.newPage({ viewport: { width: 500, height: 400 } });
  try {
    await client.goto(`${ctx.base}/`, { waitUntil: "domcontentloaded" });
    // Video should start playing.
    await client.waitForFunction(() => { const v = document.getElementById("v"); return v && v.videoWidth > 0; }, { timeout: 10000 });

    // Click the fixture button center (160,130) in a 400x300 page, mapped through the displayed video.
    const rect = await client.locator("#v").boundingBox();
    const sx = 160 / 400, sy = 130 / 300;
    await client.mouse.click(rect.x + rect.width * sx, rect.y + rect.height * sy);

    await ctx.browserSession._page.waitForFunction(() => document.getElementById("count").textContent !== "0", { timeout: 3000 });
    const count = await ctx.browserSession._page.evaluate(() => document.getElementById("count").textContent);
    assert.equal(count, "1");
  } finally {
    await client.close();
    ctx.server.close();
    await ctx.streamerPeer.stop();
    await ctx.browserSession.stop();
    await ctx.browser.close();
  }
});

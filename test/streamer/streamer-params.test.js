import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STREAMER_HTML = path.join(__dirname, "..", "..", "src", "streamer", "streamer.html");

async function serveStreamer() {
  const html = await readFile(STREAMER_HTML, "utf8");
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/streamer.html")) { res.writeHead(200, { "content-type": "text/html" }); return res.end(html); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("streamer.html: parses fps/bitrate/maxFps/degradation from query", async () => {
  const { server, base } = await serveStreamer();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/streamer.html?w=16&h=16&fps=20&bitrate=1500000&maxFps=15&degradation=maintain-resolution`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__magpieCfg, { timeout: 3000 });
    const cfg = await page.evaluate(() => window.__magpieCfg);
    assert.equal(cfg.FPS, 20);
    assert.equal(cfg.BITRATE, 1500000);
    assert.equal(cfg.MAXFPS, 15);
    assert.equal(cfg.DEGRADATION, "maintain-resolution");
  } finally {
    await browser.close();
    server.close();
  }
});

test("streamer.html: defaults when no caps in query", async () => {
  const { server, base } = await serveStreamer();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/streamer.html?w=16&h=16`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__magpieCfg, { timeout: 3000 });
    const cfg = await page.evaluate(() => window.__magpieCfg);
    assert.equal(cfg.FPS, 10);
    assert.equal(cfg.BITRATE, 0);
    assert.equal(cfg.MAXFPS, 0);
    assert.equal(cfg.DEGRADATION, "");
  } finally {
    await browser.close();
    server.close();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { BrowserSession } from "../../src/browser/BrowserSession.js";

// Persistent-mode tests. Real Chromium with a throwaway profile dir (mkdtemp).
// Cookies/localStorage need a real origin (about:blank/data: have no jar), so
// a tiny local HTTP server stands in for the "site".
// Each test spawns 1-2 full Chromium processes; keep the file lean. Sessions
// MUST be stopped in finally — a leaked Chromium keeps the event loop alive.

function startSite() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!DOCTYPE html><html><body>site</body></html>");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

test("BrowserSession persistent: cookies and localStorage survive stop/start", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "magpie-persist-"));
  const { server, url } = await startSite();
  let session = null;
  try {
    // First run: log in (set cookie + localStorage on the site origin).
    session = new BrowserSession({ url, width: 400, height: 300, userDataDir: dir });
    await session.start();
    await session._page.evaluate(() => {
      document.cookie = "session_token=persisted; max-age=3600; path=/";
      localStorage.setItem("magpie_ls", "hello");
    });
    await session.stop();

    // Second run, same userDataDir: login state must still be there.
    session = new BrowserSession({ url, width: 400, height: 300, userDataDir: dir });
    await session.start();
    const page = session._page;
    assert.ok(page.url().startsWith(url), `configured URL loaded, got ${page.url()}`);
    const cookies = await page.context().cookies();
    assert.ok(cookies.some(c => c.name === "session_token" && c.value === "persisted"),
      `cookie should survive restart, got ${JSON.stringify(cookies)}`);
    assert.equal(await page.evaluate(() => localStorage.getItem("magpie_ls")), "hello");
  } finally {
    if (session) { try { await session.stop(); } catch {} }
    await rm(dir, { recursive: true, force: true });
    server.close();
  }
});

test("BrowserSession persistent: fresh profile navigates to configured URL, one page", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "magpie-persist-"));
  const { server, url } = await startSite();
  let session = null;
  try {
    session = new BrowserSession({ url, width: 400, height: 300, userDataDir: dir });
    await session.start();
    assert.ok(session._pages.size >= 1, "initial page registered");
    assert.ok(session._activePageId !== null, "active page assigned");
    assert.ok(session._page.url().startsWith(url), `navigated to configured URL, got ${session._page.url()}`);
  } finally {
    if (session) { try { await session.stop(); } catch {} }
    await rm(dir, { recursive: true, force: true });
    server.close();
  }
});

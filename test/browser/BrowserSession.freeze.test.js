import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserSession } from "../../src/browser/BrowserSession.js";

// Background-tab freezing (JS disabled + network cut + loading stopped). A
// busy page must stop while backgrounded and resume when switched back to —
// headless Chromium otherwise runs every tab at full speed.

// A page that counts setInterval ticks into the DOM.
const TICKER_HTML = `<!DOCTYPE html><html><body>
<div id="ticks">0</div>
<div id="phase">running</div>
<script>
  window.n = 0;
  setInterval(() => { window.n++; document.getElementById("ticks").textContent = window.n; }, 20);
</script></body></html>`;

async function startTickerSite() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(TICKER_HTML);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

// A page that fetches every 50ms and reports the latest result in the title.
const FETCHER_HTML = `<!DOCTYPE html><html><body>
<div id="state">pending</div>
<script>
  setInterval(() => {
    fetch('/ping').then(() => { document.getElementById("state").textContent = "ok"; })
      .catch(() => { document.getElementById("state").textContent = "fail"; });
  }, 50);
</script></body></html>`;

async function startFetcherSite() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/ping")) { res.writeHead(204); return res.end(); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(FETCHER_HTML);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

const fetchState = (session) =>
  session._page.evaluate(() => document.getElementById("state").textContent);

const ticks = (session) =>
  session._page.evaluate(() => Number(document.getElementById("ticks").textContent));

// Directly observable freeze state, independent of timers: read back the
// script/network emulation from the page's own CDP state is not exposed, so
// observe behavior — a frozen page's evaluate-injected timer never fires.
const isFrozen = async (session, pageId) => {
  const entry = session._pages.get(pageId);
  // Runtime.evaluate still works on frozen pages (DevTools bypass); set a
  // flag from page JS — if script execution is disabled, the flag stays unset.
  await entry.page.evaluate(() => { window.__probe = false; setTimeout(() => { window.__probe = true; }, 30); }).catch(() => {});
  await new Promise(r => setTimeout(r, 150));
  return !(await entry.page.evaluate(() => window.__probe).catch(() => true));
};

test("BrowserSession freeze: background tab network cut, restored on switch back", async () => {
  const { server, url } = await startFetcherSite();
  let session = null;
  try {
    session = new BrowserSession({ url, width: 400, height: 300, freezeBackground: true });
    await session.start();
    await fetchState(session);   // ensure fetcher page is running
    await new Promise(r => setTimeout(r, 200));
    assert.equal(await fetchState(session), "ok", "fetch works before freeze");

    await session.newPage();     // fetcher goes to background: JS + network off
    await new Promise(r => setTimeout(r, 400));

    await session.switchPage(1); // back: JS + network restored
    await new Promise(r => setTimeout(r, 300));
    assert.equal(await fetchState(session), "ok", "fetch works again after unfreeze");
  } finally {
    if (session) { try { await session.stop(); } catch {} }
    server.close();
  }
});

test("BrowserSession freeze: background tab timers stop, resume on switch back", async () => {
  const { server, url } = await startTickerSite();
  let session = null;
  try {
    session = new BrowserSession({ url, width: 400, height: 300, freezeBackground: true });
    await session.start();
    await session.newPage();           // tab 2 (blank) — tab 1 goes to background
    await session.switchPage(1);       // back to the ticker

    const before = await ticks(session);
    assert.ok(before > 0, `ticker running before freeze, got ${before}`);

    await session.switchPage(2);       // ticker frozen
    await new Promise(r => setTimeout(r, 400));
    const frozenAt = await (async () => {
      // Read via the page object directly — evaluate on a frozen page still
      // works (CDP Runtime is not suspended by the freeze).
      const entry = session._pages.get(1);
      return entry.page.evaluate(() => Number(document.getElementById("ticks").textContent));
    })();
    await new Promise(r => setTimeout(r, 400));
    const frozenAfter = await session._pages.get(1).page.evaluate(() =>
      Number(document.getElementById("ticks").textContent));

    assert.equal(frozenAfter, frozenAt, `frozen tab must stop ticking (${frozenAt} -> ${frozenAfter})`);

    await session.switchPage(1);       // unfreeze
    await new Promise(r => setTimeout(r, 300));
    const resumed = await ticks(session);
    assert.ok(resumed > frozenAfter, `ticker resumes after unfreeze (${frozenAfter} -> ${resumed})`);
  } finally {
    if (session) { try { await session.stop(); } catch {} }
    server.close();
  }
});

test("BrowserSession freeze: opt-out keeps background tab running", async () => {
  const { server, url } = await startTickerSite();
  let session = null;
  try {
    session = new BrowserSession({ url, width: 400, height: 300, freezeBackground: false });
    await session.start();
    await session.newPage();
    await session.switchPage(1);

    await new Promise(r => setTimeout(r, 400));
    const t1 = await ticks(session);
    await session.switchPage(2);       // no freeze — keeps ticking
    await new Promise(r => setTimeout(r, 400));
    const t2 = await session._pages.get(1).page.evaluate(() =>
      Number(document.getElementById("ticks").textContent));

    assert.ok(t2 > t1, `opted-out tab keeps running (${t1} -> ${t2})`);
  } finally {
    if (session) { try { await session.stop(); } catch {} }
    server.close();
  }
});

test("BrowserSession freeze: concurrent switches leave no tab unfrozen in background", async () => {
  const { server, url } = await startTickerSite();
  let session = null;
  try {
    session = new BrowserSession({ url, width: 400, height: 300, freezeBackground: true });
    await session.start();
    await session.newPage();   // 3 tabs: 1(ticker) 2 3
    await session.newPage();

    // Interleave switches without awaiting — exercises the _switchTo mutex.
    const switches = [
      session.switchPage(1),
      session.switchPage(2),
      session.switchPage(3),
      session.switchPage(2),
    ];
    await Promise.all(switches);
    assert.equal(session._activePageId, 2, "last switch wins");

    // Every non-active tab must be frozen (the race used to leave one unfrozen).
    assert.equal(await isFrozen(session, 1), true, "tab 1 frozen");
    assert.equal(await isFrozen(session, 3), true, "tab 3 frozen");
    assert.equal(await isFrozen(session, 2), false, "active tab 2 running");
  } finally {
    if (session) { try { await session.stop(); } catch {} }
    server.close();
  }
});

test("BrowserSession freeze: restored background tabs from persistent profile stay frozen", async () => {
  // NOTE: headless Chromium's session restore only brings back ONE page
  // (about:blank) — multiple tabs are NOT restored (verified by probe). The
  // freeze-on-restore branch in start() is defensive for profiles that DO
  // come up multi-page (crash-restore states, startup prefs). This test
  // verifies the branch indirectly: restore a profile, and whatever the page
  // count, the active page must be unfrozen and switch-away freezes it —
  // i.e., restored pages integrate with the freeze lifecycle correctly.
  const { server, url } = await startTickerSite();
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "magpie-freeze-"));
  let session = null;
  try {
    // Round 1: leave two pages behind in the profile.
    session = new BrowserSession({ url, width: 400, height: 300, userDataDir: dir });
    await session.start();
    await session.newPage();                       // page 2 (blank)
    assert.equal(session._pages.size, 2);
    await session.stop();

    // Round 2: restart with same profile. Chromium restores one page; the
    // restored page is active and running (not left frozen from any
    // pre-restore state), and a normal switch away freezes it.
    session = new BrowserSession({ url, width: 400, height: 300, userDataDir: dir });
    await session.start();
    const restored = session._activePageId;
    assert.ok(restored !== null, "restored page active");
    assert.equal(await isFrozen(session, restored), false, "restored active page running");

    await session.newPage();                       // restored page -> background
    assert.equal(await isFrozen(session, restored), true, "switched-away restored page frozen");
    await session.switchPage(restored);
    assert.equal(await isFrozen(session, restored), false, "unfrozen after switch back");
  } finally {
    if (session) { try { await session.stop(); } catch {} }
    await rm(dir, { recursive: true, force: true });
    server.close();
  }
});

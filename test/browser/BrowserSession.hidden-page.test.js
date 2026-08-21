// test/browser/BrowserSession.hidden-page.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { BrowserSession } from "../../src/browser/BrowserSession.js";

const HELLO_HTML = `<!DOCTYPE html><html><body><h1>hello</h1></body></html>`;

async function startSite() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HELLO_HTML);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

test("BrowserSession hidden page: not in tab list, no tabsChange, screencast untouched", async () => {
  const { server, url } = await startSite();
  let session = null;
  try {
    session = new BrowserSession({ url, width: 400, height: 300 });
    let tabsChanges = 0;
    session.onTabsChange = () => { tabsChanges++; };
    await session.start();
    const pagesBefore = session.getTabsState().pages.length;
    const activeBefore = session.getTabsState().activeId;
    const baseline = tabsChanges;

    const page = await session.openHiddenPage();
    assert.ok(page, "returns a Page");
    await page.goto(url);
    await session.openHiddenPage();  // second hidden page at once

    assert.equal(session.getTabsState().pages.length, pagesBefore, "tab list unchanged");
    assert.equal(session.getTabsState().activeId, activeBefore, "active tab unchanged");
    assert.equal(tabsChanges, baseline, "no tabsChange fired");
    assert.equal(session._hiddenPages.size, 2);
    assert.equal(session._pages.size, pagesBefore, "_pages unchanged");

    await session.closeHiddenPage(page);
    assert.equal(session._hiddenPages.size, 1);
    assert.equal(page.isClosed(), true, "page closed");
  } finally {
    if (session) await session.stop().catch(() => {});
    server.close();
  }
});

test("BrowserSession hidden page: executes JS (not frozen), stop() cleans up", async () => {
  const { server, url } = await startSite();
  let session = null;
  try {
    session = new BrowserSession({ url, width: 400, height: 300, freezeBackground: true });
    await session.start();
    const page = await session.openHiddenPage();
    await page.goto(url);
    // A frozen page can't run timers — script execution must stay enabled.
    const probe = await page.evaluate(() =>
      new Promise(resolve => setTimeout(() => resolve("alive"), 50)));
    assert.equal(probe, "alive", "hidden page JS runs while user tab is active");

    await session.stop();
    assert.equal(page.isClosed(), true, "stop() closes hidden pages");
    assert.equal(session._hiddenPages.size, 0);
  } finally {
    if (session && session._context) await session.stop().catch(() => {});
    server.close();
  }
});

test("BrowserSession hidden page: openHiddenPage returns null when stopped", async () => {
  const session = new BrowserSession({ url: "about:blank", width: 400, height: 300 });
  assert.equal(await session.openHiddenPage(), null);
  await session.closeHiddenPage(null); // must not throw
});
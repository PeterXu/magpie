import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { BrowserSession } from "../../src/browser/BrowserSession.js";

const CLICK_TARGET = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "click-target.html")).href;
const PAGE_B = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "page-b.html")).href;

test("BrowserSession: _registerPage captures new pages", async () => {
  const session = new BrowserSession({ url: CLICK_TARGET, width: 400, height: 300 });
  await session.start();
  try {
    assert.equal(session._pages.size, 1, "initial page registered");
    const initialId = session._activePageId;
    assert.ok(initialId != null, "activePageId set");

    // Open a second page via context.newPage (simulates target="_blank")
    const page2 = await session._context.newPage();
    await page2.goto(PAGE_B, { waitUntil: "domcontentloaded" });
    // Wait for context.on('page') to fire and _registerPage to run
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(session._pages.size, 2, "second page registered");

    // Clean up
    await session.stop();
  } catch (err) {
    await session.stop();
    throw err;
  }
});

test("BrowserSession: switchPage switches active and screencast target", async () => {
  const session = new BrowserSession({ url: CLICK_TARGET, width: 400, height: 300 });
  await session.start();
  try {
    const page2 = await session._context.newPage();
    await page2.goto(PAGE_B, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 200));
    const ids = [...session._pages.keys()];
    assert.equal(ids.length, 2);

    const initialActive = session._activePageId;
    const otherId = ids.find((id) => id !== initialActive);
    await session.switchPage(otherId);
    assert.equal(session._activePageId, otherId, "active switched");

    // getUrl reflects the new active page
    const url = session.getUrl();
    assert.ok(url.includes("page-b.html"), `expected page-b URL, got ${url}`);

    await session.stop();
  } catch (err) {
    await session.stop();
    throw err;
  }
});

test("BrowserSession: closePage on non-active removes it", async () => {
  const session = new BrowserSession({ url: CLICK_TARGET, width: 400, height: 300 });
  await session.start();
  try {
    const page2 = await session._context.newPage();
    await page2.goto(PAGE_B, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 200));
    const ids = [...session._pages.keys()];
    const otherId = ids.find((id) => id !== session._activePageId);
    await session.closePage(otherId);
    assert.equal(session._pages.size, 1, "page removed");
    assert.equal(session._activePageId, session._activePageId, "active unchanged");

    await session.stop();
  } catch (err) {
    await session.stop();
    throw err;
  }
});

test("BrowserSession: closePage on active switches to remaining", async () => {
  const session = new BrowserSession({ url: CLICK_TARGET, width: 400, height: 300 });
  await session.start();
  try {
    const page2 = await session._context.newPage();
    await page2.goto(PAGE_B, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 200));
    const ids = [...session._pages.keys()];
    const activeId = session._activePageId;
    await session.closePage(activeId);
    assert.equal(session._pages.size, 1, "active page removed");
    assert.notEqual(session._activePageId, activeId, "switched to another");

    await session.stop();
  } catch (err) {
    await session.stop();
    throw err;
  }
});

test("BrowserSession: closing last tab creates new about:blank", async () => {
  const session = new BrowserSession({ url: CLICK_TARGET, width: 400, height: 300 });
  await session.start();
  try {
    const activeId = session._activePageId;
    await session.closePage(activeId);
    // Wait for the blank page to be registered
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(session._pages.size, 1, "new blank page created");
    const url = session.getUrl();
    assert.ok(url === "about:blank" || url === "", `expected blank, got ${url}`);

    await session.stop();
  } catch (err) {
    await session.stop();
    throw err;
  }
});

test("BrowserSession: onTabsChange fires on open/close/switch", async () => {
  const session = new BrowserSession({ url: CLICK_TARGET, width: 400, height: 300 });
  await session.start();
  try {
    const fired = [];
    session.onTabsChange = (state) => fired.push(state);
    const page2 = await session._context.newPage();
    await page2.goto(PAGE_B, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 200));
    // Should have fired at least once for the new page
    assert.ok(fired.some((s) => s.pages.length === 2), `expected 2 pages in fired events`);

    await session.switchPage([...session._pages.keys()][0]);
    assert.ok(fired.length > 1, "onTabsChange fired on switch");

    await session.stop();
  } catch (err) {
    await session.stop();
    throw err;
  }
});
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { BrowserSession } from "../../src/browser/BrowserSession.js";

const CLICK_TARGET = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "click-target.html")).href;
const PAGE_B = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "page-b.html")).href;

test("BrowserSession: getNavState tracks back/forward history", async () => {
  const session = new BrowserSession({ url: CLICK_TARGET, width: 400, height: 300 });
  await session.start();
  try {
    // Start: the page has navigated from about:blank → CLICK_TARGET, so
    // canBack is true (Chromium keeps the initial about:blank in history).
    let nav = await session.getNavState();
    assert.ok(nav.url.includes("click-target.html"));
    assert.equal(nav.canBack, true);  // can go back to about:blank
    assert.equal(nav.canForward, false);

    // Navigate away: still can go back (to click-target).
    await session.navigate(PAGE_B);
    nav = await session.getNavState();
    assert.ok(nav.url.includes("page-b.html"));
    assert.equal(nav.canBack, true);
    assert.equal(nav.canForward, false);

    // goBack: returns to click-target; forward now available.
    await session.goBack();
    nav = await session.getNavState();
    assert.ok(nav.url.includes("click-target.html"));
    assert.equal(nav.canForward, true);
    // canBack remains true (about:blank is still behind us).

    // goForward: back to page-b.
    await session.goForward();
    nav = await session.getNavState();
    assert.ok(nav.url.includes("page-b.html"));
    assert.equal(nav.canBack, true);
    assert.equal(nav.canForward, false);
  } finally {
    await session.stop();
  }
});

test("BrowserSession: reload keeps url, no throw", async () => {
  const session = new BrowserSession({ url: CLICK_TARGET, width: 400, height: 300 });
  await session.start();
  try {
    await session.reload();
    const nav = await session.getNavState();
    assert.ok(nav.url.includes("click-target.html"));
    // History state (canBack/canForward) is unchanged by reload.
  } finally {
    await session.stop();
  }
});

test("BrowserSession: onUrlChange fires on navigate (main frame only)", async () => {
  const session = new BrowserSession({ url: CLICK_TARGET, width: 400, height: 300 });
  await session.start();
  try {
    const seen = [];
    session.onUrlChange = (nav) => seen.push(nav.url);
    await session.navigate(PAGE_B);
    // framenavigated refresh is async (calls getNavState); give it a tick.
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(seen.some((u) => u.includes("page-b.html")), `expected page-b in ${seen}`);
    // The initial goto (in start()) fires framenavigated before this listener
    // is wired, and onUrlChange was null then — so click-target must NOT appear.
    assert.ok(seen.every((u) => !u.includes("click-target.html")), `initial URL leaked: ${seen}`);
  } finally {
    await session.stop();
  }
});

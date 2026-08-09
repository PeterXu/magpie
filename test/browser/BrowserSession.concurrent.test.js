import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { BrowserSession } from "../../src/browser/BrowserSession.js";

test("BrowserSession: rapid newPage() calls don't hang", async () => {
  const browser = await chromium.launch();
  const session = new BrowserSession({ url: "about:blank", width: 400, height: 300, browser });
  await session.start();

  try {
    // Record initial tab count
    const initialCount = session._pages.size;

    // Rapid fire newPage() calls (simulating fast clicking)
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(session.newPage());
    }

    // All should complete within reasonable time
    await Promise.race([
      Promise.all(promises),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 10000))
    ]);

    // Should have created at least one new tab
    // (concurrent calls are ignored, but at least one should succeed)
    assert.ok(session._pages.size > initialCount, "at least one new tab created");

    // Wait a bit for all operations to settle
    await new Promise(r => setTimeout(r, 500));

    // Should not hang - test completes successfully
  } finally {
    await session.stop();
    await browser.close();
  }
});

test("BrowserSession: concurrent newPage() with lock works correctly", async () => {
  const browser = await chromium.launch();
  const session = new BrowserSession({ url: "about:blank", width: 400, height: 300, browser });
  await session.start();

  try {
    // Start first newPage()
    const first = session.newPage();

    // Immediately start second (should be ignored due to lock)
    const second = session.newPage();

    // Both should complete without hanging
    await Promise.race([
      Promise.all([first, second]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000))
    ]);

    // Lock should prevent second creation
    // Only one new tab should be created
    assert.equal(session._pages.size, 2, "only one new tab created (lock worked)");

    // Lock should be released
    assert.equal(session._newPageInProgress, false, "lock released");
  } finally {
    await session.stop();
    await browser.close();
  }
});
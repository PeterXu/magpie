import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { BrowserSession } from "../../src/browser/BrowserSession.js";

const FIXTURE = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "click-target.html")).href;

test("BrowserSession: start + screencast yields JPEG frames", async () => {
  const session = new BrowserSession({ url: FIXTURE, width: 400, height: 300 });
  await session.start();
  try {
    const frames = [];
    await session.startScreencast((f) => frames.push(f));
    await new Promise((r) => setTimeout(r, 1500));
    await session.stopScreencast();
    assert.ok(frames.length > 0, "expected at least one screencast frame");
    assert.ok(frames[0].data.length > 0);
    assert.ok(frames[0].metadata.deviceWidth > 0);
  } finally {
    await session.stop();
  }
});

test("BrowserSession: navigate changes url", async () => {
  const session = new BrowserSession({ url: "about:blank", width: 400, height: 300 });
  await session.start();
  try {
    await session.navigate(FIXTURE);
    assert.ok(session.getUrl().includes("click-target.html"));
  } finally {
    await session.stop();
  }
});

test("BrowserSession: getViewport", () => {
  const session = new BrowserSession({ url: "about:blank", width: 500, height: 400 });
  assert.deepEqual(session.getViewport(), { width: 500, height: 400 });
});

test("BrowserSession: startScreencast forwards quality; passes no rate param", async () => {
  const session = new BrowserSession({ url: FIXTURE, width: 400, height: 300, screencast: { quality: 50 } });
  await session.start();
  try {
    const calls = [];
    const orig = session._cdp.send.bind(session._cdp);
    session._cdp.send = (method, params) => {
      if (method === "Page.startScreencast") calls.push(params);
      return orig(method, params);
    };
    await session.startScreencast(() => {});
    await session.stopScreencast();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].quality, 50);
    assert.equal(calls[0].maxWidth, 400);
    assert.equal(calls[0].maxHeight, 300);
    // Regression guard: everyNthFrame>1 starves static pages (see config.js),
    // and `every` was never a real CDP param. Neither must leak into the call.
    assert.equal(calls[0].everyNthFrame, undefined);
    assert.equal(calls[0].every, undefined);
  } finally {
    await session.stop();
  }
});

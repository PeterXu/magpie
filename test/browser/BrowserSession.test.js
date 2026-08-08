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

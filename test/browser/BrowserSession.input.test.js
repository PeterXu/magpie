import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { BrowserSession } from "../../src/browser/BrowserSession.js";

const FIXTURE = pathToFileURL(path.join(process.cwd(), "test", "fixtures", "click-target.html")).href;

test("BrowserSession: mouse click registers on the page", async () => {
  const session = new BrowserSession({ url: FIXTURE, width: 400, height: 300 });
  await session.start();
  try {
    await session.dispatchMouse({ x: 160, y: 130, type: "moved" });
    await session.dispatchMouse({ x: 160, y: 130, type: "pressed", button: "left", clickCount: 1 });
    await session.dispatchMouse({ x: 160, y: 130, type: "released", button: "left", clickCount: 1 });
    await session._page.waitForFunction(() => document.getElementById("count").textContent !== "0", { timeout: 2000 });
    const n = await session._page.evaluate(() => document.getElementById("count").textContent);
    assert.equal(n, "1");
  } finally {
    await session.stop();
  }
});

test("BrowserSession: key dispatch types into input", async () => {
  const session = new BrowserSession({ url: FIXTURE, width: 400, height: 300 });
  await session.start();
  try {
    await session.dispatchMouse({ x: 200, y: 220, type: "pressed", button: "left", clickCount: 1 });
    await session.dispatchMouse({ x: 200, y: 220, type: "released", button: "left", clickCount: 1 });
    await session.dispatchKey({ type: "keyDown", mapKey: { key: "h", code: "KeyH", windowsVirtualKeyCode: 72, text: "h" } });
    await session.dispatchKey({ type: "keyUp", mapKey: { key: "h", code: "KeyH", windowsVirtualKeyCode: 72, text: "" } });
    await session.dispatchKey({ type: "keyDown", mapKey: { key: "i", code: "KeyI", windowsVirtualKeyCode: 73, text: "i" } });
    await session.dispatchKey({ type: "keyUp", mapKey: { key: "i", code: "KeyI", windowsVirtualKeyCode: 73, text: "" } });
    const val = await session._page.evaluate(() => document.getElementById("inp").value);
    assert.equal(val, "hi");
  } finally {
    await session.stop();
  }
});

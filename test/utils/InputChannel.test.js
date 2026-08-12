import { test } from "node:test";
import assert from "node:assert/strict";
import { InputChannel } from "../../src/utils/InputChannel.js";

function fakeBrowserSession() {
  const calls = [];
  return {
    calls,
    dispatchMouse: (m) => calls.push({ kind: "mouse", ...m }),
    dispatchWheel: (m) => calls.push({ kind: "wheel", ...m }),
    dispatchKey: (m) => calls.push({ kind: "key", ...m }),
  };
}

const vp = { getViewport: () => ({ width: 1280, height: 800 }) };

test("InputChannel: maps + dispatches mouse", async () => {
  const bs = fakeBrowserSession();
  const ic = new InputChannel({ browserSession: bs, viewportProvider: vp });
  await ic.handle(JSON.stringify({ t: "mouse", x: 320, y: 200, displayW: 640, displayH: 400, type: "pressed", button: "left", clickCount: 1 }));
  assert.equal(bs.calls.length, 1);
  assert.equal(bs.calls[0].x, 640);
  assert.equal(bs.calls[0].y, 400);
});

test("InputChannel: maps + dispatches wheel", async () => {
  const bs = fakeBrowserSession();
  const ic = new InputChannel({ browserSession: bs, viewportProvider: vp });
  await ic.handle(JSON.stringify({ t: "wheel", x: 100, y: 100, displayW: 1280, displayH: 800, deltaY: -100 }));
  assert.equal(bs.calls.length, 1);
  assert.equal(bs.calls[0].deltaY, -100);
});

test("InputChannel: dispatches key", async () => {
  const bs = fakeBrowserSession();
  const ic = new InputChannel({ browserSession: bs, viewportProvider: vp });
  await ic.handle(JSON.stringify({ t: "key", type: "keyDown", key: "a", code: "KeyA", keyCode: 65 }));
  assert.equal(bs.calls.length, 1);
  assert.equal(bs.calls[0].mapKey.windowsVirtualKeyCode, 65);
});

test("InputChannel: guards mouse with displayW=0", async () => {
  const bs = fakeBrowserSession();
  const ic = new InputChannel({ browserSession: bs, viewportProvider: vp });
  await ic.handle(JSON.stringify({ t: "mouse", x: 320, y: 200, displayW: 0, displayH: 400, type: "pressed", button: "left", clickCount: 1 }));
  assert.equal(bs.calls.length, 0);
});

test("InputChannel: guards mouse with non-finite coords", async () => {
  const bs = fakeBrowserSession();
  const ic = new InputChannel({ browserSession: bs, viewportProvider: vp });
  await ic.handle(JSON.stringify({ t: "mouse", x: 320, y: 200, displayW: 0, displayH: 0, type: "pressed", button: "left", clickCount: 1 }));
  assert.equal(bs.calls.length, 0);
});

test("InputChannel: guards wheel with displayW=0", async () => {
  const bs = fakeBrowserSession();
  const ic = new InputChannel({ browserSession: bs, viewportProvider: vp });
  await ic.handle(JSON.stringify({ t: "wheel", x: 100, y: 100, displayW: 0, displayH: 800, deltaY: -100 }));
  assert.equal(bs.calls.length, 0);
});

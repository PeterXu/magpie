import { test } from "node:test";
import assert from "node:assert/strict";
import { mapKey, parseInputMessage } from "../../src/webrtc/keys.js";

test("mapKey: letter a", () => {
  const d = mapKey({ key: "a", code: "KeyA", keyCode: 65 });
  assert.equal(d.windowsVirtualKeyCode, 65);
  assert.equal(d.code, "KeyA");
  assert.equal(d.text, "a");
});

test("mapKey: Enter", () => {
  const d = mapKey({ key: "Enter", code: "Enter", keyCode: 13 });
  assert.equal(d.windowsVirtualKeyCode, 13);
  assert.equal(d.text, "\r");
});

test("mapKey: unknown code falls back to keyCode", () => {
  const d = mapKey({ key: "x", code: "UnknownX", keyCode: 88 });
  assert.equal(d.windowsVirtualKeyCode, 88);
});

test("parseInputMessage: mouse", () => {
  const e = parseInputMessage(JSON.stringify({ t: "mouse", x: 10, y: 20, displayW: 100, displayH: 100, type: "pressed", button: "left", clickCount: 1 }));
  assert.equal(e.kind, "mouse");
  assert.equal(e.type, "pressed");
});

test("parseInputMessage: key", () => {
  const e = parseInputMessage(JSON.stringify({ t: "key", type: "keyDown", key: "a", code: "KeyA", keyCode: 65 }));
  assert.equal(e.kind, "key");
  assert.equal(e.code, "KeyA");
});

test("parseInputMessage: throws on bad JSON", () => {
  assert.throws(() => parseInputMessage("not json"));
});

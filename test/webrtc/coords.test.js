import { test } from "node:test";
import assert from "node:assert/strict";
import { mapClientToPage } from "../../src/webrtc/coords.js";

test("mapClientToPage: identity when display == page", () => {
  const r = mapClientToPage({ clientX: 640, clientY: 400, displayW: 1280, displayH: 800, pageW: 1280, pageH: 800 });
  assert.equal(r.x, 640);
  assert.equal(r.y, 400);
});

test("mapClientToPage: scales when display is half size", () => {
  const r = mapClientToPage({ clientX: 320, clientY: 200, displayW: 640, displayH: 400, pageW: 1280, pageH: 800 });
  assert.equal(r.x, 640);
  assert.equal(r.y, 400);
});

test("mapClientToPage: rounds fractional coords", () => {
  const r = mapClientToPage({ clientX: 160.5, clientY: 100, displayW: 640, displayH: 400, pageW: 1280, pageH: 800 });
  assert.equal(r.x, 321);
  assert.equal(r.y, 200);
});

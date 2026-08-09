import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, defaultBitrate, resolveMaxBitrate } from "../src/config.js";

test("loadConfig: defaults when env empty", () => {
  const c = loadConfig({});
  assert.deepEqual(c.viewport, { width: 1280, height: 800 });
  assert.deepEqual(c.screencast, { quality: 80 });
  assert.deepEqual(c.webrtc, {
    streamFps: 10,
    maxBitrate: 2560000,                 // adaptive default for 1280x800
    maxFramerate: null,
    degradation: "maintain-resolution",  // flipped default
  });
});

test("loadConfig: MAGPIE_FPS drives streamFps (captureStream), not CDP rate", () => {
  // MAGPIE_FPS no longer touches CDP screencast — everyNthFrame would starve
  // static pages, so screencast carries only quality. fps caps output via
  // canvas.captureStream(fps) on the streamer page.
  const c = loadConfig({ MAGPIE_FPS: "30" });
  assert.equal(c.webrtc.streamFps, 30);
  assert.deepEqual(c.screencast, { quality: 80 });
});

test("loadConfig: MAGPIE_FPS=0 clamps to 1", () => {
  const c = loadConfig({ MAGPIE_FPS: "0" });
  assert.equal(c.webrtc.streamFps, 1);
});

test("loadConfig: MAGPIE_FPS non-numeric falls back to default", () => {
  const c = loadConfig({ MAGPIE_FPS: "abc" });
  assert.equal(c.webrtc.streamFps, 10);
});

test("loadConfig: MAGPIE_QUALITY clamps / falls back", () => {
  assert.equal(loadConfig({ MAGPIE_QUALITY: "150" }).screencast.quality, 100);
  assert.equal(loadConfig({ MAGPIE_QUALITY: "0" }).screencast.quality, 1);
  assert.equal(loadConfig({ MAGPIE_QUALITY: "abc" }).screencast.quality, 80);
});

test("loadConfig: MAGPIE_WIDTH/HEIGHT clamp to range", () => {
  assert.equal(loadConfig({ MAGPIE_WIDTH: "99999" }).viewport.width, 3840);
  assert.equal(loadConfig({ MAGPIE_WIDTH: "10" }).viewport.width, 320);
  assert.equal(loadConfig({ MAGPIE_HEIGHT: "99999" }).viewport.height, 3840);
});

test("defaultBitrate: resolution-driven, clamped to [1.5M, 8M]", () => {
  assert.equal(defaultBitrate(1280, 800), 2560000);
  assert.equal(defaultBitrate(1920, 1080), 5184000);
  assert.equal(defaultBitrate(2560, 1440), 8000000);   // ceiling
  assert.equal(defaultBitrate(3840, 2160), 8000000);   // ceiling
  assert.equal(defaultBitrate(640, 480), 1500000);     // floor
});

test("resolveMaxBitrate: unset/empty -> adaptive default", () => {
  assert.equal(resolveMaxBitrate(undefined, 1280, 800), 2560000);
  assert.equal(resolveMaxBitrate(null, 1280, 800), 2560000);
  assert.equal(resolveMaxBitrate("", 1920, 1080), 5184000);
});

test("resolveMaxBitrate: numeric forms -> bps", () => {
  assert.equal(resolveMaxBitrate("2500000", 1280, 800), 2500000);
  assert.equal(resolveMaxBitrate("2500k", 1280, 800), 2500000);
  assert.equal(resolveMaxBitrate("2.5m", 1280, 800), 2500000);
});

test("resolveMaxBitrate: disable sentinels (<=0 / none / off) -> null", () => {
  assert.equal(resolveMaxBitrate("0", 1280, 800), null);
  assert.equal(resolveMaxBitrate("0k", 1280, 800), null);
  assert.equal(resolveMaxBitrate("0m", 1280, 800), null);
  assert.equal(resolveMaxBitrate("none", 1280, 800), null);
  assert.equal(resolveMaxBitrate("OFF", 1280, 800), null);
});

test("resolveMaxBitrate: invalid non-numeric -> fallback default (warn)", () => {
  assert.equal(resolveMaxBitrate("abc", 1280, 800), 2560000);
});

test("loadConfig: MAGPIE_MAX_BITRATE end-to-end", () => {
  assert.equal(loadConfig({ MAGPIE_MAX_BITRATE: "3m" }).webrtc.maxBitrate, 3000000);
  assert.equal(loadConfig({}).webrtc.maxBitrate, 2560000);                 // adaptive default
  assert.equal(loadConfig({ MAGPIE_MAX_BITRATE: "0" }).webrtc.maxBitrate, null);        // disable
  assert.equal(loadConfig({ MAGPIE_MAX_BITRATE: "none" }).webrtc.maxBitrate, null);     // disable
  assert.equal(loadConfig({ MAGPIE_MAX_BITRATE: "abc" }).webrtc.maxBitrate, 2560000);   // fallback
});

test("loadConfig: MAGPIE_MAX_FRAMERATE", () => {
  assert.equal(loadConfig({ MAGPIE_MAX_FRAMERATE: "24" }).webrtc.maxFramerate, 24);
  assert.equal(loadConfig({ MAGPIE_MAX_FRAMERATE: "0" }).webrtc.maxFramerate, null);
  assert.equal(loadConfig({ MAGPIE_MAX_FRAMERATE: "abc" }).webrtc.maxFramerate, null);
});

test("loadConfig: MAGPIE_DEGRADATION enum + flipped default", () => {
  assert.equal(loadConfig({ MAGPIE_DEGRADATION: "balanced" }).webrtc.degradation, "balanced");
  assert.equal(loadConfig({ MAGPIE_DEGRADATION: "maintain-framerate" }).webrtc.degradation, "maintain-framerate");
  assert.equal(loadConfig({}).webrtc.degradation, "maintain-resolution");               // new default
  assert.equal(loadConfig({ MAGPIE_DEGRADATION: "foo" }).webrtc.degradation, "maintain-resolution"); // bad -> default
});

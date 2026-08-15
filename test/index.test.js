import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStreamerUrl } from "../src/config.js";

test("buildStreamerUrl: w/h/fps always present; caps only when set", () => {
  const url = buildStreamerUrl("http://127.0.0.1:8080", "streamer.html", {
    viewport: { width: 1280, height: 800 },
    screencast: { quality: 80 },
    webrtc: { streamFps: 10, maxBitrate: null, maxFramerate: null, degradation: null },
  });
  assert.equal(url, "http://127.0.0.1:8080/streamer.html?w=1280&h=800&fps=10");
});

test("buildStreamerUrl: includes bitrate/maxFps/degradation when set", () => {
  const url = buildStreamerUrl("http://h:1", "streamer.html", {
    viewport: { width: 640, height: 480 },
    screencast: { quality: 80 },
    webrtc: { streamFps: 20, maxBitrate: 2500000, maxFramerate: 15, degradation: "maintain-resolution" },
  });
  assert.equal(url, "http://h:1/streamer.html?w=640&h=480&fps=20&bitrate=2500000&maxFps=15&degradation=maintain-resolution");
});

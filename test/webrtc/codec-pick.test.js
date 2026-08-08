import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCodec } from "../../src/webrtc/codec-pick.js";

test("pickCodec: both have av1 -> av1", () => {
  assert.equal(pickCodec(["av1", "vp9", "vp8", "h264"], ["av1", "vp9", "vp8", "h264"]), "av1");
});

test("pickCodec: magpie lacks av1 -> vp9", () => {
  assert.equal(pickCodec(["vp9", "vp8", "h264"], ["av1", "vp9", "vp8", "h264"]), "vp9");
});

test("pickCodec: client lacks av1 -> vp9", () => {
  assert.equal(pickCodec(["av1", "vp9", "vp8"], ["vp9", "vp8", "h264"]), "vp9");
});

test("pickCodec: only vp8+h264 shared -> vp8", () => {
  assert.equal(pickCodec(["vp8", "h264"], ["vp8", "h264"]), "vp8");
});

test("pickCodec: only h264 shared -> h264", () => {
  assert.equal(pickCodec(["h264"], ["h264"]), "h264");
});

test("pickCodec: no intersection in chain -> null", () => {
  assert.equal(pickCodec(["av1"], ["vp9"]), null);
});

test("pickCodec: empty / null inputs -> null", () => {
  assert.equal(pickCodec([], ["av1"]), null);
  assert.equal(pickCodec(null, null), null);
  assert.equal(pickCodec(undefined, undefined), null);
});

test("pickCodec: case-insensitive", () => {
  assert.equal(pickCodec(["AV1"], ["av1"]), "av1");
});

test("pickCodec: custom chain honored", () => {
  assert.equal(pickCodec(["x", "y"], ["x"], ["x", "y"]), "x");
});

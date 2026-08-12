import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIceServers } from "../../src/utils/ice-servers.js";

test("buildIceServers: empty when missing creds/host", () => {
  assert.deepEqual(buildIceServers({ host: "coturn" }), []);
  assert.deepEqual(buildIceServers({ host: "coturn", user: "u" }), []);
  assert.deepEqual(buildIceServers({ user: "u", pass: "p" }), []);
});

test("buildIceServers: stun + turn when complete", () => {
  const s = buildIceServers({ host: "coturn", user: "u", pass: "p" });
  assert.equal(s.length, 2);
  assert.equal(s[0].urls, "stun:coturn:3478");
  assert.equal(s[1].urls, "turn:coturn:3478");
  assert.equal(s[1].username, "u");
  assert.equal(s[1].credential, "p");
});

test("buildIceServers: custom port", () => {
  const s = buildIceServers({ host: "h", user: "u", pass: "p", port: 3478 });
  assert.equal(s[0].urls, "stun:h:3478");
});

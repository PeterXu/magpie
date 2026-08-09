import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createServer } from "../src/server.js";

function startWithMocks() {
  const browserSession = {
    getViewport: () => ({ width: 1280, height: 800 }),
    getUrl: () => "https://gitee.com",
    navigate: async (url) => { browserSession._lastNav = url; },
    goBack: async () => { browserSession._back = (browserSession._back || 0) + 1; },
    goForward: async () => { browserSession._fwd = (browserSession._fwd || 0) + 1; },
    reload: async () => { browserSession._reload = (browserSession._reload || 0) + 1; },
    getNavState: async () => ({ url: "https://gitee.com", canBack: true, canForward: false }),
    _lastNav: null,
  };
  const inputChannel = { handle: () => {} };
  const streamerPeer = { relayOffer: async () => "ANSWER-FROM-MOCK", setFrameSocket: () => {}, pushFrame: () => {}, stop: async () => {}, getSenderCodecs: () => ["av1", "vp9", "vp8", "h264"] };
  const server = createServer({ browserSession, inputChannel, streamerPeer });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, browserSession, port: server.address().port })));
}

test("server: GET /healthz returns ok", async () => {
  const { server, port } = await startWithMocks();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  } finally { server.close(); }
});

test("server: GET / serves client.html with a <video>", async () => {
  const { server, port } = await startWithMocks();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("<video"));
  } finally { server.close(); }
});

test("server: signaling handles offer/navigate/back/forward/refresh; hello carries nav state", async () => {
  const { server, port, browserSession } = await startWithMocks();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/signaling`, { perMessageDeflate: false });
  const received = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.on("open", r));
  try {
    ws.send(JSON.stringify({ t: "offer", sdp: "v=0" }));
    ws.send(JSON.stringify({ t: "navigate", url: "https://example.com" }));
    ws.send(JSON.stringify({ t: "back" }));
    ws.send(JSON.stringify({ t: "forward" }));
    ws.send(JSON.stringify({ t: "refresh" }));
    ws.send(JSON.stringify({ t: "status" }));
    await new Promise((r) => setTimeout(r, 300));
    const types = received.map((m) => m.t);
    const hello = received.find((m) => m.t === "hello");
    assert.ok(hello, "expected hello");
    assert.equal(hello.canBack, true);
    assert.equal(hello.canForward, false);
    assert.ok(types.includes("answer"));
    assert.equal(received.find((m) => m.t === "answer").sdp, "ANSWER-FROM-MOCK");
    assert.equal(browserSession._lastNav, "https://example.com");
    assert.equal(browserSession._back, 1);
    assert.equal(browserSession._fwd, 1);
    assert.equal(browserSession._reload, 1);
    // navigate-result was removed: nav state is broadcast via framenavigated
    // (wired in index.js), not echoed by the navigate handler.
    assert.ok(!types.includes("navigate-result"), "navigate-result should be gone");
    assert.ok(types.includes("status"));
  } finally {
    ws.close();
    server.close();
  }
});

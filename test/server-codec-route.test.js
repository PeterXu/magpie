import { test } from "node:test";
import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { WebSocketManager } from "../src/websocket/WebSocketManager.js";

test("server: serves /codec-pick.js as text/javascript with the pickCodec export", async () => {
  // Create WebSocket manager
  const wsManager = new WebSocketManager();

  // Create Hono app with minimal mocks and empty auth config
  const { app } = createApp({
    browserSession: {},
    inputChannel: {},
    streamerPeer: { getSenderCodecs: () => [] },
    clientIceServers: [],
    wsManager,
    env: {
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: '',  // Empty password disables auth
      JWT_SECRET: 'test-secret',
      JWT_EXPIRES_IN: 86400
    }
  });

  // Start server
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });

  // Wait for server to be ready
  await new Promise((resolve) => {
    server.on('listening', resolve);
  });

  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/codec-pick.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/javascript");
    const body = await res.text();
    assert.match(body, /export function pickCodec/);
  } finally {
    server.close();
  }
});

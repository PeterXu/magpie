import { test } from "node:test";
import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { WebSocketManager } from "../src/websocket/WebSocketManager.js";
import { SessionHandler } from '../src/handlers/signaling/SessionHandler.js';

test("server: serves /cursor.svg as image/svg+xml", async () => {
  // Create WebSocket manager
  const wsManager = new WebSocketManager();

  // Create Session handler
  const sessionHandler = new SessionHandler({
    browserSession: {},
    streamerPeer: { getSenderCodecs: () => [] },
    inputChannel: {},
    clientIceServers: []
  });

  // Create Hono app with minimal mocks and empty auth config
  const { app } = createApp({
    streamerPeer: { getSenderCodecs: () => [] },
    sessionHandler,
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
    const res = await fetch(`http://127.0.0.1:${port}/cursor.svg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/svg+xml");
    const body = await res.text();
    assert.match(body, /<svg/);
    assert.match(body, /#0d9488/);  // teal — the distinct-from-OS accent
  } finally {
    server.close();
  }
});

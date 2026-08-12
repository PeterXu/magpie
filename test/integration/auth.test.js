import { test } from "node:test";
import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import { createApp } from "../../src/app.js";
import { WebSocketManager } from "../../src/websocket/WebSocketManager.js";
import { Jwt } from "hono/utils/jwt";

/**
 * Start server with auth configuration for testing
 */
function startTestServer(env = {}) {
  const browserSession = {
    getViewport: () => ({ width: 1280, height: 800 }),
    getUrl: () => "https://example.com",
    navigate: async () => {},
    getNavState: async () => ({ url: "https://example.com", canBack: false, canForward: false }),
    getTabsState: () => ({ pages: [{ id: "page-1", url: "https://example.com", title: "Example", active: true }], activeId: "page-1" }),
  };
  const inputChannel = { handle: () => {} };
  const streamerPeer = {
    relayOffer: async () => ({ sdp: "ANSWER-FROM-MOCK" }),
    setFrameSocket: () => {},
    pushFrame: () => {},
    stop: async () => {},
    getSenderCodecs: () => ["av1", "vp9", "vp8", "h264"]
  };

  const wsManager = new WebSocketManager();

  // Merge test env with defaults
  const testEnv = {
    ADMIN_USER: env.ADMIN_USER || "admin",
    ADMIN_PASSWORD: env.ADMIN_PASSWORD || "test-password-123",
    JWT_SECRET: env.JWT_SECRET || "test-secret-key-12345",
    JWT_EXPIRES_IN: env.JWT_EXPIRES_IN || 86400,
    ...env
  };

  const { app, wsRoutes } = createApp({
    browserSession,
    inputChannel,
    streamerPeer,
    clientIceServers: [],
    wsManager,
    env: testEnv
  });

  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });

  // Handle WebSocket upgrades
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);

    for (const { wsServer, path } of wsRoutes) {
      if (pathname === path) {
        wsServer.handleUpgrade(request, socket, head, (ws) => {
          wsServer.emit('connection', ws, request);
        });
        return;
      }
    }

    socket.destroy();
  });

  return new Promise((resolve) => {
    server.on('listening', () => {
      resolve({
        server,
        port: server.address().port,
        env: testEnv
      });
    });
  });
}

test("auth: unauthenticated request to protected route returns 401", async () => {
  const { server, port } = await startTestServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Missing authorization token");
  } finally {
    server.close();
  }
});

test("auth: login with valid credentials returns token", async () => {
  const { server, port, env } = await startTestServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: env.ADMIN_USER,
        password: env.ADMIN_PASSWORD
      })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.token, "should return a token");
    assert.ok(body.expiresIn, "should return expiresIn");
    assert.equal(body.user.username, env.ADMIN_USER);
    assert.equal(body.user.role, "admin");

    // Verify token is valid
    const payload = await Jwt.verify(body.token, env.JWT_SECRET, "HS256");
    assert.equal(payload.sub, env.ADMIN_USER);
    assert.equal(payload.role, "admin");
  } finally {
    server.close();
  }
});

test("auth: login with invalid credentials returns 401", async () => {
  const { server, port } = await startTestServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "wrong-password"
      })
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Invalid credentials");
  } finally {
    server.close();
  }
});

test("auth: authenticated request with valid token returns 200", async () => {
  const { server, port, env } = await startTestServer();
  try {
    // First, login to get token
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: env.ADMIN_USER,
        password: env.ADMIN_PASSWORD
      })
    });

    const { token } = await loginRes.json();

    // Use token to access protected route
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("<video"), "should return client.html");
  } finally {
    server.close();
  }
});

test("auth: request with invalid token returns 401", async () => {
  const { server, port } = await startTestServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: {
        "Authorization": "Bearer invalid-token-12345"
      }
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Invalid or expired token");
  } finally {
    server.close();
  }
});

test("auth: login page is publicly accessible", async () => {
  const { server, port } = await startTestServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/login.html`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("<title>magpie - 登录</title>"), "should return login page");
    assert.ok(html.includes('id="loginForm"'), "should contain login form");
  } finally {
    server.close();
  }
});

test("auth: healthz endpoint is publicly accessible", async () => {
  const { server, port } = await startTestServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  } finally {
    server.close();
  }
});

test("auth: empty ADMIN_PASSWORD skips authentication (test mode)", async () => {
  const { server, port } = await startTestServer({
    ADMIN_PASSWORD: ""  // Empty password = test mode
  });
  try {
    // Should allow access without token when password is empty
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("<video"), "should return client.html");
  } finally {
    server.close();
  }
});

test("auth: login with wrong username returns 401", async () => {
  const { server, port } = await startTestServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "wrong-user",
        password: "test-password-123"
      })
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Invalid credentials");
  } finally {
    server.close();
  }
});

test("auth: multiple requests with same token work", async () => {
  const { server, port, env } = await startTestServer();
  try {
    // Login to get token
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: env.ADMIN_USER,
        password: env.ADMIN_PASSWORD
      })
    });

    const { token } = await loginRes.json();

    // Make multiple requests with the same token
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });
      assert.equal(res.status, 200, `request ${i + 1} should succeed`);
    }
  } finally {
    server.close();
  }
});
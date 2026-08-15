import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketManager } from "../src/websocket/WebSocketManager.js";
import { EventEmitter } from "events";

// Mock WebSocket
class MockWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1; // OPEN
    this.OPEN = 1;
    this.peerId = null;
  }

  send(msg) {
    // Mock send
  }

  close() {
    this.readyState = 0; // CLOSED
    this.emit('close');
  }
}

test("WebSocketManager: is an EventEmitter", () => {
  const wsManager = new WebSocketManager();
  assert.ok(wsManager instanceof EventEmitter);
});

test("WebSocketManager: starts with empty clients", () => {
  const wsManager = new WebSocketManager();
  assert.equal(wsManager.clients.size, 0);
});

test("WebSocketManager: add() adds client to set", () => {
  const wsManager = new WebSocketManager();
  const ws = new MockWebSocket();

  wsManager.add(ws);
  assert.equal(wsManager.clients.size, 1);
  assert.ok(wsManager.clients.has(ws));
});

test("WebSocketManager: add() emits connection-change event with count 1", () => {
  const wsManager = new WebSocketManager();
  const ws = new MockWebSocket();

  let eventCount = null;
  wsManager.on('connection-change', (count) => {
    eventCount = count;
  });

  wsManager.add(ws);
  assert.equal(eventCount, 1);
});

test("WebSocketManager: multiple adds emit correct counts", () => {
  const wsManager = new WebSocketManager();

  const counts = [];
  wsManager.on('connection-change', (count) => {
    counts.push(count);
  });

  const ws1 = new MockWebSocket();
  const ws2 = new MockWebSocket();
  const ws3 = new MockWebSocket();

  wsManager.add(ws1);
  wsManager.add(ws2);
  wsManager.add(ws3);

  assert.deepEqual(counts, [1, 2, 3]);
});

test("WebSocketManager: remove on close emits connection-change event", () => {
  const wsManager = new WebSocketManager();
  const ws = new MockWebSocket();

  const counts = [];
  wsManager.on('connection-change', (count) => {
    counts.push(count);
  });

  wsManager.add(ws);
  ws.close(); // Trigger close event

  assert.deepEqual(counts, [1, 0]);
  assert.equal(wsManager.clients.size, 0);
});

test("WebSocketManager: multiple clients, one closes emits correct count", () => {
  const wsManager = new WebSocketManager();

  const counts = [];
  wsManager.on('connection-change', (count) => {
    counts.push(count);
  });

  const ws1 = new MockWebSocket();
  const ws2 = new MockWebSocket();
  const ws3 = new MockWebSocket();

  wsManager.add(ws1);
  wsManager.add(ws2);
  wsManager.add(ws3);
  ws2.close(); // Close middle one

  assert.deepEqual(counts, [1, 2, 3, 2]);
  assert.equal(wsManager.clients.size, 2);
});

test("WebSocketManager: broadcast sends to all clients with peerId", () => {
  const wsManager = new WebSocketManager();

  const messages = [];
  class MockWSWithSend extends MockWebSocket {
    send(msg) {
      messages.push({ peerId: this.peerId, msg });
    }
  }

  const ws1 = new MockWSWithSend();
  ws1.peerId = 'peer1';
  const ws2 = new MockWSWithSend();
  ws2.peerId = 'peer2';
  const ws3 = new MockWSWithSend(); // No peerId

  wsManager.add(ws1);
  wsManager.add(ws2);
  wsManager.add(ws3);

  wsManager.broadcast({ type: 'test' });

  // Only ws1 and ws2 should receive (has peerId)
  assert.equal(messages.length, 2);
  assert.equal(messages[0].peerId, 'peer1');
  assert.equal(messages[1].peerId, 'peer2');
  assert.equal(JSON.parse(messages[0].msg).type, 'test');
});

test("WebSocketManager: broadcast handles send errors gracefully", () => {
  const wsManager = new WebSocketManager();

  const ws1 = new MockWebSocket();
  ws1.peerId = 'peer1';
  ws1.send = () => {
    throw new Error("Send failed");
  };

  const ws2 = new MockWebSocket();
  ws2.peerId = 'peer2';
  const messages = [];
  ws2.send = (msg) => messages.push(msg);

  wsManager.add(ws1);
  wsManager.add(ws2);

  // Should not throw
  wsManager.broadcast({ type: 'test' });
  assert.equal(messages.length, 1); // ws2 still received
});

test("WebSocketManager: setPeer sets peerId on websocket", () => {
  const wsManager = new WebSocketManager();
  const ws = new MockWebSocket();

  wsManager.setPeer('test-peer-id', ws);
  assert.equal(ws.peerId, 'test-peer-id');
});

test("WebSocketManager: forwardPeer sends only to matching peer", () => {
  const wsManager = new WebSocketManager();

  const messages = [];
  class MockWSWithSend extends MockWebSocket {
    send(msg) {
      messages.push({ peerId: this.peerId, msg });
    }
  }

  const ws1 = new MockWSWithSend();
  ws1.peerId = 'peer1';
  const ws2 = new MockWSWithSend();
  ws2.peerId = 'peer2';

  wsManager.add(ws1);
  wsManager.add(ws2);

  messages.length = 0; // Clear previous messages
  wsManager.forwardPeer('peer1', { type: 'forward' });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].peerId, 'peer1');
  assert.equal(JSON.parse(messages[0].msg).type, 'forward');
});

test("WebSocketManager: forwardPeer does nothing if peer not found", () => {
  const wsManager = new WebSocketManager();

  const messages = [];
  class MockWSWithSend extends MockWebSocket {
    send(msg) {
      messages.push(msg);
    }
  }

  const ws1 = new MockWSWithSend();
  ws1.peerId = 'peer1';
  wsManager.add(ws1);

  // Should not throw
  wsManager.forwardPeer('nonexistent', { type: 'test' });
  assert.equal(messages.length, 0);
});

test("WebSocketManager: destory closes all connections and clears set", () => {
  const wsManager = new WebSocketManager();

  const ws1 = new MockWebSocket();
  const ws2 = new MockWebSocket();

  wsManager.add(ws1);
  wsManager.add(ws2);

  assert.equal(wsManager.clients.size, 2);

  wsManager.destory();

  assert.equal(wsManager.clients.size, 0);
});

test("WebSocketManager: connection-change event fires for 0 clients on startup", () => {
  const wsManager = new WebSocketManager();

  // This test verifies that we can listen before any connections
  let initialCount = -1;
  wsManager.on('connection-change', (count) => {
    initialCount = count;
  });

  // No connections yet
  assert.equal(initialCount, -1);

  // Add first connection
  const ws = new MockWebSocket();
  wsManager.add(ws);
  assert.equal(initialCount, 1);
});

test("WebSocketManager: handles rapid connect/disconnect", () => {
  const wsManager = new WebSocketManager();

  const counts = [];
  wsManager.on('connection-change', (count) => {
    counts.push(count);
  });

  // Rapid add/remove
  for (let i = 0; i < 10; i++) {
    const ws = new MockWebSocket();
    wsManager.add(ws);
    ws.close();
  }

  // Should see [1, 0, 1, 0, ...] pattern
  assert.equal(counts.length, 20);
  for (let i = 0; i < 20; i += 2) {
    assert.equal(counts[i], 1);
    assert.equal(counts[i + 1], 0);
  }
});
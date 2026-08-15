import { test } from "node:test";
import assert from "node:assert/strict";
import { IdleTimeoutManager } from "../src/utils/IdleTimeoutManager.js";

// Mock implementations
class MockBrowserSession {
  constructor() {
    this.started = false;
    this.screencastStarted = false;
    this.stopped = false;
    this.startCallCount = 0;
    this.stopCallCount = 0;
    this.startScreencastCallCount = 0;
  }

  async start() {
    this.started = true;
    this.startCallCount++;
  }

  async stop() {
    this.stopped = true;
    this.stopCallCount++;
  }

  async startScreencast(callback) {
    this.screencastStarted = true;
    this.startScreencastCallCount++;
  }

  getBrowser() {
    return {};
  }
}

class MockStreamerPeer {
  constructor() {
    this.frames = [];
  }

  pushFrame(frame) {
    this.frames.push(frame);
  }
}

test("IdleTimeoutManager: constructor with default timeout", () => {
  const browserSession = new MockBrowserSession();
  const manager = new IdleTimeoutManager({ browserSession });

  assert.equal(manager._timeoutMinutes, 30);
  assert.equal(manager._lastDisconnectTime, null);
  assert.equal(manager._browserStopped, false);
});

test("IdleTimeoutManager: constructor with custom timeout", () => {
  const browserSession = new MockBrowserSession();
  const streamerPeer = new MockStreamerPeer();
  const manager = new IdleTimeoutManager({ browserSession, timeoutMinutes: 10 });

  assert.equal(manager._timeoutMinutes, 10);
});

test("IdleTimeoutManager: start creates interval when timeout > 0", () => {
  const browserSession = new MockBrowserSession();
  const streamerPeer = new MockStreamerPeer();
  const manager = new IdleTimeoutManager({ browserSession, timeoutMinutes: 30 });

  manager.start();
  assert.ok(manager._checkInterval);
  manager.stop();
});

test("IdleTimeoutManager: start does nothing when timeout <= 0", () => {
  const browserSession = new MockBrowserSession();
  const streamerPeer = new MockStreamerPeer();
  const manager = new IdleTimeoutManager({ browserSession, timeoutMinutes: 0 });

  manager.start();
  assert.equal(manager._checkInterval, null);
  manager.stop();
});

test("IdleTimeoutManager: stop clears interval", () => {
  const browserSession = new MockBrowserSession();
  const streamerPeer = new MockStreamerPeer();
  const manager = new IdleTimeoutManager({ browserSession, timeoutMinutes: 30 });

  manager.start();
  assert.ok(manager._checkInterval);
  manager.stop();
  assert.equal(manager._checkInterval, null);
});

test("IdleTimeoutManager: handleConnectionChange with 0 clients sets disconnect time", async () => {
  const browserSession = new MockBrowserSession();
  const streamerPeer = new MockStreamerPeer();
  const manager = new IdleTimeoutManager({ browserSession });

  await manager.handleConnectionChange(0);
  assert.ok(manager._lastDisconnectTime !== null);
});

test("IdleTimeoutManager: handleConnectionChange with clients clears disconnect time", async () => {
  const browserSession = new MockBrowserSession();
  const streamerPeer = new MockStreamerPeer();
  const manager = new IdleTimeoutManager({ browserSession });

  // First disconnect
  await manager.handleConnectionChange(0);
  assert.ok(manager._lastDisconnectTime !== null);

  // Then connect
  await manager.handleConnectionChange(1);
  assert.equal(manager._lastDisconnectTime, null);
});

test("IdleTimeoutManager: handleConnectionChange triggers onRestart when stopped", async () => {
  const browserSession = new MockBrowserSession();
  const manager = new IdleTimeoutManager({ browserSession });

  let restartCalled = false;
  manager.onRestart = async () => {
    restartCalled = true;
    browserSession.startCallCount++;
    browserSession.startScreencastCallCount++;
  };

  // Mark browser as stopped
  manager._browserStopped = true;

  // Connection change should trigger restart callback
  manager.handleConnectionChange(1);

  // Wait for async callback
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(restartCalled, true);
  assert.equal(browserSession.startCallCount, 1);
  assert.equal(manager._browserStopped, false);
});

test("IdleTimeoutManager: handleConnectionChange does not restart if already running", async () => {
  const browserSession = new MockBrowserSession();
  const streamerPeer = new MockStreamerPeer();
  const manager = new IdleTimeoutManager({ browserSession });

  await manager.handleConnectionChange(1);
  assert.equal(browserSession.startCallCount, 0);
});

test("IdleTimeoutManager: _checkIdle does nothing when no disconnect time", async () => {
  const browserSession = new MockBrowserSession();
  const streamerPeer = new MockStreamerPeer();
  const manager = new IdleTimeoutManager({ browserSession });

  await manager._checkIdle();
  assert.equal(browserSession.stopCallCount, 0);
});

test("IdleTimeoutManager: _checkIdle stops browser after timeout", async () => {
  const browserSession = new MockBrowserSession();
  const manager = new IdleTimeoutManager({ browserSession, timeoutMinutes: 1 });

  let stopCalled = false;
  manager.onStop = async () => {
    stopCalled = true;
    browserSession.stopCallCount++;
  };

  // Set disconnect time to past
  manager._lastDisconnectTime = Date.now() - (2 * 60 * 1000); // 2 minutes ago

  await manager._checkIdle();
  assert.equal(stopCalled, true);
  assert.equal(browserSession.stopCallCount, 1);
  assert.equal(manager._browserStopped, true);
  assert.equal(manager._lastDisconnectTime, null);
});

test("IdleTimeoutManager: _checkIdle does not stop browser before timeout", async () => {
  const browserSession = new MockBrowserSession();
  const streamerPeer = new MockStreamerPeer();
  const manager = new IdleTimeoutManager({ browserSession, timeoutMinutes: 30 });

  // Set disconnect time to recent past
  manager._lastDisconnectTime = Date.now() - (1 * 60 * 1000); // 1 minute ago

  await manager._checkIdle();
  assert.equal(browserSession.stopCallCount, 0);
  assert.equal(manager._browserStopped, false);
});

test("IdleTimeoutManager: _checkIdle prevents concurrent stops", async () => {
  const browserSession = new MockBrowserSession();
  const streamerPeer = new MockStreamerPeer();
  const manager = new IdleTimeoutManager({ browserSession, timeoutMinutes: 1 });

  manager._lastDisconnectTime = Date.now() - (2 * 60 * 1000);
  manager._stopping = true; // Simulate ongoing stop

  await manager._checkIdle();
  assert.equal(browserSession.stopCallCount, 0);
});

test("IdleTimeoutManager: _checkIdle does nothing if browser already stopped", async () => {
  const browserSession = new MockBrowserSession();
  const streamerPeer = new MockStreamerPeer();
  const manager = new IdleTimeoutManager({ browserSession });

  manager._lastDisconnectTime = Date.now() - (2 * 60 * 1000);
  manager._browserStopped = true;

  await manager._checkIdle();
  assert.equal(browserSession.stopCallCount, 0);
});

test("IdleTimeoutManager: onRestart callback restarts browser", async () => {
  const browserSession = new MockBrowserSession();
  const manager = new IdleTimeoutManager({ browserSession });

  let restartCalled = false;
  manager.onRestart = async () => {
    restartCalled = true;
  };

  manager._browserStopped = true;
  manager.handleConnectionChange(1);

  assert.ok(restartCalled, "onRestart should be called");
});

test("IdleTimeoutManager: onRestart not called if browser running", async () => {
  const browserSession = new MockBrowserSession();
  const manager = new IdleTimeoutManager({ browserSession });

  let restartCalled = false;
  manager.onRestart = async () => {
    restartCalled = true;
  };

  manager.handleConnectionChange(1);

  assert.ok(!restartCalled, "onRestart should not be called if browser running");
});

test("IdleTimeoutManager: handles stop errors gracefully", async () => {
  const browserSession = new MockBrowserSession();
  const manager = new IdleTimeoutManager({ browserSession, timeoutMinutes: 1 });

  let stopCalled = false;
  manager.onStop = async () => {
    throw new Error("Stop failed");
  };

  manager._lastDisconnectTime = Date.now() - (2 * 60 * 1000);

  // Should not throw
  await manager._checkIdle();
  assert.equal(manager._stopping, false);
});

test("IdleTimeoutManager: handles onRestart errors gracefully", async () => {
  const browserSession = new MockBrowserSession();
  const manager = new IdleTimeoutManager({ browserSession });

  let errorLogged = false;
  const originalError = console.error;
  console.error = (...args) => {
    if (args[0].includes('onRestart callback error')) {
      errorLogged = true;
    }
    originalError(...args);
  };

  manager.onRestart = async () => {
    throw new Error("Restart failed");
  };

  manager._browserStopped = true;

  // Should not throw, but should log error
  manager.handleConnectionChange(1);

  // Wait for async callback
  await new Promise(resolve => setTimeout(resolve, 10));

  console.error = originalError;
  assert.ok(errorLogged, "Should log error but not throw");
});
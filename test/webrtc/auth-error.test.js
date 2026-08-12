// Test authentication error detection in MagpiePeer
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MagpiePeer } from '../../src/webrtc/MagpiePeer.js';

describe('MagpiePeer authentication error detection', () => {
  let peer;

  beforeEach(() => {
    // Create peer with mock signal channel (don't actually connect)
    peer = new MagpiePeer({
      url: 'ws://localhost:8080/signaling',
      reconnectInterval: 1000,
      maxReconnectAttempts: 0
    });
  });

  afterEach(() => {
    if (peer) {
      try {
        peer.disconnect();
      } catch {}
    }
  });

  it('detects 401 error message', () => {
    const error = new Error('Request failed with status 401');
    assert.ok(peer._isAuthError(error));
  });

  it('detects Unauthorized error message', () => {
    const error = new Error('Unauthorized access');
    assert.ok(peer._isAuthError(error));
  });

  it('detects Missing token error message', () => {
    const error = new Error('Missing token');
    assert.ok(peer._isAuthError(error));
  });

  it('detects Invalid token error message', () => {
    const error = new Error('Invalid token');
    assert.ok(peer._isAuthError(error));
  });

  it('detects WebSocket close code 1008', () => {
    const error = { code: 1008 };
    assert.ok(peer._isAuthError(error));
  });

  it('returns false for non-auth errors', () => {
    const error = new Error('Connection failed');
    assert.ok(!peer._isAuthError(error));
  });

  it('returns false for null error', () => {
    assert.ok(!peer._isAuthError(null));
  });

  it('emits authenticationFailed event on auth error', (t, done) => {
    peer.on('authenticationFailed', () => {
      done();
    });

    // Simulate auth error from signal channel
    peer.signal.emit('error', { message: 'Unauthorized' });
  });

  it('does not emit authenticationFailed for non-auth error', (t, done) => {
    let failed = false;
    peer.on('authenticationFailed', () => {
      failed = true;
    });

    // Simulate non-auth error
    peer.signal.emit('error', { message: 'Connection timeout' });

    // Wait a bit to ensure event wasn't triggered
    setTimeout(() => {
      assert.ok(!failed);
      done();
    }, 100);
  });

  it('disables auto-reconnect on authentication failure', (t, done) => {
    peer.on('authenticationFailed', () => {
      // Check that auto-reconnect is disabled
      assert.ok(!peer.signal._shouldReconnect);
      done();
    });

    // Simulate auth error
    peer.signal.emit('error', { message: 'Unauthorized' });
  });

  it('rejects connect() promise on authentication failure', async () => {
    // Simulate immediate auth failure
    setTimeout(() => {
      peer.signal.emit('error', { message: 'Unauthorized' });
    }, 10);

    try {
      await peer.connect({ timeout: 1000 });
      assert.fail('Should reject with authentication error');
    } catch (err) {
      assert.equal(err.message, 'Authentication failed');
    }
  });

  it('handles error.reason field', () => {
    const error = { reason: 'Missing token' };
    assert.ok(peer._isAuthError(error));
  });

  it('is case-insensitive for error messages', () => {
    const error = new Error('UNAUTHORIZED');
    assert.ok(peer._isAuthError(error));
  });
});
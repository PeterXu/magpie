// Test codec selection in MagpiePeer
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MagpiePeer } from '../../webrtc/src/MagpiePeer.js';

describe('MagpiePeer codec selection', () => {
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

  it('creates codec selector for preferred codec', () => {
    const selector = peer._createCodecSelector('h264');
    assert.ok(typeof selector === 'function');
  });

  it('creates codec selector without preferred codec (auto-select)', () => {
    // Simulate server-provided codec list
    peer.magpieCodecs = ['av1', 'vp9', 'h264'];
    const selector = peer._createCodecSelector(null);
    assert.ok(typeof selector === 'function');
  });

  it('codec selector handles missing capabilities gracefully', () => {
    const selector = peer._createCodecSelector('h264');

    // Should not throw when capabilities are unavailable
    const mockTransceiver = {
      setCodecPreferences: (codecs) => {
        // Mock implementation
      }
    };

    // This should not throw
    selector(mockTransceiver);
    assert.ok(true);
  });

  it('auto codec selector handles empty codec list', () => {
    peer.magpieCodecs = [];
    const selector = peer._createCodecSelector(null);

    const mockTransceiver = {
      setCodecPreferences: (codecs) => {
        // Mock implementation
      }
    };

    // Should not throw
    selector(mockTransceiver);
    assert.ok(true);
  });
});

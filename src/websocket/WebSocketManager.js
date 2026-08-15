import { EventEmitter } from 'events';

/**
 * WebSocketManager - Manages all WebSocket connections and provides broadcast functionality
 *
 * Maintains a set of active WebSocket connections and allows broadcasting
 * messages to all connected clients. Used for crash notifications and
 * other global events.
 */
export class WebSocketManager extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set(); // Store all connected WebSocket instances
  }

  /**
   * Add a WebSocket connection to the manager
   * @param {WebSocket} ws - WebSocket connection instance
   */
  add(ws) {
    this.clients.add(ws);
    // Emit connection change event
    this.emit('connection-change', this.clients.size);

    // Auto-remove on close
    ws.on('close', () => {
      this.clients.delete(ws);
      // Emit connection change event
      this.emit('connection-change', this.clients.size);
    });
  }

  /**
   * Broadcast a message to all connected WebSocket clients
   * @param {Object} obj - Message object to broadcast (will be JSON stringified)
   */
  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.clients) {
      if (!!ws.peerId && ws.readyState === ws.OPEN) {
        try {
          ws.send(msg);
        } catch (e) {
          // Ignore send errors - connection may have closed during iteration
        }
      }
    }
  }

  destory() {
    for (const ws of this.clients) {
      try {ws.close()} catch(e) {}
    }
    this.clients.clear();
  }

  setPeer(id, ws) {
     ws.peerId = id;
  }

  forwardPeer(id, obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.clients) {
      if (ws.peerId == id) {
        if (ws.readyState === ws.OPEN) {
          try {
            ws.send(msg);
          } catch (e) {
            // Ignore send errors - connection may have closed during iteration
          }
        }
        break;
      }
    }
  }
}

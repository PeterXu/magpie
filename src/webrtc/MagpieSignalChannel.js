import { EventEmitter } from './EventEmitter.js';

/**
 * WebSocket signaling channel management
 * Handles connection lifecycle, reconnection, and message routing
 */
export class MagpieSignalChannel extends EventEmitter {
  constructor(options = {}) {
    super();

    this.url = options.url || '';
    this.reconnectInterval = options.reconnectInterval || 1000;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 5;

    this._ws = null;
    this._reconnectAttempts = 0;
    this._shouldReconnect = false;
    this._isConnecting = false;
  }

  /**
   * Get current connection state
   */
  get state() {
    if (!this._ws) return 'disconnected';
    if (this._isConnecting) return 'connecting';
    switch (this._ws.readyState) {
      case 0: return 'connecting';
      case 1: return 'connected';
      case 2: return 'closing';
      case 3: return 'disconnected';
      default: return 'disconnected';
    }
  }

  /**
   * Connect to signaling server
   */
  connect(url) {
    if (url) this.url = url;

    if (!this.url) {
      this.emit('error', { type: 'InvalidURL', message: 'No signaling URL provided' });
      return;
    }

    if (this._ws && this._ws.readyState === 1) {
      console.log('[SignalChannel] Already connected');
      return;
    }

    if (this._isConnecting) {
      console.log('[SignalChannel] Connection in progress');
      return;
    }

    this._shouldReconnect = true;
    this._doConnect();
  }

  /**
   * Internal connection logic
   */
  _doConnect() {
    if (this._isConnecting) return;

    this._isConnecting = true;
    console.log('[SignalChannel] Connecting to', this.url);

    try {
      this._ws = new WebSocket(this.url);

      this._ws.onopen = () => {
        console.log('[SignalChannel] WebSocket connected');
        this._isConnecting = false;
        this._reconnectAttempts = 0;
        this.emit('connected');
      };

      this._ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.emit('message', message);
        } catch (err) {
          console.error('[SignalChannel] Failed to parse message:', err);
        }
      };

      this._ws.onerror = (error) => {
        console.error('[SignalChannel] WebSocket error:', error);
        this.emit('error', { type: 'WebSocket', error });
      };

      this._ws.onclose = (event) => {
        console.log('[SignalChannel] WebSocket closed, code:', event.code);
        this._isConnecting = false;

        const wasConnected = this._ws && this._ws.readyState === 1;
        this._ws = null;

        this.emit('disconnected', { code: event.code, reason: event.reason });

        // Auto reconnect if enabled and not manual disconnect
        if (this._shouldReconnect && this._reconnectAttempts < this.maxReconnectAttempts) {
          this._reconnectAttempts++;
          console.log(`[SignalChannel] Reconnecting in ${this.reconnectInterval}ms (attempt ${this._reconnectAttempts}/${this.maxReconnectAttempts})`);
          setTimeout(() => {
            if (this._shouldReconnect) {
              this._doConnect();
            }
          }, this.reconnectInterval);
        } else if (this._reconnectAttempts >= this.maxReconnectAttempts) {
          console.error('[SignalChannel] Max reconnect attempts reached');
          this.emit('error', { type: 'ReconnectFailed', message: 'Max reconnect attempts reached' });
        }
      };
    } catch (err) {
      console.error('[SignalChannel] Connection failed:', err);
      this._isConnecting = false;
      this.emit('error', { type: 'Connection', error: err });
    }
  }

  /**
   * Send message through WebSocket
   */
  send(message) {
    if (!this._ws || this._ws.readyState !== 1) {
      console.warn('[SignalChannel] Cannot send: not connected (state:', this.state, ')');
      return false;
    }

    try {
      const data = typeof message === 'string' ? message : JSON.stringify(message);
      this._ws.send(data);
      return true;
    } catch (err) {
      console.error('[SignalChannel] Send failed:', err);
      return false;
    }
  }

  /**
   * Disconnect from server
   */
  disconnect() {
    console.log('[SignalChannel] Disconnecting...');
    this._shouldReconnect = false;

    if (this._ws) {
      // Remove listeners before closing to avoid triggering onclose
      this._ws.onopen = null;
      this._ws.onmessage = null;
      this._ws.onerror = null;
      this._ws.onclose = null;

      if (this._ws.readyState === 1) {
        this._ws.close(1000, 'Client disconnect');
      }

      this._ws = null;
    }

    this._isConnecting = false;
    this._reconnectAttempts = 0;
    this.emit('disconnected', { manual: true });
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this._ws && this._ws.readyState === 1;
  }
}
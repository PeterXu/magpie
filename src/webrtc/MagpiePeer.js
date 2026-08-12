import { EventEmitter } from './EventEmitter.js';
import { MagpieConnection } from './MagpieConnection.js';
import { MagpieSignalChannel } from './MagpieSignalChannel.js';
import { pickCodec } from './codec-pick.js';

/**
 * Main peer class for connection management
 * Manages both signaling (WebSocket) and WebRTC connections
 */
export class MagpiePeer extends EventEmitter {
  constructor(options = {}) {
    super();

    // Signaling channel
    this.signal = new MagpieSignalChannel({
      url: options.url,
      reconnectInterval: options.reconnectInterval || 1000,
      maxReconnectAttempts: options.maxReconnectAttempts || 5
    });

    // ICE servers (updated from hello message)
    this.iceServers = options.iceServers || [];
    this.magpieCodecs = options.magpieCodecs || [];

    // State management
    this._id = null;
    this._connections = new Map(); // connectionId => MagpieConnection
    this._pendingMessages = new Map(); // connectionId => message[]
    this._destroyed = false;
    this._disconnected = false;
    this._open = false;

    // Setup signal event handlers
    this._setupSignalHandlers();
  }

  get id() {
    return this._id;
  }

  get destroyed() {
    return this._destroyed;
  }

  get disconnected() {
    return this._disconnected;
  }

  /**
   * Setup signal channel event handlers
   */
  _setupSignalHandlers() {
    this.signal.on('connected', () => {
      console.log('[MagpiePeer] Signal channel connected');
      this._disconnected = false;
      this.emit('signalConnected');
    });

    this.signal.on('message', (message) => {
      this._handleMessage(message);
    });

    this.signal.on('disconnected', (data) => {
      console.log('[MagpiePeer] Signal channel disconnected', data);
      this.emit('signalDisconnected', data);
    });

    this.signal.on('error', (error) => {
      console.error('[MagpiePeer] Signal error:', error);
      this.emit('error', error);
    });
  }

  /**
   * Connect to signaling server and start WebRTC
   * Returns promise that resolves when connected
   */
  async connect(options = {}) {
    if (this._destroyed) {
      throw new Error('Peer destroyed');
    }

    if (this._disconnected) {
      this._disconnected = false;
    }

    // Connect signal channel
    const url = options.url || this.signal.url;
    if (!url) {
      throw new Error('No signaling URL provided');
    }

    console.log('[MagpiePeer] Connecting to', url);

    // Start signal connection
    this.signal.connect(url);

    // Wait for hello message with timeout
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout'));
      }, options.timeout || 10000);

      this.once('open', (id) => {
        clearTimeout(timeout);

        // Create WebRTC connection
        const connection = this._createConnection(options);

        if (connection) {
          resolve(connection);
        } else {
          reject(new Error('Failed to create connection'));
        }
      });

      this.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Create WebRTC connection after signal connected
   */
  _createConnection(options = {}) {
    if (this._connections.size > 0) {
      console.warn('[MagpiePeer] Connection already exists');
      return this._connections.values().next().value;
    }

    console.log('[MagpiePeer] Creating WebRTC connection');

    const connectionOptions = {
      iceServers: this.iceServers,
      ...options
    };

    // Handle recvonly mode with codec selection
    if (options.recvonly) {
      connectionOptions.recvonly = true;

      // Auto-generate codecSelect for preferCodec
      connectionOptions.codecSelect = this._createCodecSelector(options.preferCodec);
    }

    const connection = new MagpieConnection(null, this, connectionOptions);

    this._addConnection(connection);

    // Start negotiation
    connection.startConnection(null, connectionOptions);

    return connection;
  }

  /**
   * Handle incoming signaling messages
   */
  _handleMessage(message) {
    // Support both 't' (magpie format) and 'type' (standard format)
    const type = message.t || message.type;

    switch (type) {
      case 'hello':
        this._handleHello(message);
        break;

      case 'offer':
        this._handleOffer(message);
        break;

      case 'answer':
        this._handleAnswer(message);
        break;

      case 'candidate':
        this._handleCandidate(message);
        break;

      // Pass through other messages (nav, tabs, clipboard, etc.)
      default:
        this.emit('message', message);
    }
  }

  /**
   * Handle hello message from server
   */
  _handleHello(message) {
    console.log('[MagpiePeer] Received hello');

    // Update ICE servers if provided
    if (message.iceServers) {
      this.iceServers = message.iceServers;
    }

    if (message.magpieCodecs) {
      this.magpieCodecs = message.magpieCodecs;
    }

    this._id = message.id || 'client';
    this._open = true;

    this.emit('open', this._id, message);
  }

  /**
   * Handle answer message
   */
  _handleAnswer(message) {
    const sdp = message.sdp || message.payload?.sdp;
    if (!sdp) {
      console.error('[MagpiePeer] Answer missing sdp');
      return;
    }

    // Forward to all connections
    this._connections.forEach((connection) => {
      connection.handleMessage({
        type: 'answer',
        payload: { sdp }
      });
    });
  }

  /**
   * Handle candidate message
   */
  _handleCandidate(message) {
    const candidate = message.candidate || message.payload?.candidate;
    if (!candidate) {
      console.warn('[MagpiePeer] Candidate missing');
      return;
    }

    // Forward to all connections
    this._connections.forEach((connection) => {
      connection.handleMessage({
        type: 'candidate',
        payload: { candidate }
      });
    });
  }

  /**
   * Handle incoming offer - create new connection
   */
  _handleOffer(message) {
    const connectionId = message.connectionId || message.payload?.connectionId;

    // Check for existing connection
    let connection = this._connections.get(connectionId);
    if (connection) {
      console.warn(`Closing existing connection: ${connectionId}`);
      connection.close();
    }

    // Create new connection
    connection = new MagpieConnection(message.src, this, {
      connectionId,
      offer: message.payload?.sdp || message.payload
    });

    this._addConnection(connection);

    // Emit 'call' event for user to answer
    this.emit('call', connection);
  }

  /**
   * Add connection to management
   */
  _addConnection(connection) {
    this._connections.set(connection.id, connection);

    // Process pending messages
    const pending = this._pendingMessages.get(connection.id);
    if (pending) {
      pending.forEach(msg => connection.handleMessage(msg));
      this._pendingMessages.delete(connection.id);
    }

    // Forward connection signals
    connection.on('iceCandidate', (data) => {
      this.signal.send({
        t: 'candidate',
        candidate: data.candidate,
        connectionId: data.connectionId
      });
    });

    connection.on('offer', (data) => {
      console.log('[MagpiePeer] Sending offer');
      this.signal.send({
        t: 'offer',
        sdp: data.sdp.sdp || data.sdp
      });
    });

    connection.on('answer', (data) => {
      this.signal.send({
        t: 'answer',
        sdp: data.sdp.sdp || data.sdp
      });
    });

    connection.on('error', (err) => {
      this.emit('error', err);
    });

    connection.on('close', () => {
      this._removeConnection(connection);
    });
  }

  /**
   * Remove connection from management
   */
  _removeConnection(connection) {
    this._connections.delete(connection.id);
  }

  /**
   * Disconnect and cleanup all connections
   */
  async disconnect() {
    if (this._disconnected) return;

    console.log('[MagpiePeer] Disconnecting...');

    // Close all connections
    const closePromises = [];
    this._connections.forEach(connection => {
      closePromises.push(connection.close());
    });
    await Promise.all(closePromises);

    // Clear collections
    this._connections.clear();
    this._pendingMessages.clear();

    // Disconnect signal
    this.signal.disconnect();

    this._disconnected = true;
    this._open = false;
    this.emit('disconnected');
  }

  /**
   * Destroy peer completely
   */
  async destroy() {
    if (this._destroyed) return;

    await this.disconnect();

    this._destroyed = true;
    this.emit('close');
  }

  /**
   * Create codec selector for preferred codec
   * @param {string} preferredCodec - Preferred codec name (e.g., 'h264', 'vp8', 'vp9', 'av1')
   *                 Uses pickCodec to find best mutually supported codec if no preferredCodec.
   * @returns {Function} Codec selection function
   */
  _createCodecSelector(preferredCodec) {
    return (transceiver) => {
      try {
        const recv = RTCRtpReceiver.getCapabilities("video");
        if (!recv || !recv.codecs) {
          console.warn('[MagpiePeer] Cannot get video capabilities');
          return;
        }

        let selectedCodec = preferredCodec;
        if (!selectedCodec) {
          // Use pickCodec to find best mutually supported codec
          const clientCodecs = [...new Set(recv.codecs.map(c =>
            (c.mimeType.split("/")[1] || "").toLowerCase()
          ))];
          selectedCodec = pickCodec(this.magpieCodecs, clientCodecs);
        }

        if (!selectedCodec) {
          console.log('[MagpiePeer] No mutually supported codec found, using browser default');
          return;
        }

        const targetCodec = selectedCodec.toLowerCase();
        const clientCodecs = recv.codecs.map(c =>
          (c.mimeType.split("/")[1] || "").toLowerCase()
        );

        if (!clientCodecs.includes(targetCodec)) {
          console.warn(`[MagpiePeer] Codec ${targetCodec} not supported by client`);
          return;
        }

        const want = recv.codecs.filter(c =>
          (c.mimeType.split("/")[1] || "").toLowerCase() === targetCodec
        );
        const rtx = recv.codecs.filter(c => c.mimeType === "video/rtx");

        transceiver.setCodecPreferences([...want, ...rtx]);
        console.log(`[MagpiePeer] Codec preference set to ${targetCodec}`);
      } catch (e) {
        console.warn('[MagpiePeer] Codec selection failed:', e);
      }
    };
  }
}
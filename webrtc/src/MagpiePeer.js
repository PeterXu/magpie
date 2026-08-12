import { EventEmitter } from './EventEmitter.js';
import { MagpieConnection } from './MagpieConnection.js';
import { MagpieSignalChannel } from './MagpieSignalChannel.js';
import { MagpieCanvasMedia } from './MagpieCanvasMedia.js';
import { pickCodec } from './codec-pick.js';
import console from './logger.js';

/**
 * Main peer class for connection management
 * Manages both signaling (WebSocket) and WebRTC connections
 */
export class MagpiePeer extends EventEmitter {
  TAG = '[MagpiePeer]';

  constructor(options = {}) {
    super();

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

    // Signaling channel
    this.initSignalChannel(options);
    this.canvasMedia = null;
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

  async setCanvasStream(options) {
    this.canvasMedia = new MagpieCanvasMedia(options);
    this.canvasMedia.startDrawLoop();

    // create signal channel for receiving frame
    await this._createSignalConnect(options);
  }

  async relayOffer(message, iceServers, params) {
    // TODO
    const stream = this.canvasMedia.createLocalStream();
    const connection = await this.connectWithoutSignal(stream, {
      connectionId: message.connectionId,
      offer: message.sdp,
      iceServers,
      ...params
    });
  }

  initSignalChannel(options = {}) {
    // Signaling channel
    this.signal = new MagpieSignalChannel({
      url: options.url,
      reconnectInterval: options.reconnectInterval || 1000,
      maxReconnectAttempts: options.maxReconnectAttempts || 5
    });

    // Setup signal event handlers
    this._setupSignalHandlers();
  }

  /**
   * Setup signal channel event handlers
   */
  _setupSignalHandlers() {
    this.signal.on('connected', () => {
      console.log(this.TAG, 'Signal channel connected');
      this._disconnected = false;
      this.emit('signalConnected');
    });

    this.signal.on('message', (message) => {
      this._handleMessage(message);
    });

    this.signal.on('disconnected', (data) => {
      console.log(this.TAG, 'Signal channel disconnected', data);
      this.emit('signalDisconnected', data);
    });

    this.signal.on('error', (error) => {
      console.error(this.TAG, 'Signal error:', error);

      // Check if it's an authentication error
      if (this._isAuthError(error)) {
        // Disable auto-reconnect on authentication failure
        if (this.signal._shouldReconnect) {
          this.signal._shouldReconnect = false;
        }
        this.emit('authenticationFailed');
        return;
      }

      this.emit('error', error);
    });
  }

  async connectWithoutSignal(stream, options = {}) {
    if (this._destroyed) {
      throw new Error('Peer destroyed');
    }

    if (this._disconnected) {
      this._disconnected = false;
    }

    // Create WebRTC connection once signal handshake is open
    const connection = await this._createConnection(stream, options);
    if (!connection) {
      throw new Error('Failed to create connection');
    }

    return connection;
  }

  /**
   * Wait for hello message with timeout
   */
  async connect(stream, options = {}) {
    if (this._destroyed) {
      throw new Error('Peer destroyed');
    }

    if (this._disconnected) {
      this._disconnected = false;
    }

    // Connect signal channel
    await this._createSignalConnect(options);
   
    // Create WebRTC connection once signal handshake is open
    const connection = await this._createConnection(stream, options);
    if (!connection) {
      throw new Error('Failed to create connection');
    }

    return connection;
  }

  async _createSignalConnect(options = {}) {
     // Connect signal channel
    console.log(this.TAG, 'Connecting to signal with url: ', options.url);
    this.signal.connect(options.url);

    // Wait for hello (open), or fail on error / authentication failure / timeout.
    // Plain `on` + explicit cleanup so no listeners linger after settle (a
    // once-listener that never fired would otherwise stay attached to this peer).
    await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        this.off('open', onOpen);
        this.off('error', onError);
        this.off('authenticationFailed', onAuth);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = (error) => { cleanup(); reject(error); };
      const onAuth = () => { cleanup(); reject(new Error('Authentication failed')); };

      timer = setTimeout(() => { cleanup(); reject(new Error('Connection timeout')); }, options.timeout || 10000);

      this.on('open', onOpen);
      this.on('error', onError);
      this.on('authenticationFailed', onAuth);
    });
  }

  /**
   * Create WebRTC connection after signal connected
   */
  async _createConnection(stream, options = {}) {
    console.log(this.TAG, 'Creating WebRTC connection');

    const connection = new MagpieConnection(null, this, options);
    this._addConnection(connection);
  
    const configOptions = {
      iceServers: options.iceServers || this.iceServers,
      codecSelect: this._createCodecSelector(options.preferCodec),
      ...options,
    }
    await connection.startHandshake(stream, configOptions);
    return connection;
  }

  /**
   * Handle incoming signaling messages
   */
  _handleMessage(message) {
    // Support both 't' (magpie format) and 'type' (standard format)
    const type = message.t || message.type;

    switch (type) {
      case 'frame':
        this._handleFrame(message);
        break;

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

  _handleFrame(message) {
    if (message.data && this.canvasMedia) {
      this.canvasMedia.feedImage(message.data);
    }
  }

  /**
   * Handle hello message from server
   */
  _handleHello(message) {
    console.log(this.TAG, 'Received hello');

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
    console.log(this.TAG, "_handleAnswer");
    const sdp = message.sdp || message.payload?.sdp;
    if (!sdp) {
      console.error(this.TAG, '_handleAnswer, missing sdp');
      return;
    }
  
    const connectionId = message.connectionId || message.payload?.connectionId;
    const connection = this._connections.get(connectionId);
    if (!connection) {
      console.warn(this.TAG, '_handleAnswer, no connection=', connectionId);
      return;
    }

    connection.handleMessage({
      type: 'answer',
      payload: { sdp }
    });
  }

  /**
   * Handle candidate message
   */
  _handleCandidate(message) {
    console.log(this.TAG, "_handleCandidate");
    const candidate = message.candidate || message.payload?.candidate;
    if (!candidate) {
      console.warn(this.TAG, '_handleCandidate, candidate missing');
      return;
    }

    const connectionId = message.connectionId || message.payload?.connectionId;
    const connection = this._connections.get(connectionId);
    if (!connection) {
      console.warn(this.TAG, '_handleCandidate, no connection=', connectionId);
      return;
    }

    connection.handleMessage({
      type: 'candidate',
      payload: { candidate }
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
        connectionId: connection.id
      });
    });

    connection.on('offer', (data) => {
      console.log(this.TAG, 'Sending offer with id=', connection.id);
      this.signal.send({
        t: 'offer',
        sdp: data.sdp.sdp || data.sdp,
        connectionId: connection.id
      });
    });

    connection.on('answer', (data) => {
      this.signal.send({
        t: 'answer',
        sdp: data.sdp.sdp || data.sdp,
        connectionId: connection.id
      });
    });

    connection.on('error', (err) => {
      this.emit('error', { ...err, connectionId: connection.id });
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

    console.log(this.TAG, 'Disconnecting...');

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
   * Check if error is an authentication error
   * @param {Error|Object} error - Error object
   * @returns {boolean} True if authentication error
   */
  _isAuthError(error) {
    if (!error) return false;

    // Extract message from various error formats
    const message = error.message ||
                    error.error?.message ||
                    error.reason ||
                    '';

    // Check for authentication-related keywords
    const authKeywords = [
      '401',
      'Unauthorized',
      'Authentication failed',
      'Missing token',
      'Invalid token'
    ];

    const isAuthMessage = authKeywords.some(keyword =>
      message.toLowerCase().includes(keyword.toLowerCase())
    );

    // Check WebSocket close code 1008 (Policy Violation)
    const isPolicyViolation = error.code === 1008;

    return isAuthMessage || isPolicyViolation;
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
          console.warn(this.TAG, 'Cannot get video capabilities');
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
          console.log(this.TAG, 'No mutually supported codec found, using browser default');
          return;
        }

        const targetCodec = selectedCodec.toLowerCase();
        const clientCodecs = recv.codecs.map(c =>
          (c.mimeType.split("/")[1] || "").toLowerCase()
        );

        if (!clientCodecs.includes(targetCodec)) {
          console.warn(this.TAG, `Codec ${targetCodec} not supported by client`);
          return;
        }

        const want = recv.codecs.filter(c =>
          (c.mimeType.split("/")[1] || "").toLowerCase() === targetCodec
        );
        const rtx = recv.codecs.filter(c => c.mimeType === "video/rtx");

        transceiver.setCodecPreferences([...want, ...rtx]);
        console.log(this.TAG, `Codec preference set to ${targetCodec}`);
      } catch (e) {
        console.warn(this.TAG, 'Codec selection failed:', e);
      }
    };
  }
}

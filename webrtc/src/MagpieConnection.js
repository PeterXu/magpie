import { EventEmitter } from './EventEmitter.js';
import { MagpieNegotiator } from './MagpieNegotiator.js';
import console from './logger.js';

/**
 * Manages a single connection's stream and state
 * Borrowed from PeerJS design pattern
 */
export class MagpieConnection extends EventEmitter {
  TAG = '[MagpieConnection]';

  constructor(peerId, provider, options = {}) {
    super();

    this.id = options.connectionId || `conn_${this._randomToken()}`;
    this.peerId = peerId;
    this.provider = provider;

    this._negotiator = new MagpieNegotiator(this);
    this._localStream = null;
    this._remoteStream = null;
    this._open = false;
    this.peerConnection = null;

    // Setup negotiator event forwarding
    this._setupNegotiatorEvents();
  }

  get open() {
    return this._open;
  }

  get localStream() {
    return this._localStream;
  }

  get remoteStream() {
    return this._remoteStream;
  }

  get localDescription() {
    return this.peerConnection ? this.peerConnection.localDescription : null;
  }

  get remotelDescription() {
    return this.peerConnection ? this.peerConnection.remoteDescription : null;
  }

  /**
   * Setup event forwarding from negotiator
   */
  _setupNegotiatorEvents() {
    // Forward ICE candidate
    this._negotiator.on('iceCandidate', (data) => {
      this.emit('iceCandidate', data);
    });

    // Forward offer
    this._negotiator.on('offer', (data) => {
      this.emit('offer', data);
    });

    // Forward answer
    this._negotiator.on('answer', (data) => {
      this.emit('answer', data);
    });

    // Handle incoming stream
    this._negotiator.on('stream', (stream) => {
      this.emit('stream', stream);
    });

    // Handle connection state changes
    this._negotiator.on('connected', () => {
      this._open = true;
      this.emit('open');
    });

    // Forward state changes for debugging
    this._negotiator.on('iceStateChange', (state) => {
      this.emit('iceStateChange', state);
    });

    this._negotiator.on('connectionStateChange', (state) => {
      this.emit('connectionStateChange', state);
    });
  }

  /**
   * Start connection actively or answer incoming connection
   * 
   * @param stream: may be null if no recvonly
   * @param options: options.offer must be exist for answer incoming connection
   */
  async startHandshake(stream, options = {}) {
    console.log(this.TAG, 'startHandshake');

    if (this._localStream) {
      console.warn(this.TAG, 'Connection already started');
      return;
    }
    this._localStream = stream;

    this._negotiator.createConnection(options);
  
    const streamOptions = {
      stream: stream,
      recvonly: !!options.recvonly,
      // Auto-generate codecSelect for preferCodec, and valid when recvonly is true.
      codecSelect: options.codecSelect,
    };
    await this._negotiator.setStreamSendRecv(streamOptions);

    if (stream) {
      const senderOptions = {
        BITRATE: options.BITRATE,
        MAXFPS: options.MAXFPS,
        DEGRADATION: options.DEGRADATION,
      };
      await this._negotiator.setVideoSenderParameters(senderOptions);
    }

    const negotiationOptions = {
      initiator: !options.offer,
      offer: options.offer,
    };
    return await this._negotiator.startNegotiation(negotiationOptions);
  }

  /**
   * Handle signaling messages
   */
  handleMessage(message) {
    switch (message.type) {
      case 'answer':
        this._negotiator.handleAnswer(message.payload.sdp);
        break;

      case 'candidate':
        this._negotiator.handleCandidate(message.payload.candidate);
        break;

      default:
        console.warn(this.TAG, `Unknown message type: ${message.type}`);
    }
  }

  /**
   * Close connection and cleanup resources
   */
  close() {
    console.log(this.TAG, 'Closing connection');

    // Cleanup negotiator synchronously
    if (this._negotiator) {
      this._negotiator.cleanup();
      this._negotiator = null;
    }

    // Clear stream references
    this._localStream = null;
    this._remoteStream = null;

    // Remove from provider
    if (this.provider) {
      this.provider._removeConnection(this);
      this.provider = null;
    }

    const wasOpen = this._open;
    this._open = false;

    if (wasOpen) {
      this.emit('close');
    }

    console.log(this.TAG, 'Connection closed');
  }

  /**
   * Generate random token for connection ID
   */
  _randomToken() {
    return Math.random().toString(36).substring(2);
  }
}

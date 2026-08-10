import { EventEmitter } from './EventEmitter.js';
import { MagpieNegotiator } from './MagpieNegotiator.js';

/**
 * Manages a single connection's stream and state
 * Borrowed from PeerJS design pattern
 */
export class MagpieConnection extends EventEmitter {
  constructor(peerId, provider, options = {}) {
    super();

    this.id = options.connectionId || `conn_${this._randomToken()}`;
    this.peerId = peerId;
    this.provider = provider;
    this.options = options;

    this._negotiator = new MagpieNegotiator(this);
    this._localStream = null;
    this._remoteStream = null;
    this._open = false;

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
   * Start connection as initiator
   */
  startConnection(stream, options = {}) {
    console.log('[MagpieConnection] startConnection called with stream:', !!stream, 'options:', options);

    if (this._localStream) {
      console.warn('Connection already started');
      return;
    }

    this._localStream = stream;

    const negotiatorOptions = {
      stream,
      iceServers: this.provider.iceServers,
      initiator: true,
      ...options
    };
    console.log('[MagpieConnection] passing to negotiator:', negotiatorOptions);

    this._negotiator.startConnection(negotiatorOptions);
  }

  /**
   * Answer incoming connection
   */
  answer(stream, options = {}) {
    if (this._localStream) {
      console.warn('Connection already answered');
      return;
    }

    this._localStream = stream;

    this._negotiator.startConnection({
      stream,
      iceServers: this.provider.iceServers,
      initiator: false,
      offer: this.options.offer,
      ...options
    });
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
        console.warn(`Unknown message type: ${message.type}`);
    }
  }

  /**
   * Close connection and cleanup resources
   */
  close() {
    console.log('[MagpieConnection] Closing connection');

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

    console.log('[MagpieConnection] Connection closed');
  }

  /**
   * Generate random token for connection ID
   */
  _randomToken() {
    return Math.random().toString(36).substring(2);
  }
}
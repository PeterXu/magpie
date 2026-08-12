import { EventEmitter } from './EventEmitter.js';
import console from './logger.js';

/**
 * Manages RTCPeerConnection negotiations
 * Borrowed from PeerJS design pattern
 */
export class MagpieNegotiator extends EventEmitter {
  TAG = '[MagpieNegotiator]';

  constructor(connection) {
    super();
    this.connection = connection;
  }

  /**
   * Start connection with proper ICE handling
   */
  createConnection(options) {
    const rtcConfig = {
      iceServers: options.iceServers || [],
      iceTransportPolicy: options.iceTransportPolicy || 'all',
    };

    console.log(this.TAG, 'createConnection config:', JSON.stringify(rtcConfig));
    const pc = new RTCPeerConnection(rtcConfig);
    this.connection.peerConnection = pc;
    this._setupListeners(pc);
  }

  setStreamSendRecv(options) {
    const streamConfig = {
      hasStream: !!options.stream,
      recvonly: !!options.recvonly,
      hasCodeSelect: !!options.codecSelect,
    };
    console.log(this.TAG, 'setStreamSendRecv config:', JSON.stringify(streamConfig));
    const pc = this.connection.peerConnection;
  
    // Add tracks if stream provided (for sendonly/sendrecv)
    if (streamConfig.hasStream) {
      console.log(this.TAG, 'Adding tracks from stream');
      this._addTracks(options.stream, pc);
    }
    // For recvonly, add transceiver
    else if (streamConfig.recvonly) {
      console.log(this.TAG, 'Adding recvonly transceiver');
      const transceiver = pc.addTransceiver("video", { direction: "recvonly" });

      // Apply codec selection if provided
      if (streamConfig.hasCodeSelect) {
        console.log(this.TAG, 'Applying codec selection');
        options.codecSelect(transceiver);
      }
    } else {
      console.warn(this.TAG, 'No stream and not recvonly, connection may fail');
    }
  }

  async setVideoSenderParameters(options) {
    const senderConfig = {
      BITRATE: options.BITRATE || 0,
      MAXFPS: options.MAXFPS || 0,
      DEGRADATION: options.DEGRADATION || 0,
    };
    console.log(this.TAG, 'setVideoSenderParameters config=', JSON.stringify(senderConfig));
    if (!options.BITRATE && !options.MAXFPS && !options.DEGRADATION) {
      return;
    }

    const pc = this.connection.peerConnection;
    const sender = pc.getSenders().find(s => s.track?.kind === 'video');
    if (!sender) {
      console.log(this.TAG, 'setVideoSenderParameters: no video sender');
      return;
    }
  
    // Optional sender caps (maxBitrate/maxFramerate/degradationPreference).
    // Wrapped: browser/timing quirks must not break the offer — fall back to defaults.
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      if (options.BITRATE) p.encodings[0].maxBitrate = options.BITRATE;
      if (options.MAXFPS) p.encodings[0].maxFramerate = options.MAXFPS;
      if (options.DEGRADATION) p.degradationPreference = options.DEGRADATION;
      await sender.setParameters(p);
    } catch (e) { console.warn(this.TAG, "setVideoSenderParameters failed", e); }
  }

  async startNegotiation(options) {
    // Start negotiation
    if (options.initiator) {
      console.log(this.TAG, 'Starting negotiation as initiator');
      return this._makeOffer(options);
    } else if (options.offer) {
      console.log(this.TAG, 'Handling incoming offer');
      return this._makeAnswer(options);
    }
  }

  /**
   * Setup WebRTC event listeners
   * Key improvement: proper cleanup and state monitoring
   */
  _setupListeners(pc) {
    // ICE CANDIDATES - Monitor all candidate types including TURN
    const candidateStats = { host: 0, srflx: 0, relay: 0 };

    pc.onicecandidate = (evt) => {
      if (!evt.candidate || !evt.candidate.candidate) {
        console.log(this.TAG, `ICE gathering complete. Candidates: ${candidateStats.host} host, ${candidateStats.srflx} srflx, ${candidateStats.relay} relay`);
        return;
      }

      const candidate = evt.candidate.candidate;
      const type = candidate.includes('typ relay') ? 'relay' :
                   candidate.includes('typ srflx') ? 'srflx' :
                   candidate.includes('typ host') ? 'host' : 'unknown';

      candidateStats[type]++;

      console.log(this.TAG, `ICE candidate [${type.toUpperCase()} #${candidateStats[type]}]:`, candidate.substring(0, 80));

      // Immediately send candidate (Trickle ICE pattern)
      this.emit('iceCandidate', {
        candidate: evt.candidate
      });
    };

    // ICE CONNECTION STATE - Monitor and handle failures
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;

      this.emit('iceStateChange', state);

      switch (state) {
        case 'failed':
          console.error('ICE connection failed');
          this.connection.emit('error', { type: 'NegotiationFailed', message: 'ICE connection failed' });
          this.connection.close();
          break;

        case 'closed':
          console.log('ICE connection closed');
          this.connection.close();
          break;

        case 'disconnected':
          console.log('ICE connection disconnected');
          break;

        case 'completed':
          // Clear listener to avoid duplicate triggers
          pc.onicecandidate = null;
          break;
      }
    };

    // CONNECTION STATE - Additional monitoring
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;

      this.emit('connectionStateChange', state);

      if (state === 'failed') {
        console.error(this.TAG, 'WebRTC connection failed');
        this.connection.emit('error', { type: 'ConnectionFailed', message: 'WebRTC connection failed' });
        this.connection.close();
      } else if (state === 'connected') {
        console.log(this.TAG, 'WebRTC connected successfully');
        this.connection._open = true;
        this.emit('connected');

        // Fallback: poll for receiver track if ontrack hasn't fired with streams
        // This handles edge cases in headless Chromium
        if (!this.connection._remoteStream) {
          console.log(this.TAG, 'Polling for receiver track...');
          this._pollForReceiver();
        }
      }
    };

    // TRACK - Handle incoming media stream
    pc.ontrack = (evt) => {
      console.log(this.TAG, 'ontrack event, streams:', evt.streams?.length || 0);

      if (evt.streams && evt.streams[0]) {
        console.log(this.TAG, 'Received remote stream');
        this.connection._remoteStream = evt.streams[0];
        this.emit('stream', evt.streams[0]);
      } else if (evt.receiver && evt.receiver.track) {
        // Fallback: create MediaStream from receiver track
        // This happens when remote uses addTrack instead of transceiver
        console.log(this.TAG, 'reating stream from receiver track');
        const stream = new MediaStream([evt.receiver.track]);
        this.connection._remoteStream = stream;
        this.emit('stream', stream);
      } else {
        console.warn(this.TAG, 'ontrack fired but no streams or receiver track');
      }
    };
  }

  /**
   * Add media tracks to connection
   */
  _addTracks(stream, pc) {
    stream.getTracks().forEach(track => {
      pc.addTrack(track, stream);
    });
  }

  /**
   * Create and send offer
   */
  async _makeOffer(options) {
    const pc = this.connection.peerConnection;

    try {
      const offer = await pc.createOffer();
      console.log(this.TAG, 'Offer created');

      // Apply SDP transform if provided (for codec selection)
      if (options.sdpTransform) {
        offer.sdp = options.sdpTransform(offer.sdp) || offer.sdp;
      }

      await pc.setLocalDescription(offer);
      console.log(this.TAG, 'Local description set');

      // Store last offer for testing/verification
      if (typeof window !== 'undefined') {
        window._lastOffer = pc.localDescription.sdp;
      }

      // Wait for ICE gathering to complete (magpie uses complete ICE gathering)
      if (options.waitForIceGathering !== false) {
        console.log(this.TAG, 'Waiting for ICE gathering...');
        await this._waitForIceGathering(options.iceGatheringTimeout || 5000);
        console.log(this.TAG, 'ICE gathering complete or timed out');
      }

      console.log(this.TAG, 'Emitting offer event');
      this.emit('offer', {
        sdp: pc.localDescription,
      });
      return pc.localDescription;
    } catch (err) {
      console.error(this.TAG, 'Failed to create offer:', err);
      this.connection.emit('error', { type: 'WebRTC', error: err });
      throw err;
    }
  }

  /**
   * Wait for ICE gathering to complete
   * Uses longer timeout for TURN allocation
   */
  async _waitForIceGathering(timeoutMs = 10000) {
    const pc = this.connection.peerConnection;

    console.log(this.TAG, 'ICE gathering state:', pc.iceGatheringState);

    if (pc.iceGatheringState === 'complete') {
      console.log(this.TAG, 'ICE gathering already complete');
      return;
    }

    await new Promise((resolve) => {
      const startTime = Date.now();

      const timer = setTimeout(() => {
        console.warn(this.TAG, 'ICE gathering timeout after', timeoutMs, 'ms');
        console.warn(this.TAG, 'Collected candidates may not include TURN relay');
        resolve();
      }, timeoutMs);

      pc.addEventListener('icegatheringstatechange', () => {
        console.log(this.TAG, 'ICE gathering state changed to:', pc.iceGatheringState);
        if (pc.iceGatheringState === 'complete') {
          const elapsed = Date.now() - startTime;
          console.log(this.TAG, `ICE gathering complete in ${elapsed}ms`);
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  /**
   * Handle incoming offer and Create and send answer
   */
  async _makeAnswer(options) {
    const pc = this.connection.peerConnection;

    try {
      // First set remote offer.
      const remoteDesc = typeof options.offer === 'string'
        ? { type: 'offer', sdp: options.offer }
        : options.offer;
      await pc.setRemoteDescription(new RTCSessionDescription(remoteDesc));
 
      // Then create local answer
      const answer = await pc.createAnswer();

      // Then set local answer
      await pc.setLocalDescription(answer);

      // Wait for ICE gathering to complete (magpie uses complete ICE gathering)
      if (options.waitForIceGathering !== false) {
        console.log(this.TAG, 'Waiting for ICE gathering...');
        await this._waitForIceGathering(options.iceGatheringTimeout || 5000);
        console.log(this.TAG, 'ICE gathering complete or timed out');
      }

      this.emit('answer', {
        sdp: pc.localDescription
      });
      return pc.localDescription;
    } catch (err) {
      console.error('Failed to create answer:', err);
      this.connection.emit('error', { type: 'WebRTC', error: err });
      throw err;
    }
  }

  /**
   * Handle incoming answer
   */
  async handleAnswer(answer) {
    const pc = this.connection.peerConnection;

    try {
      // answer can be either:
      // 1. RTCSessionDescription object
      // 2. { type: 'answer', sdp: '...' } object
      // 3. SDP string
      const remoteDesc = typeof answer === 'string'
        ? { type: 'answer', sdp: answer }
        : answer;

      console.log(this.TAG, 'Setting remote description');
      await pc.setRemoteDescription(new RTCSessionDescription(remoteDesc));
      this.connection._open = true;
      console.log(this.TAG, 'Remote description set successfully');
    } catch (err) {
      console.error(this.TAG, 'Failed to handle answer:', err);
      this.connection.emit('error', { type: 'WebRTC', error: err });
    }
  }

  /**
   * Handle incoming ICE candidate
   */
  async handleCandidate(candidate) {
    const pc = this.connection.peerConnection;

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error(this.TAG, 'Failed to handle candidate:', err);
      this.connection.emit('error', { type: 'WebRTC', error: err });
    }
  }

  /**
   * Poll for receiver track as fallback
   * Handles edge cases in headless Chromium where ontrack doesn't provide streams
   */
  _pollForReceiver() {
    const pc = this.connection.peerConnection;
    let attempts = 0;
    const maxAttempts = 50; // 5 seconds max

    const poll = () => {
      if (this.connection._remoteStream) {
        console.log(this.TAG, 'Stream already attached');
        return;
      }

      attempts++;
      const receivers = pc.getReceivers();
      const videoReceiver = receivers.find(r => r.track && r.track.kind === 'video');

      if (videoReceiver && videoReceiver.track) {
        console.log(this.TAG, `Found video track via polling (attempt ${attempts})`);
        const stream = new MediaStream([videoReceiver.track]);
        this.connection._remoteStream = stream;
        this.emit('stream', stream);
        return;
      }

      if (attempts < maxAttempts) {
        setTimeout(poll, 100);
      } else {
        console.warn(this.TAG, 'Failed to find video track after', maxAttempts, 'attempts');
      }
    };

    poll();
  }

  /**
   * Cleanup resources
   * Key improvement: proper cleanup to avoid memory leaks and ensure TURN deallocation
   */
  cleanup() {
    const pc = this.connection.peerConnection;

    if (!pc) return;

    console.log(this.TAG, 'Cleaning up RTCPeerConnection');

    // Remove all event listeners (fix memory leak)
    pc.onicecandidate = null;
    pc.oniceconnectionstatechange = null;
    pc.onconnectionstatechange = null;
    pc.ontrack = null;
    pc.ondatachannel = null;

    // Check state before closing
    const notClosed = pc.signalingState !== 'closed';
    if (notClosed) {
      pc.close();
    }

    this.connection.peerConnection = null;
    console.log(this.TAG, 'RTCPeerConnection cleaned up');
  }
}

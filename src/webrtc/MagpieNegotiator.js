import { EventEmitter } from './EventEmitter.js';

/**
 * Manages RTCPeerConnection negotiations
 * Borrowed from PeerJS design pattern
 */
export class MagpieNegotiator extends EventEmitter {
  constructor(connection) {
    super();
    this.connection = connection;
  }

  /**
   * Start connection with proper ICE handling
   */
  startConnection(options) {
    console.log('[MagpieNegotiator] startConnection called with:', {
      hasStream: !!options.stream,
      recvonly: options.recvonly,
      initiator: options.initiator,
      iceServers: options.iceServers
    });

    const rtcConfig = { iceServers: options.iceServers || [] };

    console.log('[MagpieNegotiator] RTCPeerConnection config:', {
      iceServers: rtcConfig.iceServers?.map(s => s.urls),
      iceTransportPolicy: rtcConfig.iceTransportPolicy || 'all'
    });

    const pc = new RTCPeerConnection(rtcConfig);
    this.connection.peerConnection = pc;

    this._setupListeners(pc);

    // Add tracks if stream provided (for sendonly/sendrecv)
    if (options.stream) {
      console.log('[MagpieNegotiator] Adding tracks from stream');
      this._addTracks(options.stream, pc);
    }
    // For recvonly, add transceiver
    else if (options.recvonly) {
      console.log('[MagpieNegotiator] Adding recvonly transceiver');
      const transceiver = pc.addTransceiver("video", { direction: "recvonly" });

      // Apply codec selection if provided
      if (options.codecSelect) {
        console.log('[MagpieNegotiator] Applying codec selection');
        options.codecSelect(transceiver);
      }
    } else {
      console.warn('[MagpieNegotiator] No stream and not recvonly, connection may fail');
    }

    // Start negotiation
    if (options.initiator) {
      console.log('[MagpieNegotiator] Starting negotiation as initiator');
      this._makeOffer(options);
    } else if (options.offer) {
      console.log('[MagpieNegotiator] Handling incoming offer');
      this.handleOffer(options.offer);
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
        console.log(`[MagpieNegotiator] ICE gathering complete. Candidates: ${candidateStats.host} host, ${candidateStats.srflx} srflx, ${candidateStats.relay} relay`);
        return;
      }

      const candidate = evt.candidate.candidate;
      const type = candidate.includes('typ relay') ? 'relay' :
                   candidate.includes('typ srflx') ? 'srflx' :
                   candidate.includes('typ host') ? 'host' : 'unknown';

      candidateStats[type]++;

      console.log(`[MagpieNegotiator] ICE candidate [${type.toUpperCase()} #${candidateStats[type]}]:`, candidate.substring(0, 80));

      // Immediately send candidate (Trickle ICE pattern)
      this.emit('iceCandidate', {
        candidate: evt.candidate,
        connectionId: this.connection.id
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
          console.log('ICE connection disconnected, may recover');
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
        console.error('[MagpieNegotiator] WebRTC connection failed');
        this.connection.emit('error', { type: 'ConnectionFailed', message: 'WebRTC connection failed' });
        this.connection.close();
      } else if (state === 'connected') {
        console.log('[MagpieNegotiator] WebRTC connected successfully');
        this.connection._open = true;
        this.emit('connected');

        // Fallback: poll for receiver track if ontrack hasn't fired with streams
        // This handles edge cases in headless Chromium
        if (!this.connection._remoteStream) {
          console.log('[MagpieNegotiator] Polling for receiver track...');
          this._pollForReceiver();
        }
      }
    };

    // TRACK - Handle incoming media stream
    pc.ontrack = (evt) => {
      console.log('[MagpieNegotiator] ontrack event, streams:', evt.streams?.length || 0);

      if (evt.streams && evt.streams[0]) {
        console.log('[MagpieNegotiator] Received remote stream');
        this.connection._remoteStream = evt.streams[0];
        this.emit('stream', evt.streams[0]);
      } else if (evt.receiver && evt.receiver.track) {
        // Fallback: create MediaStream from receiver track
        // This happens when remote uses addTrack instead of transceiver
        console.log('[MagpieNegotiator] Creating stream from receiver track');
        const stream = new MediaStream([evt.receiver.track]);
        this.connection._remoteStream = stream;
        this.emit('stream', stream);
      } else {
        console.warn('[MagpieNegotiator] ontrack fired but no streams or receiver track');
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
      console.log('[MagpieNegotiator] Offer created');

      // Apply SDP transform if provided (for codec selection)
      if (options.sdpTransform) {
        offer.sdp = options.sdpTransform(offer.sdp) || offer.sdp;
      }

      await pc.setLocalDescription(offer);
      console.log('[MagpieNegotiator] Local description set');

      // Wait for ICE gathering to complete (magpie uses complete ICE gathering)
      if (options.waitForIceGathering !== false) {
        console.log('[MagpieNegotiator] Waiting for ICE gathering...');
        await this._waitForIceGathering(options.iceGatheringTimeout || 5000);
        console.log('[MagpieNegotiator] ICE gathering complete or timed out');
      }

      console.log('[MagpieNegotiator] Emitting offer event');
      this.emit('offer', {
        sdp: pc.localDescription,
        connectionId: this.connection.id
      });
    } catch (err) {
      console.error('[MagpieNegotiator] Failed to create offer:', err);
      this.connection.emit('error', { type: 'WebRTC', error: err });
    }
  }

  /**
   * Wait for ICE gathering to complete
   * Uses longer timeout for TURN allocation
   */
  _waitForIceGathering(timeoutMs = 10000) {
    const pc = this.connection.peerConnection;

    console.log('[MagpieNegotiator] ICE gathering state:', pc.iceGatheringState);

    if (pc.iceGatheringState === 'complete') {
      console.log('[MagpieNegotiator] ICE gathering already complete');
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const startTime = Date.now();

      const timer = setTimeout(() => {
        console.warn('[MagpieNegotiator] ICE gathering timeout after', timeoutMs, 'ms');
        console.warn('[MagpieNegotiator] Collected candidates may not include TURN relay');
        resolve();
      }, timeoutMs);

      pc.addEventListener('icegatheringstatechange', () => {
        console.log('[MagpieNegotiator] ICE gathering state changed to:', pc.iceGatheringState);
        if (pc.iceGatheringState === 'complete') {
          const elapsed = Date.now() - startTime;
          console.log(`[MagpieNegotiator] ICE gathering complete in ${elapsed}ms`);
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  /**
   * Handle incoming offer
   */
  async handleOffer(offer) {
    const pc = this.connection.peerConnection;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await this._makeAnswer();
    } catch (err) {
      console.error('Failed to handle offer:', err);
      this.connection.emit('error', { type: 'WebRTC', error: err });
    }
  }

  /**
   * Create and send answer
   */
  async _makeAnswer() {
    const pc = this.connection.peerConnection;

    try {
      const answer = await pc.createAnswer();

      // Apply SDP transform if needed
      if (this.connection.options.sdpTransform) {
        answer.sdp = this.connection.options.sdpTransform(answer.sdp) || answer.sdp;
      }

      await pc.setLocalDescription(answer);

      this.emit('answer', {
        sdp: answer,
        connectionId: this.connection.id
      });
    } catch (err) {
      console.error('Failed to create answer:', err);
      this.connection.emit('error', { type: 'WebRTC', error: err });
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

      console.log('[MagpieNegotiator] Setting remote description');
      await pc.setRemoteDescription(new RTCSessionDescription(remoteDesc));
      this.connection._open = true;
      console.log('[MagpieNegotiator] Remote description set successfully');
    } catch (err) {
      console.error('[MagpieNegotiator] Failed to handle answer:', err);
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
      console.error('[MagpieNegotiator] Failed to handle candidate:', err);
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
        console.log('[MagpieNegotiator] Stream already attached');
        return;
      }

      attempts++;
      const receivers = pc.getReceivers();
      const videoReceiver = receivers.find(r => r.track && r.track.kind === 'video');

      if (videoReceiver && videoReceiver.track) {
        console.log(`[MagpieNegotiator] Found video track via polling (attempt ${attempts})`);
        const stream = new MediaStream([videoReceiver.track]);
        this.connection._remoteStream = stream;
        this.emit('stream', stream);
        return;
      }

      if (attempts < maxAttempts) {
        setTimeout(poll, 100);
      } else {
        console.warn('[MagpieNegotiator] Failed to find video track after', maxAttempts, 'attempts');
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

    console.log('[MagpieNegotiator] Cleaning up RTCPeerConnection');

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
    console.log('[MagpieNegotiator] RTCPeerConnection cleaned up');
  }
}
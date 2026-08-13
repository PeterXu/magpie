import console from '../../utils/logger.js';

/**
 * SessionHandler - WebSocket message handler for session management
 *
 * Refactors message routing logic from the original server.
 * Consumes browserSession, streamerPeer, and inputChannel instances
 * and provides a unified handle(msg) method for all message types.
 */
export class SessionHandler {
  constructor({ browserSession, streamerPeer, inputChannel, clientIceServers }) {
    this.browserSession = browserSession;
    this.streamerPeer = streamerPeer;
    this.inputChannel = inputChannel;
    this.clientIceServers = clientIceServers;
  }

  /**
   * Main message handler - routes to appropriate handler method
   * @param {Object} msg - WebSocket message object with type property `t`
   * @returns {Object|null} Response object or null if no response needed
   */
  async handle(msg) {
    switch (msg.t) {
      case 'hi':
        return this.handleHi(msg);
      case 'offer':
        return this.handleOffer(msg);
      case 'navigate':
        return this.handleNavigate(msg);
      case 'back':
        return this.handleBack();
      case 'forward':
        return this.handleForward();
      case 'refresh':
        return this.handleRefresh();
      case 'switch-tab':
        return this.handleSwitchTab(msg);
      case 'close-tab':
        return this.handleCloseTab(msg);
      case 'new-tab':
        return this.handleNewTab();
      case 'status':
        return this.handleStatus();
      case 'mouse':
      case 'wheel':
      case 'key':
      case 'paste':
      case 'copy':
        return this.handleInput(msg);
      default:
        throw new Error(`Unknown message type: ${msg.t}`);
    }
  }

  async handleHi(msg) {
    const id = Math.random().toString(36).substring(2);
    console.log('[SignalHandler]', 'Receive HI message and alloate id=', id);

    const nav = await this.browserSession.getNavState();
    const tabs = this.browserSession.getTabsState();
    const reply = {
      t: 'hello',
      id: `peer_${id}`,
      viewport: this.browserSession.getViewport(),
      url: nav.url,
      canBack: nav.canBack,
      canForward: nav.canForward,
      iceServers: this.clientIceServers,
      magpieCodecs: this.streamerPeer.getSenderCodecs(),
      pages: tabs.pages,
      activeId: tabs.activeId
    };
    return reply;
  }

  /**
   * Handle WebRTC offer message - relay through streamer peer
   * @param {Object} msg - Message with SDP offer
   * @returns {Object} Answer message with SDP
   */
  async handleOffer(msg) {
    const reply = await this.streamerPeer.relayOffer(msg);
    return { t: 'answer', ...reply };
  }

  /**
   * Handle navigate message - navigate to URL
   * @param {Object} msg - Message with target URL
   * @returns {null} No response (URL change broadcast separately)
   */
  async handleNavigate(msg) {
    await this.browserSession.navigate(msg.url);
    // URL change broadcast through onUrlChange, no response needed
    return null;
  }

  /**
   * Handle back navigation
   * @returns {null} No response
   */
  async handleBack() {
    await this.browserSession.goBack();
    return null;
  }

  /**
   * Handle forward navigation
   * @returns {null} No response
   */
  async handleForward() {
    await this.browserSession.goForward();
    return null;
  }

  /**
   * Handle page refresh
   * @returns {null} No response
   */
  async handleRefresh() {
    await this.browserSession.reload();
    return null;
  }

  /**
   * Handle tab switch message
   * @param {Object} msg - Message with tab ID
   * @returns {null} No response
   */
  async handleSwitchTab(msg) {
    await this.browserSession.switchPage(msg.id);
    return null;
  }

  /**
   * Handle tab close message
   * @param {Object} msg - Message with tab ID
   * @returns {null} No response
   */
  async handleCloseTab(msg) {
    await this.browserSession.closePage(msg.id);
    return null;
  }

  /**
   * Handle new tab creation
   * @returns {null} No response
   */
  async handleNewTab() {
    await this.browserSession.newPage();
    return null;
  }

  /**
   * Handle status request - return current viewport and URL
   * @returns {Object} Status message with viewport and URL
   */
  async handleStatus() {
    const viewport = this.browserSession.getViewport();
    const url = this.browserSession.getUrl();
    return { t: 'status', viewport, url };
  }

  /**
   * Handle input messages (mouse, wheel, key, paste, copy)
   * Delegates to input channel
   * @param {Object} msg - Input message
   * @returns {null} No response
   */
  async handleInput(msg) {
    await this.inputChannel.handle(JSON.stringify(msg));
    return null;
  }
}

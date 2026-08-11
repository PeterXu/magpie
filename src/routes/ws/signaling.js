/**
 * Signaling WebSocket Route - Handles WebRTC signaling and session management
 *
 * Provides the /signaling WebSocket endpoint that:
 * - Registers connections with WebSocketManager for broadcast capability
 * - Handles WebRTC offer/answer negotiation
 * - Routes client messages through SessionHandler
 * - Sends initial hello message with viewport, URL, ICE servers, and tab state
 */
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { SessionHandler } from '../../handlers/signaling/SessionHandler.js';

/**
 * Create signaling WebSocket route
 * @param {Object} deps - Dependencies
 * @param {BrowserSession} deps.browserSession - Browser session instance
 * @param {StreamerPeer} deps.streamerPeer - Streamer peer instance
 * @param {InputChannel} deps.inputChannel - Input channel instance
 * @param {Array} deps.clientIceServers - ICE servers for WebRTC
 * @param {WebSocketManager} deps.wsManager - WebSocket manager for broadcasting
 * @returns {Object} Object with wsServer and setup function
 */
export function createSignalingRoute({ browserSession, streamerPeer, inputChannel, clientIceServers, wsManager }) {
  const handler = new SessionHandler({ browserSession, streamerPeer, inputChannel });
  const wsServer = new WebSocketServer({ noServer: true });

  wsServer.on('connection', (ws) => {
    // Register connection with WebSocketManager for broadcast capability
    wsManager.add(ws);

    // Helper to safely send JSON messages
    const send = (obj) => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(JSON.stringify(obj));
        } catch (e) {
          // Ignore send errors - connection may have closed
        }
      }
    };

    // Handle incoming WebSocket messages
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // Ignore malformed JSON
      }

      try {
        const response = await handler.handle(msg);
        if (response) {
          send(response);
        }
      } catch (err) {
        send({ t: 'error', error: String((err && err.message) || err) });
      }
    });

    // Send hello message immediately after connection
    void (async () => {
      const nav = await browserSession.getNavState();
      const tabs = browserSession.getTabsState();
      send({
        t: 'hello',
        viewport: browserSession.getViewport(),
        url: nav.url,
        canBack: nav.canBack,
        canForward: nav.canForward,
        iceServers: clientIceServers,
        magpieCodecs: streamerPeer.getSenderCodecs(),
        pages: tabs.pages,
        activeId: tabs.activeId
      });
    })();
  });

  return { wsServer, path: '/signaling' };
}
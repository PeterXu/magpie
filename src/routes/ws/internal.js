/**
 * Internal WebSocket Route - Handles frame relay from BrowserSession to StreamerPeer
 *
 * Provides the /internal WebSocket endpoint that:
 * - Receives JPEG frames from BrowserSession CDP screencast
 * - Passes the socket to StreamerPeer for frame pushing
 *
 * This is a one-way relay: BrowserSession → Node → StreamerPeer → WebRTC
 */
import { WebSocketServer } from 'ws';

/**
 * Create internal WebSocket route
 * @param {Object} deps - Dependencies
 * @param {StreamerPeer} deps.streamerPeer - Streamer peer instance to receive frames
 * @returns {Object} Object with wsServer and path
 */
export function createInternalRoute({ streamerPeer }) {
  const wsServer = new WebSocketServer({ noServer: true });

  wsServer.on('connection', (ws) => {
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

    // Handle incoming WebSocket messages from internal
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // Ignore malformed JSON
      }

      try {
        const response = await streamerPeer.handle(msg);
        if (response) {
          send(response);
        }
      } catch (err) {
        send({ t: 'error', error: String((err && err.message) || err) });
      }
    });

    ws.on('close', () => streamerPeer.setFrameSocket(null));

    // Pass the WebSocket to StreamerPeer for frame relay
    streamerPeer.setFrameSocket(ws);
  });

  return { wsServer, path: '/internal' };
}

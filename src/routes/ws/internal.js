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
    // Pass the WebSocket to StreamerPeer for frame relay
    streamerPeer.setFrameSocket(ws);
  });

  return { wsServer, path: '/internal' };
}
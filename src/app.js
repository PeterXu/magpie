/**
 * Hono Application Factory
 *
 * Creates and configures the Hono application with all routes and middleware.
 * Uses dependency injection pattern to receive browserSession, streamerPeer,
 * inputChannel, clientIceServers, and wsManager instances.
 *
 * Routes:
 * - HTTP: /healthz (health check), / (static files)
 * - WebSocket: /signaling (WebRTC signaling), /internal (frame relay)
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { app as healthApp } from './routes/health.js';
import { app as staticApp } from './routes/static.js';
import { createSignalingRoute } from './routes/ws/signaling.js';
import { createInternalRoute } from './routes/ws/internal.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './middleware/logger.js';

/**
 * Create and configure the Hono application with WebSocket support
 * @param {Object} deps - Dependencies
 * @param {BrowserSession} deps.browserSession - Browser session instance
 * @param {StreamerPeer} deps.streamerPeer - Streamer peer instance
 * @param {InputChannel} deps.inputChannel - Input channel instance
 * @param {Array} deps.clientIceServers - ICE servers for WebRTC
 * @param {WebSocketManager} deps.wsManager - WebSocket manager for broadcasting
 * @returns {Object} Object with app and wsRoutes for WebSocket upgrade handling
 */
export function createApp({ browserSession, streamerPeer, inputChannel, clientIceServers, wsManager }) {
  const app = new Hono();

  // Apply middleware (before routes)
  app.use('*', errorHandler);
  app.use('*', logger);

  // Mount HTTP routes
  app.route('/healthz', healthApp);
  app.route('/', staticApp);

  // Create WebSocket routes (returns WebSocket servers, not Hono apps)
  const signalingRoute = createSignalingRoute({ browserSession, streamerPeer, inputChannel, clientIceServers, wsManager });
  const internalRoute = createInternalRoute({ streamerPeer });

  return {
    app,
    wsRoutes: [signalingRoute, internalRoute]
  };
}

export { serve };
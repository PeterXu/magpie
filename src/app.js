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
import { app as publicApp } from './routes/public.js';
import { app as staticApp } from './routes/static.js';
import { createSignalingRoute } from './routes/ws/signaling.js';
import { createInternalRoute } from './routes/ws/internal.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './middleware/logger.js';
import { requireAuth } from './middleware/auth.js';
import { loginApp } from './routes/api/login.js';

/**
 * Create and configure the Hono application with WebSocket support
 * @param {Object} deps - Dependencies
 * @param {StreamerPeer} deps.streamerPeer - Streamer peer instance
 * @param {SessionHandler} deps.sessionHandler - Signal session handler
 * @param {WebSocketManager} deps.wsManager - WebSocket manager for broadcasting
 * @param {Object} deps.env - Environment variables for auth
 * @param {Function} deps.getSessionRegistry - Function to get SessionRegistry instance
 * @param {Function} deps.ensureBrowserStarted - Function to start browser if not running
 * @returns {Promise<Object>} Object with app and wsRoutes for WebSocket upgrade handling
 */
export async function createApp({ streamerPeer, sessionHandler, wsManager, env, getSessionRegistry, ensureBrowserStarted }) {
  const app = new Hono();

  // Apply middleware (before routes)
  app.use('*', errorHandler);
  app.use('*', logger);

  // Inject env into context for auth middleware
  app.use('*', (c, next) => {
    c.env = env;
    return next();
  });

  // Public routes (no auth required)
  app.route('/api/login', loginApp);
  app.route('/healthz', healthApp);

  // Public static files (login page, streamer page - internal use)
  app.get('/login.html', async (c) => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const PUBLIC_DIR = path.join(__dirname, './public');
    try {
      const body = await readFile(path.join(PUBLIC_DIR, 'login.html'));
      return c.body(body, 200, { 'Content-Type': 'text/html; charset=utf-8' });
    } catch {
      return c.text('not found', 404);
    }
  });

  app.get('/streamer.html', async (c) => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const STREAMER_DIR = path.join(__dirname, './streamer');
    try {
      const body = await readFile(path.join(STREAMER_DIR, 'streamer.html'));
      return c.body(body, 200, { 'Content-Type': 'text/html; charset=utf-8' });
    } catch {
      return c.text('not found', 404);
    }
  });

  // Mount public HTTP routes
  app.route('/', publicApp);

  // Protected routes (auth required)
  app.use('/*', requireAuth());

  // Mount protected HTTP routes
  app.route('/', staticApp);

  // Sessions API route
  if (getSessionRegistry) {
    const { createSessionsRoute } = await import('./routes/api/sessions.js');
    app.route('/api/sessions', createSessionsRoute({ getSessionRegistry, ensureBrowserStarted }));
  }

  // Create WebSocket routes (returns WebSocket servers, not Hono apps)
  const signalingRoute = createSignalingRoute({ sessionHandler, wsManager });
  const internalRoute = createInternalRoute({ streamerPeer });

  return {
    app,
    wsRoutes: [signalingRoute, internalRoute]
  };
}

export { serve };

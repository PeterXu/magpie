// src/routes/static.js
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '../public');
const STREAMER_DIR = path.join(__dirname, '../streamer');
const WEBRTC_DIR = path.join(__dirname, '../webrtc');

const app = new Hono();

// Skip .well-known requests (Chrome DevTools, etc.)
app.all('/.well-known/*', (c) => {
  return c.text('not found', 404);
});

// 辅助函数：读取并返回文件
async function serveStaticFile(c, filePath, contentType) {
  try {
    const body = await readFile(filePath);
    return c.body(body, 200, { 'Content-Type': contentType });
  } catch {
    return c.text('not found', 404);
  }
}

// 路由定义
app.get('/', async (c) => {
  const filePath = path.join(PUBLIC_DIR, 'client.html');
  return serveStaticFile(c, filePath, 'text/html; charset=utf-8');
});

app.get('/client.html', async (c) => {
  const filePath = path.join(PUBLIC_DIR, 'client.html');
  return serveStaticFile(c, filePath, 'text/html; charset=utf-8');
});

app.get('/login.html', async (c) => {
  const filePath = path.join(PUBLIC_DIR, 'login.html');
  return serveStaticFile(c, filePath, 'text/html; charset=utf-8');
});

app.get('/streamer.html', async (c) => {
  const filePath = path.join(STREAMER_DIR, 'streamer.html');
  return serveStaticFile(c, filePath, 'text/html; charset=utf-8');
});

app.get('/cursor.svg', async (c) => {
  const filePath = path.join(PUBLIC_DIR, 'cursor.svg');
  return serveStaticFile(c, filePath, 'image/svg+xml');
});

// WebRTC 模块文件
const MODULE_FILES = {
  '/codec-pick.js': { file: 'codec-pick.js', type: 'text/javascript' },
  '/EventEmitter.js': { file: 'EventEmitter.js', type: 'text/javascript' },
  '/MagpiePeer.js': { file: 'MagpiePeer.js', type: 'text/javascript' },
  '/MagpieConnection.js': { file: 'MagpieConnection.js', type: 'text/javascript' },
  '/MagpieNegotiator.js': { file: 'MagpieNegotiator.js', type: 'text/javascript' },
  '/MagpieSignalChannel.js': { file: 'MagpieSignalChannel.js', type: 'text/javascript' },
  '/MagpieInputEvents.js': { file: 'MagpieInputEvents.js', type: 'text/javascript' },
};

Object.entries(MODULE_FILES).forEach(([route, config]) => {
  app.get(route, async (c) => {
    const filePath = path.join(WEBRTC_DIR, config.file);
    return serveStaticFile(c, filePath, config.type);
  });
});

export { app };

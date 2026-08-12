// src/routes/public.js
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '../public');

const app = new Hono();

// 辅助函数：读取并返回文件
async function serveStaticFile(c, filePath, contentType) {
  try {
    const body = await readFile(filePath);
    return c.body(body, 200, { 'Content-Type': contentType });
  } catch {
    return c.text('not found', 404);
  }
}

const MODULE_FILES = {
  '/magpie-webrtc.js': { file: 'magpie-webrtc.js', type: 'text/javascript' },
};

Object.entries(MODULE_FILES).forEach(([route, config]) => {
  app.get(route, async (c) => {
    const filePath = path.join(PUBLIC_DIR, config.file);
    return serveStaticFile(c, filePath, config.type);
  });
});

export { app };

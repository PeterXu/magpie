// src/routes/health.js
import { Hono } from 'hono';

const app = new Hono();

app.get('/', (c) => {
  return c.text('ok');
});

export { app };
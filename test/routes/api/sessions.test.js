// test/routes/api/test-sessions.js
import { test } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { Hono } from 'hono';
import { createSessionsRoute } from '../../../src/routes/api/sessions.js';

test('GET /api/sessions returns sessions list', async () => {
  const registry = {
    list: async () => [{ domain: 'example.com', cookieCount: 2 }]
  };

  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({ getSessionRegistry: () => registry }));

  const res = await app.request('/api/sessions');
  strictEqual(res.status, 200);

  const data = await res.json();
  ok(Array.isArray(data.sessions));
  strictEqual(data.sessions[0].domain, 'example.com');
});

test('DELETE /api/sessions/:domain calls registry.delete', async () => {
  let deleted = false;
  const registry = {
    delete: async (domain) => {
      strictEqual(domain, 'example.com');
      deleted = true;
    }
  };

  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({ getSessionRegistry: () => registry }));

  const res = await app.request('/api/sessions/example.com', { method: 'DELETE' });
  strictEqual(res.status, 200);
  ok(deleted);

  const data = await res.json();
  strictEqual(data.success, true);
});

test('POST /api/sessions/:domain/check returns validation result', async () => {
  const registry = {
    check: async (domain, strategy) => {
      strictEqual(domain, 'example.com');
      return { valid: true, details: { strategy } };
    }
  };

  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({ getSessionRegistry: () => registry }));

  const res = await app.request('/api/sessions/example.com/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy: 'quick' })
  });
  strictEqual(res.status, 200);

  const data = await res.json();
  strictEqual(data.valid, true);
});
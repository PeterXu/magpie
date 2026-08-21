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

test('GET /api/sessions/:domain/cookies returns details', async () => {
  const registry = {
    details: async (domain) => {
      strictEqual(domain, 'example.com');
      return {
        domain,
        cookies: [
          { name: 'tok', value: 'abc…', expires: 1756684800, httpOnly: true,
            secure: true, sameSite: 'Lax', path: '/', origin: 'https://example.com' }
        ]
      };
    }
  };

  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({ getSessionRegistry: () => registry }));

  const res = await app.request('/api/sessions/example.com/cookies');
  strictEqual(res.status, 200);

  const data = await res.json();
  strictEqual(data.domain, 'example.com');
  strictEqual(data.cookies[0].name, 'tok');
});

test('GET /api/sessions/:domain/cookies returns 404 for unknown domain', async () => {
  const registry = { details: async () => null };

  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({ getSessionRegistry: () => registry }));

  const res = await app.request('/api/sessions/nomatch.com/cookies');
  strictEqual(res.status, 404);

  const data = await res.json();
  strictEqual(data.error, 'Domain not found');
});

test('DELETE /api/sessions/:domain/cookies/:name calls registry.deleteCookie', async () => {
  let deleted = null;
  const registry = {
    deleteCookie: async (domain, name) => {
      deleted = { domain, name };
    }
  };

  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({ getSessionRegistry: () => registry }));

  const res = await app.request('/api/sessions/example.com/cookies/tok', { method: 'DELETE' });
  strictEqual(res.status, 200);
  strictEqual(deleted.domain, 'example.com');
  strictEqual(deleted.name, 'tok');

  const data = await res.json();
  strictEqual(data.success, true);
});

test('POST /api/sessions/:domain/check defaults to full strategy', async () => {
  let seenStrategy = null;
  const registry = {
    check: async (domain, strategy) => {
      strictEqual(domain, 'example.com');
      seenStrategy = strategy;
      return { valid: true, strategy };
    }
  };
  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({ getSessionRegistry: () => registry }));

  const res = await app.request('/api/sessions/example.com/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})          // no strategy → full
  });
  strictEqual(res.status, 200);
  strictEqual(seenStrategy, 'full');
  strictEqual((await res.json()).valid, true);
});

test('POST /api/sessions/:domain/check starts browser when not running', async () => {
  let registry = null;
  let started = 0;
  const makeRegistry = () => ({
    check: async () => ({ valid: true, strategy: 'full', checkedAt: 1 })
  });
  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({
    getSessionRegistry: () => registry,
    ensureBrowserStarted: async () => { started++; registry = makeRegistry(); }
  }));

  const res = await app.request('/api/sessions/example.com/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  strictEqual(res.status, 200);
  strictEqual(started, 1, 'ensureBrowserStarted called once');
  strictEqual((await res.json()).valid, true);
});

test('POST /api/sessions/:domain/check returns 503 when browser cannot start', async () => {
  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({
    getSessionRegistry: () => null,
    ensureBrowserStarted: async () => {}
  }));
  const res = await app.request('/api/sessions/example.com/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  strictEqual(res.status, 503);
});

test('GET /api/sessions/:domain/check-url returns null when unset', async () => {
  const registry = { getCheckUrl: () => null };
  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({
    getSessionRegistry: () => registry,
    ensureBrowserStarted: async () => {}
  }));

  const res = await app.request('/api/sessions/example.com/check-url');
  strictEqual(res.status, 200);
  strictEqual((await res.json()).url, null);
});


test('PUT /api/sessions/:domain/check-url saves and rejects bad URLs', async () => {
  const saved = {};
  const registry = {
    getCheckUrl: (d) => saved[d] ?? null,
    setCheckUrl: async (d, u) => { saved[d] = u; },
    clearCheckUrl: async (d) => { delete saved[d]; },
  };
  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({
    getSessionRegistry: () => registry,
    ensureBrowserStarted: async () => {}
  }));

  // Valid
  let res = await app.request('/api/sessions/example.com/check-url', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/profile' })
  });
  strictEqual(res.status, 200);
  strictEqual((await res.json()).url, 'https://example.com/profile');

  // Bad scheme → 400
  res = await app.request('/api/sessions/example.com/check-url', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'example.com' })
  });
  strictEqual(res.status, 400);

  // Empty string → delete semantics
  res = await app.request('/api/sessions/example.com/check-url', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: '' })
  });
  strictEqual(res.status, 200);
  strictEqual((await res.json()).url, null);
  strictEqual(saved['example.com'], undefined);
});

test('DELETE /api/sessions/:domain/check-url clears config without browser', async () => {
  let cleared = null;
  const registry = {
    getCheckUrl: () => 'https://x',
    setCheckUrl: async () => {},
    clearCheckUrl: async (d) => { cleared = d; },
  };
  const app = new Hono();
  app.route('/api/sessions', createSessionsRoute({
    getSessionRegistry: () => registry,
    ensureBrowserStarted: async () => {}
  }));

  const res = await app.request('/api/sessions/example.com/check-url', { method: 'DELETE' });
  strictEqual(res.status, 200);
  strictEqual(cleared, 'example.com');
  strictEqual((await res.json()).success, true);
});
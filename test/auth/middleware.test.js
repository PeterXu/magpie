import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { Jwt } from 'hono/utils/jwt';
import { requireAuth, requireWsAuth } from '../../src/middleware/auth.js';

test('requireAuth passes with valid token', async () => {
  const app = new Hono();
  const secret = 'test-secret';

  // Create a valid token
  const payload = { sub: 'admin', role: 'admin', iat: Math.floor(Date.now() / 1000) };
  const token = await Jwt.sign(payload, secret);

  app.use('/protected', requireAuth());
  app.get('/protected', (c) => c.json({ user: c.user }));

  const env = { JWT_SECRET: secret, ADMIN_PASSWORD: 'test-password' };
  const res = await app.request('/protected', {
    headers: { 'Authorization': `Bearer ${token}` }
  }, env);

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.user.sub, 'admin');
  assert.equal(data.user.role, 'admin');
});

test('requireAuth returns 401 without token', async () => {
  const app = new Hono();
  const secret = 'test-secret';

  app.use('/protected', requireAuth());
  app.get('/protected', (c) => c.json({ user: c.user }));

  const env = { JWT_SECRET: secret, ADMIN_PASSWORD: 'test-password' };
  const res = await app.request('/protected', {}, env);

  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, 'Missing authorization token');
});

test('requireAuth returns 401 with invalid token', async () => {
  const app = new Hono();
  const secret = 'test-secret';

  app.use('/protected', requireAuth());
  app.get('/protected', (c) => c.json({ user: c.user }));

  const env = { JWT_SECRET: secret, ADMIN_PASSWORD: 'test-password' };
  const res = await app.request('/protected', {
    headers: { 'Authorization': 'Bearer invalid-token' }
  }, env);

  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, 'Invalid or expired token');
});

test('requireAuth returns 401 with malformed Authorization header', async () => {
  const app = new Hono();
  const secret = 'test-secret';

  app.use('/protected', requireAuth());
  app.get('/protected', (c) => c.json({ user: c.user }));

  const env = { JWT_SECRET: secret, ADMIN_PASSWORD: 'test-password' };
  const res = await app.request('/protected', {
    headers: { 'Authorization': 'Basic abc123' }
  }, env);

  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, 'Missing authorization token');
});

test('requireWsAuth passes with valid token in URL', async () => {
  const app = new Hono();
  const secret = 'test-secret';

  const payload = { sub: 'admin', role: 'admin', iat: Math.floor(Date.now() / 1000) };
  const token = await Jwt.sign(payload, secret);

  app.use('/ws', requireWsAuth());
  app.get('/ws', (c) => c.json({ user: c.user }));

  const env = { JWT_SECRET: secret };
  const res = await app.request(`/ws?token=${token}`, {}, env);

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.user.sub, 'admin');
  assert.equal(data.user.role, 'admin');
});

test('requireWsAuth throws without token', async () => {
  const mw = requireWsAuth();
  const c = { req: { url: 'http://127.0.0.1/ws' }, env: { JWT_SECRET: 'test-secret' } };
  await assert.rejects(() => mw(c, () => {}), /Missing token/);
});

test('requireWsAuth throws with invalid token', async () => {
  const mw = requireWsAuth();
  const c = { req: { url: 'http://127.0.0.1/ws?token=invalid-token' }, env: { JWT_SECRET: 'test-secret' } };
  await assert.rejects(() => mw(c, () => {}), /Invalid token/);
});
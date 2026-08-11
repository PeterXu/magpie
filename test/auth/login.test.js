import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { Jwt } from 'hono/utils/jwt';
import { loginApp } from '../../src/routes/api/login.js';

test('POST /api/login returns token for valid credentials', async () => {
  const app = new Hono();
  app.route('/api/login', loginApp);

  const env = {
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'test-password',
    JWT_SECRET: 'test-secret',
    JWT_EXPIRES_IN: 86400
  };

  const res = await app.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' })
  }, env);

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.token);
  assert.equal(data.expiresIn, 86400);
  assert.deepEqual(data.user, { username: 'admin', role: 'admin' });

  // Verify token
  const payload = await Jwt.verify(data.token, env.JWT_SECRET, 'HS256');
  assert.equal(payload.sub, 'admin');
  assert.equal(payload.role, 'admin');
});

test('POST /api/login returns 401 for invalid credentials', async () => {
  const app = new Hono();
  app.route('/api/login', loginApp);

  const env = {
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'test-password',
    JWT_SECRET: 'test-secret'
  };

  const res = await app.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong-password' })
  }, env);

  assert.equal(res.status, 401);
  const data = await res.json();
  assert.equal(data.error, 'Invalid credentials');
});

test('POST /api/login returns 500 for missing password config', async () => {
  const app = new Hono();
  app.route('/api/login', loginApp);

  const env = {
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: '',
    JWT_SECRET: 'test-secret'
  };

  const res = await app.request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test' })
  }, env);

  assert.equal(res.status, 500);
  const data = await res.json();
  assert.equal(data.error, 'Server misconfiguration');
});
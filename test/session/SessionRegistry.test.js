// test/session/test-SessionRegistry.js
import { test } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { chromium } from 'playwright';
import { SessionRegistry } from '../../src/session/SessionRegistry.js';

test('SessionRegistry.list returns empty array when no cookies', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  const registry = new SessionRegistry({ context });
  const sessions = await registry.list();

  strictEqual(sessions.length, 0);

  await context.close();
  await browser.close();
});

test('SessionRegistry.list groups cookies by domain', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // Add cookies
  await context.addCookies([
    { name: 'session1', value: 'a', domain: 'example.com', path: '/' },
    { name: 'session2', value: 'b', domain: 'example.com', path: '/' },
    { name: 'session3', value: 'c', domain: 'other.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  const sessions = await registry.list();

  strictEqual(sessions.length, 2);
  const example = sessions.find(s => s.domain === 'example.com');
  ok(example);
  strictEqual(example.cookieCount, 2);

  await context.close();
  await browser.close();
});

test('SessionRegistry.delete removes cookies for domain', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  await context.addCookies([
    { name: 'session', value: 'x', domain: 'example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  await registry.delete('example.com');

  const cookies = await context.cookies();
  strictEqual(cookies.length, 0);

  await context.close();
  await browser.close();
});
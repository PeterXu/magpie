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

test('SessionRegistry.list merges host-only subdomain into domain-cookie group', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  await context.addCookies([
    { name: 'a', value: '1', domain: '.baidu.com', path: '/' },
    { name: 'b', value: '2', domain: '.baidu.com', path: '/' },
    { name: 'c', value: '3', domain: 'www.baidu.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  const sessions = await registry.list();

  strictEqual(sessions.length, 1);
  strictEqual(sessions[0].domain, 'baidu.com');
  strictEqual(sessions[0].cookieCount, 3);
  strictEqual(sessions[0].subDomains.length, 1);
  strictEqual(sessions[0].subDomains[0], 'www.baidu.com');

  await context.close();
  await browser.close();
});

test('SessionRegistry.list keeps host-only domains separate without domain cookie', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // No ".example.com" domain cookie — subdomains are separate account systems.
  await context.addCookies([
    { name: 'a', value: '1', domain: 'app.example.com', path: '/' },
    { name: 'b', value: '2', domain: 'login.example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  const sessions = await registry.list();

  strictEqual(sessions.length, 2);
  const domains = sessions.map(s => s.domain).sort();
  strictEqual(domains[0], 'app.example.com');
  strictEqual(domains[1], 'login.example.com');

  await context.close();
  await browser.close();
});

test('SessionRegistry.list folds bare-domain host-only cookie into its domain-cookie group', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // "example.com" (host-only) alongside ".example.com" (domain cookie) — one site.
  await context.addCookies([
    { name: 'a', value: '1', domain: '.example.com', path: '/' },
    { name: 'b', value: '2', domain: 'example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  const sessions = await registry.list();

  strictEqual(sessions.length, 1);
  strictEqual(sessions[0].domain, 'example.com');
  strictEqual(sessions[0].cookieCount, 2);
  strictEqual(sessions[0].subDomains.length, 0);

  await context.close();
  await browser.close();
});

test('SessionRegistry.list joins longest matching group when multiple groups match', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // a.example.co matches both ".example.co" and ".co" groups (if a ".co"
  // domain cookie existed) — longest key wins. Here: two nested groups.
  await context.addCookies([
    { name: 'a', value: '1', domain: '.example.com', path: '/' },
    { name: 'b', value: '2', domain: '.sub.example.com', path: '/' },
    { name: 'c', value: '3', domain: 'x.sub.example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  const sessions = await registry.list();

  // x.sub.example.com ends with ".sub.example.com" (longer) — joins that group,
  // not ".example.com".
  const sub = sessions.find(s => s.domain === 'sub.example.com');
  ok(sub, 'sub.example.com group exists');
  strictEqual(sub.subDomains.length, 1);
  strictEqual(sub.subDomains[0], 'x.sub.example.com');
  const top = sessions.find(s => s.domain === 'example.com');
  ok(top, 'example.com group exists');
  strictEqual(top.subDomains.length, 0);

  await context.close();
  await browser.close();
});

test('SessionRegistry.delete removes whole group including subdomains', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  await context.addCookies([
    { name: 'a', value: '1', domain: '.baidu.com', path: '/' },
    { name: 'b', value: '2', domain: 'www.baidu.com', path: '/' },
    { name: 'keep', value: '3', domain: 'other.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  await registry.delete('baidu.com');

  const cookies = await context.cookies();
  const remaining = cookies.map(c => c.name);
  strictEqual(remaining.length, 1);
  strictEqual(remaining[0], 'keep');

  await context.close();
  await browser.close();
});

test('SessionRegistry.delete does not remove lookalike domains', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  // "notbaidu.com" contains "baidu.com" as a substring — must survive.
  await context.addCookies([
    { name: 'a', value: '1', domain: '.baidu.com', path: '/' },
    { name: 'b', value: '2', domain: '.notbaidu.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  await registry.delete('baidu.com');

  const cookies = await context.cookies();
  strictEqual(cookies.length, 1);
  strictEqual(cookies[0].domain, '.notbaidu.com');

  await context.close();
  await browser.close();
});

test('SessionRegistry.delete on unknown domain is a no-op', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();

  await context.addCookies([
    { name: 'a', value: '1', domain: '.example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ context });
  await registry.delete('nomatch.com'); // must not throw

  const cookies = await context.cookies();
  strictEqual(cookies.length, 1);

  await context.close();
  await browser.close();
});
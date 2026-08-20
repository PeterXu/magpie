// test/session/test-SessionRegistry.js
import { test } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { chromium } from 'playwright';
import { SessionRegistry } from '../../src/session/SessionRegistry.js';

// Build a SessionRegistry over a real Playwright context, mirroring how
// src/index.js passes browserSession (context + pages with CDP sessions).
async function launchRegistry() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const browserSession = {
    _context: context,
    _pages: new Map([[1, { page, cdp }]])
  };
  return { browser, context, browserSession };
}

test('SessionRegistry.list returns empty array when no cookies', async () => {
  const { browser, context, browserSession } = await launchRegistry();

  const registry = new SessionRegistry({ browserSession });
  const sessions = await registry.list();

  strictEqual(sessions.length, 0);

  await context.close();
  await browser.close();
});

test('SessionRegistry.list groups cookies by domain', async () => {
  const { browser, context, browserSession } = await launchRegistry();

  // Add cookies
  await context.addCookies([
    { name: 'session1', value: 'a', domain: 'example.com', path: '/' },
    { name: 'session2', value: 'b', domain: 'example.com', path: '/' },
    { name: 'session3', value: 'c', domain: 'other.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ browserSession });
  const sessions = await registry.list();

  strictEqual(sessions.length, 2);
  const example = sessions.find(s => s.domain === 'example.com');
  ok(example);
  strictEqual(example.cookieCount, 2);

  await context.close();
  await browser.close();
});

test('SessionRegistry.delete removes cookies for domain', async () => {
  const { browser, context, browserSession } = await launchRegistry();

  await context.addCookies([
    { name: 'session', value: 'x', domain: 'example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ browserSession });
  await registry.delete('example.com');

  const cookies = await context.cookies();
  strictEqual(cookies.length, 0);

  await context.close();
  await browser.close();
});

test('SessionRegistry.list merges host-only subdomain into domain-cookie group', async () => {
  const { browser, context, browserSession } = await launchRegistry();

  await context.addCookies([
    { name: 'a', value: '1', domain: '.baidu.com', path: '/' },
    { name: 'b', value: '2', domain: '.baidu.com', path: '/' },
    { name: 'c', value: '3', domain: 'www.baidu.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ browserSession });
  const sessions = await registry.list();

  strictEqual(sessions.length, 1);
  strictEqual(sessions[0].domain, 'baidu.com');
  strictEqual(sessions[0].cookieCount, 3);
  strictEqual(sessions[0].origins.length, 2);
  ok(sessions[0].origins.some(o => o.url === 'http://baidu.com' && o.cookieCount === 2));
  ok(sessions[0].origins.some(o => o.url === 'http://www.baidu.com' && o.cookieCount === 1));

  await context.close();
  await browser.close();
});

test('SessionRegistry.list keeps host-only domains separate without domain cookie', async () => {
  const { browser, context, browserSession } = await launchRegistry();

  // No ".example.com" domain cookie — subdomains are separate account systems.
  await context.addCookies([
    { name: 'a', value: '1', domain: 'app.example.com', path: '/' },
    { name: 'b', value: '2', domain: 'login.example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ browserSession });
  const sessions = await registry.list();

  strictEqual(sessions.length, 2);
  const domains = sessions.map(s => s.domain).sort();
  strictEqual(domains[0], 'app.example.com');
  strictEqual(domains[1], 'login.example.com');

  await context.close();
  await browser.close();
});

test('SessionRegistry.list folds bare-domain host-only cookie into its domain-cookie group', async () => {
  const { browser, context, browserSession } = await launchRegistry();

  // "example.com" (host-only) alongside ".example.com" (domain cookie) — one site.
  await context.addCookies([
    { name: 'a', value: '1', domain: '.example.com', path: '/' },
    { name: 'b', value: '2', domain: 'example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ browserSession });
  const sessions = await registry.list();

  strictEqual(sessions.length, 1);
  strictEqual(sessions[0].domain, 'example.com');
  strictEqual(sessions[0].cookieCount, 2);
  ok(Array.isArray(sessions[0].origins));

  await context.close();
  await browser.close();
});

test('SessionRegistry.list joins longest matching group when multiple groups match', async () => {
  const { browser, context, browserSession } = await launchRegistry();

  // a.example.co matches both ".example.co" and ".co" groups (if a ".co"
  // domain cookie existed) — longest key wins. Here: two nested groups.
  await context.addCookies([
    { name: 'a', value: '1', domain: '.example.com', path: '/' },
    { name: 'b', value: '2', domain: '.sub.example.com', path: '/' },
    { name: 'c', value: '3', domain: 'x.sub.example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ browserSession });
  const sessions = await registry.list();

  // x.sub.example.com ends with ".sub.example.com" (longer) — joins that group,
  // not ".example.com".
  const sub = sessions.find(s => s.domain === 'sub.example.com');
  ok(sub, 'sub.example.com group exists');
  strictEqual(sub.origins.length, 2);
  strictEqual(sub.origins.filter(o => o.url.includes('x.sub.example.com')).length, 1);
  ok(sub.origins.some(o => o.url === 'http://sub.example.com'));
  const top = sessions.find(s => s.domain === 'example.com');
  ok(top, 'example.com group exists');
  strictEqual(top.origins.length, 1);
  strictEqual(top.origins[0].url, 'http://example.com');

  await context.close();
  await browser.close();
});

test('SessionRegistry.delete removes whole group including subdomains', async () => {
  const { browser, context, browserSession } = await launchRegistry();

  await context.addCookies([
    { name: 'a', value: '1', domain: '.baidu.com', path: '/' },
    { name: 'b', value: '2', domain: 'www.baidu.com', path: '/' },
    { name: 'keep', value: '3', domain: 'other.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ browserSession });
  await registry.delete('baidu.com');

  const cookies = await context.cookies();
  const remaining = cookies.map(c => c.name);
  strictEqual(remaining.length, 1);
  strictEqual(remaining[0], 'keep');

  await context.close();
  await browser.close();
});

test('SessionRegistry.delete does not remove lookalike domains', async () => {
  const { browser, context, browserSession } = await launchRegistry();

  // "notbaidu.com" contains "baidu.com" as a substring — must survive.
  await context.addCookies([
    { name: 'a', value: '1', domain: '.baidu.com', path: '/' },
    { name: 'b', value: '2', domain: '.notbaidu.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ browserSession });
  await registry.delete('baidu.com');

  const cookies = await context.cookies();
  strictEqual(cookies.length, 1);
  strictEqual(cookies[0].domain, '.notbaidu.com');

  await context.close();
  await browser.close();
});

test('SessionRegistry.delete on unknown domain is a no-op', async () => {
  const { browser, context, browserSession } = await launchRegistry();

  await context.addCookies([
    { name: 'a', value: '1', domain: '.example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ browserSession });
  await registry.delete('nomatch.com'); // must not throw

  const cookies = await context.cookies();
  strictEqual(cookies.length, 1);

  await context.close();
  await browser.close();
});

test('SessionRegistry.list splits same-host cookies into per-origin entries', async () => {
  const { browser, context, browserSession } = await launchRegistry();
  const page = browserSession._pages.get(1).page;

  // Two HTTP servers on different ports, same host 127.0.0.1.
  const http = await import('node:http');
  const mkServer = (cookieName) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Set-Cookie', `${cookieName}=1; Path=/`);
      res.end('ok');
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
  };
  const srvA = await mkServer('aaa');
  const srvB = await mkServer('bbb');
  const portA = srvA.address().port;
  const portB = srvB.address().port;

  await page.goto(`http://127.0.0.1:${portA}/`);
  await page.goto(`http://127.0.0.1:${portB}/`);

  const registry = new SessionRegistry({ browserSession });
  const sessions = await registry.list();

  strictEqual(sessions.length, 1);
  strictEqual(sessions[0].domain, '127.0.0.1');
  strictEqual(sessions[0].cookieCount, 2);
  const urls = sessions[0].origins.map(o => o.url).sort();
  strictEqual(urls[0], `http://127.0.0.1:${portA}`);
  strictEqual(urls[1], `http://127.0.0.1:${portB}`);

  srvA.close(); srvB.close();
  await context.close();
  await browser.close();
});

test('SessionRegistry.list omits default ports and maps Secure scheme', async () => {
  // Inject cookies through the registry's own code path shape: raw CDP-style
  // cookies with sourcePort/sourceScheme, via a stub _pages entry.
  const fakeCdp = {
    send: async (method, params) => {
      strictEqual(method, 'Network.getCookies');
      ok(Array.isArray(params.urls));
      return {
        cookies: [
          { name: 's', value: '1', domain: 'secure.example.com', path: '/', sourcePort: 443, sourceScheme: 'Secure' },
          { name: 'p', value: '1', domain: 'plain.example.com', path: '/', sourcePort: 80, sourceScheme: 'NonSecure' },
          { name: 'q', value: '1', domain: 'odd.example.com', path: '/', sourcePort: 8443, sourceScheme: 'Secure' },
        ]
      };
    }
  };
  const contextStub = {
    cookies: async () => [
      { name: 's', value: '1', domain: 'secure.example.com', path: '/' },
      { name: 'p', value: '1', domain: 'plain.example.com', path: '/' },
      { name: 'q', value: '1', domain: 'odd.example.com', path: '/' },
    ],
    clearCookies: async () => {}
  };
  const registry = new SessionRegistry({
    browserSession: { _context: contextStub, _pages: new Map([[1, { cdp: fakeCdp }]]) }
  });
  const sessions = await registry.list();

  const byDomain = Object.fromEntries(sessions.map(s => [s.domain, s]));
  strictEqual(byDomain['secure.example.com'].origins[0].url, 'https://secure.example.com');
  strictEqual(byDomain['plain.example.com'].origins[0].url, 'http://plain.example.com');
  strictEqual(byDomain['odd.example.com'].origins[0].url, 'https://odd.example.com:8443');
});

test('SessionRegistry.list omits port when sourcePort missing', async () => {
  const fakeCdp = {
    send: async () => ({
      cookies: [
        { name: 'x', value: '1', domain: 'unknown.example.com', path: '/' },
      ]
    })
  };
  const contextStub = {
    cookies: async () => [{ name: 'x', value: '1', domain: 'unknown.example.com', path: '/' }],
    clearCookies: async () => {}
  };
  const registry = new SessionRegistry({
    browserSession: { _context: contextStub, _pages: new Map([[1, { cdp: fakeCdp }]]) }
  });
  const sessions = await registry.list();

  strictEqual(sessions.length, 1);
  strictEqual(sessions[0].origins[0].url, 'http://unknown.example.com');
});

test('SessionRegistry.details truncates long values', async () => {
  const longValue = 'a'.repeat(40);
  const fakeCdp = {
    send: async () => ({
      cookies: [
        { name: 'tok', value: longValue, domain: '.example.com', path: '/',
          expires: 1756684800, httpOnly: true, secure: true, sameSite: 'Lax',
          sourcePort: 443, sourceScheme: 'Secure' },
      ]
    })
  };
  const contextStub = {
    cookies: async () => [{ name: 'tok', value: longValue, domain: '.example.com', path: '/' }],
    clearCookies: async () => {}
  };
  const registry = new SessionRegistry({
    browserSession: { _context: contextStub, _pages: new Map([[1, { cdp: fakeCdp }]]) }
  });

  const result = await registry.details('example.com');

  strictEqual(result.cookies[0].value.length, 25);
  ok(result.cookies[0].value.endsWith('…'));
});

test('SessionRegistry.details passes session cookie expires as 0', async () => {
  const fakeCdp = {
    send: async () => ({
      cookies: [
        { name: 'sid', value: 'x', domain: 'host.example.com', path: '/',
          expires: -1, httpOnly: false, secure: false, sameSite: 'Unspecified',
          sourcePort: 8080, sourceScheme: 'NonSecure' },
      ]
    })
  };
  const contextStub = {
    cookies: async () => [{ name: 'sid', value: 'x', domain: 'host.example.com', path: '/' }],
    clearCookies: async () => {}
  };
  const registry = new SessionRegistry({
    browserSession: { _context: contextStub, _pages: new Map([[1, { cdp: fakeCdp }]]) }
  });

  const result = await registry.details('host.example.com');

  strictEqual(result.cookies[0].expires, 0);
  strictEqual(result.cookies[0].origin, 'http://host.example.com:8080');
});

test('SessionRegistry.details returns only the group cookies', async () => {
  const fakeCdp = {
    send: async () => ({
      cookies: [
        { name: 'a', value: '1', domain: '.baidu.com', path: '/', expires: 100, httpOnly: false, secure: false, sameSite: 'Unspecified', sourcePort: 443, sourceScheme: 'Secure' },
        { name: 'b', value: '2', domain: 'www.baidu.com', path: '/', expires: 100, httpOnly: false, secure: false, sameSite: 'Unspecified', sourcePort: 443, sourceScheme: 'Secure' },
        { name: 'c', value: '3', domain: 'other.com', path: '/', expires: 100, httpOnly: false, secure: false, sameSite: 'Unspecified', sourcePort: 80, sourceScheme: 'NonSecure' },
      ]
    })
  };
  const contextStub = {
    cookies: async () => [
      { name: 'a', value: '1', domain: '.baidu.com', path: '/' },
      { name: 'b', value: '2', domain: 'www.baidu.com', path: '/' },
      { name: 'c', value: '3', domain: 'other.com', path: '/' },
    ],
    clearCookies: async () => {}
  };
  const registry = new SessionRegistry({
    browserSession: { _context: contextStub, _pages: new Map([[1, { cdp: fakeCdp }]]) }
  });

  const result = await registry.details('baidu.com');

  strictEqual(result.cookies.length, 2);
  ok(result.cookies.every(c => ['a', 'b'].includes(c.name)));
});

test('SessionRegistry.details returns null for unknown domain', async () => {
  const fakeCdp = { send: async () => ({ cookies: [] }) };
  const contextStub = { cookies: async () => [], clearCookies: async () => {} };
  const registry = new SessionRegistry({
    browserSession: { _context: contextStub, _pages: new Map([[1, { cdp: fakeCdp }]]) }
  });

  strictEqual(await registry.details('nomatch.com'), null);
});

test('SessionRegistry.deleteCookie removes only the named cookie', async () => {
  const { browser, context, browserSession } = await launchRegistry();

  await context.addCookies([
    { name: 'target', value: '1', domain: 'example.com', path: '/' },
    { name: 'keep', value: '2', domain: 'example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ browserSession });
  await registry.deleteCookie('example.com', 'target');

  const remaining = (await context.cookies()).map(c => c.name);
  strictEqual(remaining.length, 1);
  strictEqual(remaining[0], 'keep');

  await context.close();
  await browser.close();
});

test('SessionRegistry.deleteCookie is a no-op for unknown domain or name', async () => {
  const { browser, context, browserSession } = await launchRegistry();

  await context.addCookies([
    { name: 'keep', value: '2', domain: 'example.com', path: '/' },
  ]);

  const registry = new SessionRegistry({ browserSession });
  await registry.deleteCookie('nomatch.com', 'whatever'); // must not throw
  await registry.deleteCookie('example.com', 'absent');   // must not throw

  const remaining = (await context.cookies()).map(c => c.name);
  strictEqual(remaining.length, 1);
  strictEqual(remaining[0], 'keep');

  await context.close();
  await browser.close();
});
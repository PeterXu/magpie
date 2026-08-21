// src/session/SessionRegistry.js
import { logger } from '../utils/logger.js';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

const CHECK_GOTO_TIMEOUT_MS = 15_000;  // single-domain full check budget
const CHECK_STABLE_POLL_MS = 500;      // SPA redirect-chain settle poll interval
const CHECK_STABLE_MAX_MS = 5_000;     // max settle wait
const CHECK_RATE_LIMIT_MS = 10_000;    // same-domain re-check cooldown
const LOGIN_URL_RE = /login|signin|sign-in|auth|passport/i;

// Risk control: random delay before validation (ms)
const CHECK_DELAY_MIN_MS = 500;
const CHECK_DELAY_MAX_MS = 1500;

// Login detection signals (CSS selectors)
const LOGGED_IN_SIGNALS = [
  // User profile elements
  '[class*="avatar"]', '[class*="user"]', '[class*="profile"]', '[class*="account"]',
  '[id*="avatar"]', '[id*="user"]', '[id*="profile"]', '[id*="account"]',
  // Logout links (strong indicator of logged-in state)
  'a[href*="logout"]', 'a[href*="signout"]', 'a[href*="logoff"]',
  // Common user menu patterns
  '.user-menu', '.user-dropdown', '.profile-menu', '.account-menu'
];

const LOGIN_LINK_SIGNALS = [
  // Login/Register links
  'a[href*="login"]', 'a[href*="signin"]', 'a[href*="register"]', 'a[href*="signup"]',
  // Common login button classes
  '.login-btn', '.signin-btn', '.register-btn', '.signup-btn',
  // Password input (already detected separately)
  'input[type=password]'
];

/**
 * SessionRegistry - 管理已保存的登录状态
 *
 * 读：Playwright 枚举 cookie domains + CDP Network.getCookies 取
 * sourcePort/sourceScheme（cookie 无端口号，CDP 记录了下发来源）。
 * 删：Playwright clearCookies 按 domain 组精确清除。
 */
export class SessionRegistry {
  constructor({ browserSession }) {
    this._browserSession = browserSession;
    this._checkResults = new Map();   // domain → last check result (memory only)
    this._checkInFlight = new Map();  // domain → in-flight check Promise
    this._lastCheckAt = new Map();    // domain → ms timestamp (rate limiting)
    this._checkUrls = new Map();      // domain → user-configured check URL
    this._checkUrlsFile = this._deriveCheckUrlsFile();
    this._checkUrlsReady = this._loadCheckUrls();
  }

  // Internal: any page's CDP session works — Network.getCookies is a
  // storage-level query; urls param selects which cookies come back.
  get _cdp() {
    const entry = this._browserSession._pages.values().next().value;
    return entry ? entry.cdp : null;
  }

  // Internal: fetch all cookies with sourcePort/sourceScheme. Two steps:
  // Playwright context.cookies() enumerates every cookie's domain, then one
  // batched CDP query with those URLs returns the CDP fields. (A no-arg CDP
  // call only returns cookies tied to the querying page's URLs.)
  async _fetchCookies() {
    const context = this._browserSession._context;
    const cdp = this._cdp;
    if (!context || !cdp) return [];
    const base = await context.cookies();
    if (base.length === 0) return [];
    const urls = [...new Set(base.flatMap(c => {
      const host = c.domain.replace(/^\./, '');
      return [`http://${host}/`, `https://${host}/`];
    }))];
    const { cookies } = await cdp.send('Network.getCookies', { urls });
    return cookies;
  }

  // Internal: build the origin URL a cookie belongs to.
  // sourcePort missing/0 → omit port. Default ports (443/80) omitted.
  _cookieOrigin(cookie) {
    const scheme = cookie.sourceScheme === 'Secure' ? 'https' : 'http';
    const host = cookie.domain.replace(/^\./, '');
    const { sourcePort } = cookie;
    const port = sourcePort && !((scheme === 'https' && sourcePort === 443) || (scheme === 'http' && sourcePort === 80))
      ? `:${sourcePort}` : '';
    return `${scheme}://${host}${port}`;
  }

  /**
   * 获取所有 domain 分组及其统计（组内按 origin 细分）
   * @returns {Promise<Array<{domain: string, cookieCount: number, origins: Array<{url: string, cookieCount: number}>}>>}
   */
  async list() {
    const cookies = await this._fetchCookies();
    const groups = this._groupCookies(cookies);

    const items = [...groups.entries()]
      .map(([domain, g]) => {
        const item = {
          domain,
          cookieCount: g.cookieCount,
          origins: [...g.origins.entries()]
            .map(([url, count]) => ({ url, cookieCount: count }))
            .sort((a, b) => b.cookieCount - a.cookieCount)
        };
        const lastCheckResult = this._checkResults.get(domain);
        if (lastCheckResult) {
          item.lastCheck = {
            valid: lastCheckResult.valid,
            strategy: lastCheckResult.strategy,
            checkedAt: lastCheckResult.checkedAt,
          };
        }
        const checkUrl = this._checkUrls.get(domain);
        if (checkUrl) {
          item.checkUrl = checkUrl;
        }
        return item;
      })
      // Stable sort: cookieCount desc, then domain asc (preserves order on refresh)
      .sort((a, b) => b.cookieCount - a.cookieCount || a.domain.localeCompare(b.domain));

    // Append group-level check results that have no cookie group entries
    // (i.e., check('grouproot.com') ran but the domain has no cookies stored)
    const knownDomains = new Set(items.map(i => i.domain));
    for (const [domain, checkResult] of this._checkResults.entries()) {
      if (!knownDomains.has(domain)) {
        items.push({
          domain,
          cookieCount: 0,
          origins: [],
          lastCheck: {
            valid: checkResult.valid,
            strategy: checkResult.strategy,
            checkedAt: checkResult.checkedAt,
          },
        });
      }
    }

    return items;
  }

  // Internal: group cookies into domain-keyed entries (level 1: cookie
  // semantics) with per-origin counts (level 2).
  //
  // Domain cookies (".baidu.com") become group keys ("baidu.com") — the site
  // declares its subdomains share login state. Host-only cookies join the
  // longest matching group key, fold into a same-key group, or form their
  // own group when no domain cookie claims them.
  //
  // rawDomains keeps the cookie domains verbatim (leading dot preserved) so
  // delete() can clear each exact value without substring-matching collateral.
  _groupCookies(cookies) {
    const groups = new Map(); // key -> { cookieCount, origins: Map, rawDomains: Set, rawCookies: [] }

    const bucket = (key) => {
      let g = groups.get(key);
      if (!g) { g = { cookieCount: 0, origins: new Map(), rawDomains: new Set(), rawCookies: [] }; groups.set(key, g); }
      return g;
    };
    const tally = (g, cookie) => {
      g.cookieCount += 1;
      g.rawDomains.add(cookie.domain);
      g.rawCookies.push(cookie);
      const url = this._cookieOrigin(cookie);
      g.origins.set(url, (g.origins.get(url) || 0) + 1);
    };

    // Pass 1: domain cookies (leading dot) establish shared groups.
    for (const cookie of cookies) {
      if (!cookie.domain.startsWith('.')) continue;
      tally(bucket(cookie.domain.slice(1)), cookie);
    }

    // Pass 2: host-only cookies join the longest matching shared group.
    for (const cookie of cookies) {
      if (cookie.domain.startsWith('.')) continue;
      let target = null;
      for (const key of groups.keys()) {
        if (cookie.domain.endsWith('.' + key) && (!target || key.length > target.length)) {
          target = key;
        }
      }
      if (target) {
        tally(groups.get(target), cookie);
      } else if (groups.has(cookie.domain)) {
        // Bare-domain host-only cookie alongside ".example.com" — same site.
        tally(groups.get(cookie.domain), cookie);
      } else {
        tally(bucket(cookie.domain), cookie);
      }
    }

    return groups;
  }

  /**
   * 删除指定 domain 分组的全部 cookies（组键 domain cookie + 所有子域）
   * 按组内 cookie 的原始 domain 值（保留前导点）逐个清除，
   * 不使用组键子串匹配，避免误删相似后缀域名。
   * @param {string} domain - 组键（list() 返回的 domain 字段）
   */
  async delete(domain) {
    const context = this._browserSession._context;
    if (!context) return;
    const cookies = await this._fetchCookies();
    const group = this._groupCookies(cookies).get(domain);
    if (!group) return;
    for (const raw of group.rawDomains) {
      await context.clearCookies({ domain: raw });
    }
    logger.log(`[SessionRegistry] Deleted cookie group: ${domain} (${group.rawDomains.size} domains)`);
  }

  /**
   * 获取指定 domain 分组的 cookie 明细（value 截断，不含完整凭证）
   * @param {string} domain - 组键（list() 返回的 domain 字段）
   * @returns {Promise<{domain: string, cookies: Array<{name: string, value: string, expires: number, httpOnly: boolean, secure: boolean, sameSite: string, path: string, origin: string}>} | null>}
   *          组不存在返回 null
   */
  async details(domain) {
    const cookies = await this._fetchCookies();
    const group = this._groupCookies(cookies).get(domain);
    if (!group) return null;
    return {
      domain,
      cookies: group.rawCookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value.length > 24 ? cookie.value.slice(0, 24) + '…' : cookie.value,
        expires: cookie.expires > 0 ? cookie.expires : 0,
        httpOnly: Boolean(cookie.httpOnly),
        secure: Boolean(cookie.secure),
        sameSite: cookie.sameSite ?? 'Unspecified',
        path: cookie.path,
        origin: this._cookieOrigin(cookie)
      }))
    };
  }

  /**
   * 删除指定 domain 分组内某个 name 的 cookies（name+domain 精确匹配）
   * 组不存在或无匹配时 no-op
   * @param {string} domain - 组键
   * @param {string} name - cookie 名
   */
  async deleteCookie(domain, name) {
    const context = this._browserSession._context;
    if (!context) return;
    const cookies = await this._fetchCookies();
    const group = this._groupCookies(cookies).get(domain);
    if (!group) return;
    const hasName = group.rawCookies.some(cookie => cookie.name === name);
    if (!hasName) return;
    for (const raw of group.rawDomains) {
      await context.clearCookies({ name, domain: raw });
    }
    logger.log(`[SessionRegistry] Deleted cookie: ${name}@${domain}`);
  }

  /**
   * 验证登录态
   * quick: cookie 存在性。full: 隐藏页访问 + 重定向/密码框信号 → 三态。
   * @param {string} domain
   * @param {string} strategy - 'quick' | 'full' | 'custom'
   * @param {{timeoutMs?: number, checkUrl?: string}} [opts] - 测试注入(生产用默认 15s)
   * @returns {Promise<{valid: boolean|null, strategy: string, checkedAt: number, finalUrl?: string, signals?: object, note?: string}>}
   */
  async check(domain, strategy = 'quick', { timeoutMs = CHECK_GOTO_TIMEOUT_MS, checkUrl } = {}) {
    if (strategy === 'quick') {
      const cookies = await this._fetchCookies();
      const hasCookies = cookies.some(c => c.domain.includes(domain));
      return this._recordCheck(domain, { valid: hasCookies, strategy });
    }
    if (strategy === 'full') {
      return this._fullCheck(domain, timeoutMs, checkUrl);
    }
    return this._recordCheck(domain, { valid: null, strategy, note: 'not-implemented' });
  }

  // Internal: config file path — sibling browser-data/ of the profile dir,
  // else cwd browser-data/. The profile dir itself is Chromium-owned and may
  // be wiped by the browser, so the config lives one level up.
  _deriveCheckUrlsFile() {
    const userDataDir = this._browserSession._userDataDir;
    const base = userDataDir ? path.dirname(userDataDir) : process.cwd();
    return path.join(base, 'browser-data', 'session-check-urls.json');
  }

  // Internal: read config into _checkUrls. Missing file → empty. Corrupt →
  // empty + one log line (config is user-fixable, don't crash the registry).
  // Returns a promise that resolves when loading completes.
  _loadCheckUrls() {
    return readFile(this._checkUrlsFile, 'utf8')
      .then(text => {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof k === 'string' && typeof v === 'string') this._checkUrls.set(k, v);
          }
        }
      })
      .catch(() => { /* missing or corrupt: start empty */ });
  }

  // Public config API — GET/PUT/DELETE /api/sessions/:domain/check-url back onto these.
  getCheckUrl(domain) {
    return this._checkUrls.get(domain) ?? null;
  }

  async setCheckUrl(domain, url) {
    await this._checkUrlsReady;
    this._checkUrls.set(domain, url);
    await this._persistCheckUrls();
    logger.log(`[SessionRegistry] Check URL set: ${domain} → ${url}`);
  }

  async clearCheckUrl(domain) {
    await this._checkUrlsReady;
    this._checkUrls.delete(domain);
    await this._persistCheckUrls();
    logger.log(`[SessionRegistry] Check URL cleared: ${domain}`);
  }

  // Internal: atomic write — tmp file + rename, so a crash mid-write never
  // leaves a half-written config behind.
  async _persistCheckUrls() {
    const file = this._checkUrlsFile;
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this._checkUrls), null, 2));
    await rename(tmp, file);
  }

  // Internal: store result and stamp the rate-limit clock.
  _recordCheck(domain, result) {
    const entry = { ...result, checkedAt: Date.now() };
    this._checkResults.set(domain, entry);
    this._lastCheckAt.set(domain, entry.checkedAt);
    return entry;
  }

  // Internal: full strategy — hidden page visit, two signals, three states.
  async _fullCheck(domain, timeoutMs, overrideUrl) {
    const inFlight = this._checkInFlight.get(domain);
    if (inFlight) return inFlight;

    const lastAt = this._lastCheckAt.get(domain) ?? 0;
    if (Date.now() - lastAt < CHECK_RATE_LIMIT_MS) {
      const prev = this._checkResults.get(domain);
      if (prev) return { ...prev, note: 'rate-limited' };
    }

    const promise = this._doFullCheck(domain, timeoutMs, overrideUrl)
      .finally(() => this._checkInFlight.delete(domain));
    this._checkInFlight.set(domain, promise);
    return promise;
  }

  async _doFullCheck(domain, timeoutMs, overrideUrl) {
    const browserSession = this._browserSession;
    if (!browserSession._context) {
      return this._recordCheck(domain, { valid: null, strategy: 'full', note: 'browser-not-running' });
    }
    const cookies = await this._fetchCookies();
    const group = this._groupCookies(cookies).get(domain);
    const checkUrl = overrideUrl
      ?? this._checkUrls.get(domain)
      ?? this._pickCheckUrl(group, domain);

    const page = await browserSession.openHiddenPage();
    if (!page) {
      return this._recordCheck(domain, { valid: null, strategy: 'full', note: 'browser-not-running' });
    }
    try {
      // Risk control: random delay before validation
      await this._randomDelay();

      const finalUrl = await this._gotoStable(page, checkUrl, timeoutMs);
      const redirectedToLogin = LOGIN_URL_RE.test(finalUrl);

      // Detect signals
      const loginSignals = await this._detectLoginSignals(page);
      const loggedInSignals = await this._detectLoggedInSignals(page);

      // Scoring system:
      // +1 for each logged-in signal (user profile, logout link)
      // -1 for each login signal (password input, login link)
      // Final: score >= 1 → logged in; score <= -1 → not logged in; else unknown
      const score = loggedInSignals.score - loginSignals.score - (redirectedToLogin ? 1 : 0);

      let valid;
      if (score >= 1) {
        valid = true;  // Logged in
      } else if (score <= -1) {
        valid = false; // Not logged in
      } else {
        valid = null;  // Unknown
      }

      return this._recordCheck(domain, {
        valid,
        strategy: 'full',
        finalUrl,
        signals: {
          redirectedToLogin,
          loggedIn: loggedInSignals.detected,
          login: loginSignals.detected,
          score
        },
      });
    } catch (err) {
      const timedOut = /Timeout .*exceeded/i.test(String(err?.message));
      return this._recordCheck(domain, {
        valid: null, strategy: 'full',
        note: timedOut ? 'timeout' : 'nav-error',
      });
    } finally {
      await browserSession.closeHiddenPage(page);
    }
  }

  // Internal: navigate, then wait out SPA redirect chains — poll until the
  // URL stops changing (or the settle budget runs out).
  async _gotoStable(page, url, timeoutMs) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    let last = page.url();
    const deadline = Date.now() + CHECK_STABLE_MAX_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, CHECK_STABLE_POLL_MS));
      const current = page.url();
      if (current === last) break;
      last = current;
    }
    return last;
  }

  // Internal: detect logged-in signals on the page (user profile, logout links, etc.)
  async _detectLoggedInSignals(page) {
    let score = 0;
    const detected = [];

    for (const selector of LOGGED_IN_SIGNALS) {
      try {
        const count = await page.$$eval(selector, els => els.length).catch(() => 0);
        if (count > 0) {
          score += 1;
          detected.push(selector);
          logger.debug(`[SessionRegistry] Logged-in signal: ${selector} (${count})`);
        }
      } catch {}
    }

    return { score, detected };
  }

  // Internal: detect login/logout signals on the page (login links, password inputs, etc.)
  async _detectLoginSignals(page) {
    let score = 0;
    const detected = [];

    for (const selector of LOGIN_LINK_SIGNALS) {
      try {
        const count = await page.$$eval(selector, els => els.length).catch(() => 0);
        if (count > 0) {
          score += 1;
          detected.push(selector);
          logger.debug(`[SessionRegistry] Login signal: ${selector} (${count})`);
        }
      } catch {}
    }

    // Additional: detect links by text content (登录/注册/登录/注册)
    try {
      const loginTexts = await page.$$eval('a', links =>
        links.filter(link =>
          /(登录|注册|登錄|註冊|sign in|log in|sign up|log in)/i.test(link.textContent)
        ).length
      ).catch(() => 0);
      if (loginTexts > 0) {
        score += 1;
        detected.push('a:text(登录/注册)');
        logger.debug(`[SessionRegistry] Login signal: a:text(登录/注册) (${loginTexts})`);
      }
    } catch {}

    return { score, detected };
  }

  // Internal: random delay for risk control (avoid triggering anti-bot systems)
  async _randomDelay() {
    const delay = CHECK_DELAY_MIN_MS + Math.random() * (CHECK_DELAY_MAX_MS - CHECK_DELAY_MIN_MS);
    await new Promise(r => setTimeout(r, delay));
  }

  // Internal: best origin to probe — most cookies carried; else scheme-guess.
  _pickCheckUrl(group, domain) {
    if (group && group.origins && group.origins.size > 0) {
      let bestUrl = null, bestCount = -1;
      for (const [url, count] of group.origins) {
        if (count > bestCount) { bestUrl = url; bestCount = count; }
      }
      return bestUrl;
    }
    return `https://${domain}`;
  }
}

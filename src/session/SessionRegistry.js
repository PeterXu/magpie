// src/session/SessionRegistry.js
import { logger } from '../utils/logger.js';

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

    return [...groups.entries()]
      .map(([domain, g]) => ({
        domain,
        cookieCount: g.cookieCount,
        origins: [...g.origins.entries()]
          .map(([url, count]) => ({ url, cookieCount: count }))
          .sort((a, b) => b.cookieCount - a.cookieCount)
      }))
      .sort((a, b) => b.cookieCount - a.cookieCount);
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
   * 验证登录态（quick 策略：仅检查 cookie 存在性）
   * @param {string} domain
   * @param {string} strategy - 'quick' | 'full' | 'custom'
   * @returns {Promise<{valid: boolean, details: object}>}
   */
  async check(domain, strategy = 'quick') {
    if (strategy === 'quick') {
      const cookies = await this._fetchCookies();
      const hasCookies = cookies.some(c => c.domain.includes(domain));
      return {
        valid: hasCookies,
        details: { strategy: 'quick', cookieFound: hasCookies }
      };
    }
    // full 和 custom 策略在后续任务中实现
    return { valid: false, details: { strategy, message: 'Not implemented' } };
  }
}

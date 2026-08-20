// src/session/SessionRegistry.js
import { logger } from '../utils/logger.js';

/**
 * SessionRegistry - 管理已保存的登录状态
 *
 * 通过 Playwright API 获取/删除 cookies
 */
export class SessionRegistry {
  constructor({ context }) {
    this._context = context;
  }

  /**
   * 获取所有 domain 分组及其统计
   * @returns {Promise<Array<{domain: string, cookieCount: number, subDomains: string[]}>>}
   */
  async list() {
    if (!this._context) return [];

    const cookies = await this._context.cookies();
    const groups = this._groupCookies(cookies);

    return [...groups.entries()]
      .map(([domain, g]) => ({ domain, cookieCount: g.cookieCount, subDomains: [...g.subDomains] }))
      .sort((a, b) => b.cookieCount - a.cookieCount);
  }

  // Internal: group cookies into domain-keyed entries.
  // Domain cookies (".baidu.com") become group keys ("baidu.com") — the site
  // declares its subdomains share login state. Host-only cookies join the
  // longest matching group key (www.baidu.com ends with ".baidu.com"), fold
  // into a same-key group (bare "example.com" vs ".example.com"), or form
  // their own group when no domain cookie claims them.
  //
  // rawDomains keeps the cookie domains verbatim (leading dot preserved) so
  // delete() can clear each exact value without substring-matching collateral.
  _groupCookies(cookies) {
    const groups = new Map(); // key -> { cookieCount, subDomains: Set, rawDomains: Set }

    // Pass 1: domain cookies (leading dot) establish shared groups.
    for (const cookie of cookies) {
      if (!cookie.domain.startsWith('.')) continue;
      const key = cookie.domain.slice(1);
      let g = groups.get(key);
      if (!g) { g = { cookieCount: 0, subDomains: new Set(), rawDomains: new Set() }; groups.set(key, g); }
      g.cookieCount += 1;
      g.rawDomains.add(cookie.domain);
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
        const g = groups.get(target);
        g.cookieCount += 1;
        g.subDomains.add(cookie.domain);
        g.rawDomains.add(cookie.domain);
      } else if (groups.has(cookie.domain)) {
        // Bare-domain host-only cookie alongside ".example.com" — same site.
        const g = groups.get(cookie.domain);
        g.cookieCount += 1;
        g.rawDomains.add(cookie.domain);
      } else {
        groups.set(cookie.domain, { cookieCount: 1, subDomains: new Set(), rawDomains: new Set([cookie.domain]) });
      }
    }

    return groups;
  }

  /**
   * 删除指定 domain 分组的全部 cookies（组键 domain cookie + 所有 subDomains）
   * 按组内 cookie 的原始 domain 值（保留前导点）逐个清除，
   * 不使用组键子串匹配，避免误删相似后缀域名。
   * @param {string} domain - 组键（list() 返回的 domain 字段）
   */
  async delete(domain) {
    if (!this._context) return;
    const cookies = await this._context.cookies();
    const group = this._groupCookies(cookies).get(domain);
    if (!group) return;
    for (const raw of group.rawDomains) {
      await this._context.clearCookies({ domain: raw });
    }
    logger.log(`[SessionRegistry] Deleted cookie group: ${domain} (${group.rawDomains.size} domains)`);
  }

  /**
   * 验证登录态（quick 策略：仅检查 cookie 存在性）
   * @param {string} domain
   * @param {string} strategy - 'quick' | 'full' | 'custom'
   * @returns {Promise<{valid: boolean, details: object}>}
   */
  async check(domain, strategy = 'quick') {
    if (strategy === 'quick') {
      const cookies = await this._context.cookies();
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
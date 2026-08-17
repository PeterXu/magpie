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
   * 获取所有 domain 及其 cookie 数量
   * @returns {Promise<Array<{domain: string, cookieCount: number}>>}
   */
  async list() {
    if (!this._context) return [];

    const cookies = await this._context.cookies();
    const domainMap = new Map();

    for (const cookie of cookies) {
      // 去掉前导点
      const domain = cookie.domain.replace(/^\./, '');
      domainMap.set(domain, (domainMap.get(domain) || 0) + 1);
    }

    return [...domainMap.entries()]
      .map(([domain, cookieCount]) => ({ domain, cookieCount }))
      .sort((a, b) => b.cookieCount - a.cookieCount);
  }

  /**
   * 删除指定 domain 的所有 cookies
   * @param {string} domain
   */
  async delete(domain) {
    if (!this._context) return;
    await this._context.clearCookies({ domain });
    logger.log(`[SessionRegistry] Deleted cookies for domain: ${domain}`);
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
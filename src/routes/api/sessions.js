// src/routes/api/sessions.js
import { Hono } from 'hono';

/**
 * 创建 sessions REST API 路由
 * @param {Object} deps - 依赖
 * @param {Function} deps.getSessionRegistry - 获取 SessionRegistry 实例的函数
 * @param {Function} deps.ensureBrowserStarted - 启动浏览器的函数（若未运行）
 */
export function createSessionsRoute({ getSessionRegistry, ensureBrowserStarted }) {
  const app = new Hono();

  // 获取已保存的登录态列表
  app.get('/', async (c) => {
    let sessionRegistry = getSessionRegistry();
    if (!sessionRegistry) {
      // Browser not running — try to start it
      if (ensureBrowserStarted) {
        await ensureBrowserStarted();
        sessionRegistry = getSessionRegistry();
      }
      if (!sessionRegistry) {
        return c.json({ error: 'Session registry not available' }, 503);
      }
    }
    const sessions = await sessionRegistry.list();
    return c.json({ sessions });
  });

  // 删除指定 domain 的 cookies
  app.delete('/:domain', async (c) => {
    const sessionRegistry = getSessionRegistry();
    if (!sessionRegistry) {
      return c.json({ error: 'Session registry not available' }, 503);
    }
    const domain = c.req.param('domain');
    await sessionRegistry.delete(domain);
    return c.json({ success: true });
  });

  // 验证登录态
  app.post('/:domain/check', async (c) => {
    const sessionRegistry = getSessionRegistry();
    if (!sessionRegistry) {
      return c.json({ error: 'Session registry not available' }, 503);
    }
    const domain = c.req.param('domain');
    const body = await c.req.json().catch(() => ({}));
    const strategy = body.strategy || 'quick';
    const result = await sessionRegistry.check(domain, strategy);
    return c.json(result);
  });

  // 获取指定 domain 的 cookie 明细
  app.get('/:domain/cookies', async (c) => {
    const sessionRegistry = getSessionRegistry();
    if (!sessionRegistry) {
      return c.json({ error: 'Session registry not available' }, 503);
    }
    const domain = c.req.param('domain');
    const result = await sessionRegistry.details(domain);
    if (!result) {
      return c.json({ error: 'Domain not found' }, 404);
    }
    return c.json(result);
  });

  // 删除指定 domain 内某个 name 的 cookies
  app.delete('/:domain/cookies/:name', async (c) => {
    const sessionRegistry = getSessionRegistry();
    if (!sessionRegistry) {
      return c.json({ error: 'Session registry not available' }, 503);
    }
    const domain = c.req.param('domain');
    const name = c.req.param('name');
    await sessionRegistry.deleteCookie(domain, name);
    return c.json({ success: true });
  });

  // 访问该网站（在远程浏览器中打开）
  app.post('/:domain/visit', async (c) => {
    const domain = c.req.param('domain');
    // 由 SessionHandler 处理导航
    return c.json({ success: true, url: `https://${domain}` });
  });

  return app;
}
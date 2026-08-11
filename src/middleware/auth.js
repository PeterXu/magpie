// src/middleware/auth.js
import { Jwt } from 'hono/utils/jwt';
import { getCookie } from 'hono/cookie';

/**
 * HTTP 路由认证中间件
 * 验证 Authorization: Bearer <token> 或 Cookie: token=<token>
 * 当 ADMIN_PASSWORD 为空时跳过认证（用于测试环境）
 *
 * 浏览器请求：重定向到登录页面
 * API 请求：返回 401 JSON 错误
 */
export function requireAuth() {
  return async (c, next) => {
    // Skip auth when ADMIN_PASSWORD is empty (test mode)
    if (!c.env.ADMIN_PASSWORD || c.env.ADMIN_PASSWORD === '') {
      c.user = { sub: 'test-user', role: 'admin' };
      return next();
    }

    // Check Authorization header first
    let token = null;
    const authHeader = c.req.header('Authorization');

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else {
      // Fallback to cookie
      token = getCookie(c, 'token');
    }

    if (!token) {
      // Check if this is a browser request (expecting HTML)
      const acceptHeader = c.req.header('Accept') || '';
      const isBrowserRequest = acceptHeader.includes('text/html');

      if (isBrowserRequest) {
        // Redirect browser to login page
        return c.redirect('/login.html', 302);
      } else {
        // Return JSON error for API requests
        return c.json({ error: 'Missing authorization token' }, 401);
      }
    }

    try {
      const payload = await Jwt.verify(token, c.env.JWT_SECRET, 'HS256');
      c.user = payload;  // 注入用户信息到 context
      await next();
    } catch (err) {
      // Check if this is a browser request (expecting HTML)
      const acceptHeader = c.req.header('Accept') || '';
      const isBrowserRequest = acceptHeader.includes('text/html');

      if (isBrowserRequest) {
        // Redirect browser to login page
        return c.redirect('/login.html', 302);
      } else {
        // Return JSON error for API requests
        return c.json({ error: 'Invalid or expired token' }, 401);
      }
    }
  };
}

/**
 * WebSocket 认证中间件
 * 从 URL 参数验证 token
 */
export function requireWsAuth() {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const token = url.searchParams.get('token');

    if (!token) {
      throw new Error('Missing token');
    }

    try {
      const payload = await Jwt.verify(token, c.env.JWT_SECRET, 'HS256');
      c.user = payload;
      await next();
    } catch (err) {
      throw new Error('Invalid token');
    }
  };
}
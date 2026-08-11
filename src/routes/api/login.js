import { Hono } from 'hono';
import { Jwt } from 'hono/utils/jwt';
import { setCookie } from 'hono/cookie';

const app = new Hono();

app.post('/', async (c) => {
  const { username, password } = await c.req.json();

  // 从环境变量读取用户凭证
  const adminUser = c.env.ADMIN_USER || 'admin';
  const adminPassword = c.env.ADMIN_PASSWORD;

  // 检查配置
  if (!adminPassword) {
    return c.json({ error: 'Server misconfiguration' }, 500);
  }

  // 验证用户名和密码
  if (username !== adminUser || password !== adminPassword) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  // 生成 JWT
  const payload = {
    sub: username,
    role: 'admin',
    iat: Math.floor(Date.now() / 1000)
  };

  const expiresIn = c.env.JWT_EXPIRES_IN || 86400;
  const token = await Jwt.sign(payload, c.env.JWT_SECRET);

  // Set token as cookie (browser will automatically send it)
  setCookie(c, 'token', token, {
    httpOnly: false,  // Allow JavaScript to read it
    maxAge: expiresIn,
    path: '/',
    sameSite: 'Strict'
  });

  return c.json({
    token,
    expiresIn,
    user: { username, role: 'admin' }
  });
});

export { app as loginApp };
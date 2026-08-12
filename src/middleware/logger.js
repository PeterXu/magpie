// src/middleware/logger.js
export async function logger(c, next) {
  const start = Date.now();
  const { method, url } = c.req;

  await next();

  // Filter out healthz and static module requests (reduce log noise)
  if (url.includes('/healthz') ||
      url.includes('/cursor.svg')) {
    return;
  }

  const ms = Date.now() - start;
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0]; // HH:MM:SS
  console.log(`${timestamp} ${method} ${url} ${c.res.status} ${ms}ms`);
}

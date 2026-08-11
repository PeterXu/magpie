// src/middleware/logger.js
export async function logger(c, next) {
  const start = Date.now();
  const { method, url } = c.req;

  console.log(`--> ${method} ${url}`);

  await next();

  const ms = Date.now() - start;
  console.log(`<-- ${method} ${url} ${c.res.status} ${ms}ms`);
}
// src/middleware/errorHandler.js

export async function errorHandler(c, next) {
  try {
    await next();
  } catch (err) {
    console.error('Unhandled error:', err);
    return c.json(
      { error: 'Internal Server Error', message: err.message },
      500
    );
  }
}
import { NextFunction, Request, Response } from 'express';

const memoryStore = new Map<string, { count: number; resetAt: number }>();

export function rateLimitMiddleware(limit = 120, windowMs = 60_000) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const ip = request.ip || 'unknown';
    const now = Date.now();
    const current = memoryStore.get(ip);

    if (!current || current.resetAt < now) {
      memoryStore.set(ip, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (current.count >= limit) {
      response.status(429).json({
        message: 'Too many requests',
        code: 'RATE_LIMITED'
      });
      return;
    }

    current.count += 1;
    memoryStore.set(ip, current);
    next();
  };
}

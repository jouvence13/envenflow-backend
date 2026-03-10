import { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../errors/UnauthorizedError';
import { verifyAccessToken } from '../utils/tokens';

export function authMiddleware(request: Request, _response: Response, next: NextFunction): void {
  const authHeader = request.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or invalid Bearer token');
  }

  const token = authHeader.replace('Bearer ', '').trim();

  if (!token) {
    throw new UnauthorizedError('Missing access token');
  }

  const payload = verifyAccessToken(token);

  if (!payload) {
    throw new UnauthorizedError('Invalid or expired access token');
  }

  request.user = {
    id: payload.sub,
    roles: payload.roles
  };

  next();
}

import { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../errors/UnauthorizedError';

export function roleMiddleware(allowedRoles: string[]) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    const userRoles = request.user?.roles ?? [];
    const hasRole = allowedRoles.some((role) => userRoles.includes(role));

    if (!hasRole) {
      throw new UnauthorizedError('Insufficient permissions');
    }

    next();
  };
}

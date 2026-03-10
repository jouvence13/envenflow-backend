import { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { ValidationError } from '../errors/ValidationError';

export function validateMiddleware<T>(schema: ZodSchema<T>) {
  return (request: Request, _response: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(request.body);

    if (!parsed.success) {
      throw new ValidationError('Invalid request body', parsed.error.flatten());
    }

    request.body = parsed.data;
    next();
  };
}

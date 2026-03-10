import { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/AppError';

export function errorMiddleware(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction
): void {
  if (error instanceof AppError) {
    response.status(error.statusCode).json({
      message: error.message,
      code: error.code,
      details: error.details
    });
    return;
  }

  response.status(500).json({
    message: 'Internal server error',
    code: 'INTERNAL_ERROR'
  });
}

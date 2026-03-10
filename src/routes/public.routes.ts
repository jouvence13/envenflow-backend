import { Router } from 'express';

export const publicRoutes = Router();

publicRoutes.get('/public/ping', (_request, response) => {
  response.status(200).json({ message: 'pong' });
});

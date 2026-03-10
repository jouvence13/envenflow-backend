import { Router } from 'express';
import { authMiddleware } from '../core/middleware/auth.middleware';

export const contestRoutes = Router();

contestRoutes.get('/contests', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
contestRoutes.get('/contests/:slug', (_request, response) => response.status(501).json({ message: 'Not implemented' }));

contestRoutes.use('/contests', authMiddleware);

contestRoutes.post('/contests', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
contestRoutes.patch('/contests/:id', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
contestRoutes.post('/contests/:id/votes', (_request, response) => response.status(501).json({ message: 'Not implemented' }));

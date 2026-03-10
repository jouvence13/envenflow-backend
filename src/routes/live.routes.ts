import { Router } from 'express';
import { authMiddleware } from '../core/middleware/auth.middleware';

export const liveRoutes = Router();

liveRoutes.get('/lives', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
liveRoutes.get('/lives/:slug', (_request, response) => response.status(501).json({ message: 'Not implemented' }));

liveRoutes.use('/lives', authMiddleware);

liveRoutes.post('/lives', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
liveRoutes.post('/lives/:id/join', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
liveRoutes.post('/lives/:id/chat', (_request, response) => response.status(501).json({ message: 'Not implemented' }));

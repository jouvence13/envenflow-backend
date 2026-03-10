import { Router } from 'express';
import { authMiddleware } from '../core/middleware/auth.middleware';

export const eventRoutes = Router();

eventRoutes.get('/events', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
eventRoutes.get('/events/:slug', (_request, response) => response.status(501).json({ message: 'Not implemented' }));

eventRoutes.use('/events', authMiddleware);
eventRoutes.use('/tickets', authMiddleware);

eventRoutes.post('/events', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
eventRoutes.patch('/events/:id', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
eventRoutes.post('/events/:id/ticket-types', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
eventRoutes.post('/tickets/:id/scan', (_request, response) => response.status(501).json({ message: 'Not implemented' }));

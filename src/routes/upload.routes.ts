import { Router } from 'express';
import { authMiddleware } from '../core/middleware/auth.middleware';

export const uploadRoutes = Router();

uploadRoutes.use('/uploads', authMiddleware);

uploadRoutes.post('/uploads', (_request, response) => response.status(501).json({ message: 'Not implemented' }));

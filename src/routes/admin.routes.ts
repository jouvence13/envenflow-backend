import { Router } from 'express';
import { authMiddleware } from '../core/middleware/auth.middleware';
import { roleMiddleware } from '../core/middleware/role.middleware';

export const adminRoutes = Router();

adminRoutes.use(authMiddleware, roleMiddleware(['admin']));

adminRoutes.get('/admin/dashboard', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
adminRoutes.get('/admin/store-applications', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
adminRoutes.patch('/admin/store-applications/:id/review', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
adminRoutes.get('/admin/organizer-applications', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
adminRoutes.patch('/admin/organizer-applications/:id/review', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
adminRoutes.patch('/admin/products/:id/moderate', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
adminRoutes.patch('/admin/events/:id/moderate', (_request, response) => response.status(501).json({ message: 'Not implemented' }));

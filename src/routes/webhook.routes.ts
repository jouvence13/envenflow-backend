import { Router } from 'express';

export const webhookRoutes = Router();

webhookRoutes.post('/payments/webhooks/kkiapay', (_request, response) => response.status(200).json({ received: true }));
webhookRoutes.post('/payments/webhooks/fedapay', (_request, response) => response.status(200).json({ received: true }));
webhookRoutes.post('/payments/webhooks/stripe', (_request, response) => response.status(200).json({ received: true }));

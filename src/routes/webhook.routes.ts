import { Router } from 'express';
import { asyncHandler } from '../core/middleware/async.middleware';
import { handleFedapayWebhook } from '../modules/payments/webhooks/fedapay.webhook';

export const webhookRoutes = Router();

webhookRoutes.post('/payments/webhooks/kkiapay', (_request, response) => response.status(200).json({ received: true }));
webhookRoutes.post(
	'/payments/webhooks/fedapay',
	asyncHandler(async (request, response) => {
		const result = await handleFedapayWebhook(request);

		response.status(200).json(result);
	})
);
webhookRoutes.post('/payments/webhooks/stripe', (_request, response) => response.status(200).json({ received: true }));

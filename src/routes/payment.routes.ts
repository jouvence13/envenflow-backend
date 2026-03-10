import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { authMiddleware } from '../core/middleware/auth.middleware';
import { asyncHandler } from '../core/middleware/async.middleware';
import { prisma } from '../libs/prisma';
import { ValidationError } from '../core/errors/ValidationError';
import { NotFoundError } from '../core/errors/NotFoundError';
import { paymentGateway } from '../libs/payment';

export const paymentRoutes = Router();

paymentRoutes.use('/payments', authMiddleware);

const initializePaymentSchema = z
	.object({
		paymentMethodCode: z.string().min(2),
		orderReference: z.string().optional(),
		storeOrderReference: z.string().optional()
	})
	.refine((value) => Boolean(value.orderReference || value.storeOrderReference), {
		message: 'orderReference or storeOrderReference is required'
	});

function toNumber(value: unknown) {
	return Number(value || 0);
}

paymentRoutes.post(
	'/payments/initialize',
	asyncHandler(async (request, response) => {
		const parsed = initializePaymentSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid payment initialization payload', parsed.error.flatten());
		}

		const payload = parsed.data;

		const paymentMethod = await prisma.paymentMethod.findFirst({
			where: {
				code: payload.paymentMethodCode,
				isActive: true
			}
		});

		if (!paymentMethod) {
			throw new ValidationError('Payment method unavailable');
		}

		let order: any = null;
		let storeOrder: any = null;
		let amount = 0;
		let currency = 'XOF';

		if (payload.storeOrderReference) {
			storeOrder = await prisma.storeOrder.findUnique({
				where: { reference: payload.storeOrderReference },
				include: {
					order: {
						select: {
							id: true,
							userId: true,
							reference: true
						}
					},
					payments: {
						where: {
							status: {
								in: ['PENDING', 'AUTHORIZED', 'SUCCEEDED']
							}
						},
						select: {
							id: true
						}
					}
				}
			});

			if (!storeOrder || storeOrder.order.userId !== request.user!.id) {
				throw new NotFoundError('Store order not found');
			}

			if (storeOrder.payments.length > 0) {
				throw new ValidationError('A payment is already in progress for this store order');
			}

			order = storeOrder.order;
			amount = toNumber(storeOrder.total);
			currency = storeOrder.currency;
		} else {
			order = await prisma.order.findFirst({
				where: {
					reference: payload.orderReference,
					userId: request.user!.id
				},
				include: {
					payments: {
						where: {
							status: {
								in: ['PENDING', 'AUTHORIZED', 'SUCCEEDED']
							}
						},
						select: {
							id: true
						}
					}
				}
			});

			if (!order) {
				throw new NotFoundError('Order not found');
			}

			if (order.payments.length > 0) {
				throw new ValidationError('A payment is already in progress for this order');
			}

			amount = toNumber(order.total);
			currency = order.currency;
		}

		if (amount <= 0) {
			throw new ValidationError('Invalid payable amount');
		}

		const paymentReference = `PAY-${Date.now()}-${randomUUID().slice(0, 8).toUpperCase()}`;

		const gatewayResult = await paymentGateway.initialize({
			provider: paymentMethod.provider,
			amount,
			currency,
			reference: paymentReference
		});

		const payment = await prisma.payment.create({
			data: {
				reference: paymentReference,
				orderId: order.id,
				storeOrderId: storeOrder?.id,
				paymentMethodId: paymentMethod.id,
				provider: paymentMethod.provider,
				status: 'PENDING',
				amount,
				currency,
				providerPaymentId: gatewayResult.providerReference,
				providerTransactionRef: gatewayResult.providerReference,
				metadata: {
					paymentUrl: gatewayResult.paymentUrl,
					initializedAt: new Date().toISOString()
				},
				createdByUserId: request.user!.id,
				expiresAt: new Date(Date.now() + 30 * 60 * 1000)
			},
			include: {
				paymentMethod: {
					select: {
						code: true,
						label: true,
						provider: true
					}
				}
			}
		});

		await prisma.paymentAttempt.create({
			data: {
				paymentId: payment.id,
				status: 'INITIATED',
				providerRequestId: gatewayResult.providerReference,
				requestPayload: {
					amount,
					currency,
					provider: paymentMethod.provider,
					reference: paymentReference
				},
				responsePayload: gatewayResult,
				actorUserId: request.user!.id,
				completedAt: new Date()
			}
		});

		response.status(201).json({
			paymentId: payment.id,
			paymentReference: payment.reference,
			orderReference: order.reference,
			storeOrderReference: storeOrder?.reference || null,
			provider: payment.provider,
			amount: toNumber(payment.amount),
			currency: payment.currency,
			paymentUrl: gatewayResult.paymentUrl,
			providerReference: gatewayResult.providerReference,
			status: payment.status
		});
	})
);

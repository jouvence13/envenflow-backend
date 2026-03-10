import { Router } from 'express';
import { authMiddleware } from '../core/middleware/auth.middleware';
import { asyncHandler } from '../core/middleware/async.middleware';
import { prisma } from '../libs/prisma';
import { NotFoundError } from '../core/errors/NotFoundError';

export const orderRoutes = Router();

orderRoutes.use('/orders', authMiddleware);

orderRoutes.get(
	'/orders',
	asyncHandler(async (request, response) => {
		const page = Math.max(1, Number(request.query.page) || 1);
		const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));

		const where = { userId: request.user!.id };

		const [orders, total] = await Promise.all([
			prisma.order.findMany({
				where,
				orderBy: { createdAt: 'desc' },
				skip: (page - 1) * limit,
				take: limit,
				include: {
					storeOrders: {
						include: {
							store: {
								select: {
									id: true,
									name: true,
									slug: true
								}
							}
						}
					},
					payments: {
						orderBy: { createdAt: 'desc' },
						take: 3
					}
				}
			}),
			prisma.order.count({ where })
		]);

		response.status(200).json({
			data: orders,
			meta: {
				page,
				limit,
				total,
				totalPages: Math.max(1, Math.ceil(total / limit))
			}
		});
	})
);

orderRoutes.get(
	'/orders/:reference',
	asyncHandler(async (request, response) => {
		const order = await prisma.order.findFirst({
			where: {
				reference: request.params.reference,
				userId: request.user!.id
			},
			include: {
				items: true,
				storeOrders: {
					include: {
						store: {
							select: {
								id: true,
								name: true,
								slug: true
							}
						},
						items: true,
						deliveries: true,
						payments: true,
						statusHistory: {
							orderBy: { createdAt: 'desc' }
						}
					}
				},
				deliveries: true,
				payments: {
					include: {
						paymentMethod: true,
						attempts: {
							orderBy: { createdAt: 'desc' }
						}
					},
					orderBy: { createdAt: 'desc' }
				},
				statusHistory: {
					include: {
						changedBy: {
							select: { id: true, email: true }
						}
					},
					orderBy: { createdAt: 'desc' }
				}
			}
		});

		if (!order) {
			throw new NotFoundError('Order not found');
		}

		response.status(200).json(order);
	})
);

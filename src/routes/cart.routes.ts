import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { authMiddleware } from '../core/middleware/auth.middleware';
import { asyncHandler } from '../core/middleware/async.middleware';
import { prisma } from '../libs/prisma';
import { ValidationError } from '../core/errors/ValidationError';
import { NotFoundError } from '../core/errors/NotFoundError';

export const cartRoutes = Router();

cartRoutes.use('/cart', authMiddleware);
cartRoutes.use('/checkout', authMiddleware);

const addItemSchema = z.object({
	productId: z.string().min(1),
	variantId: z.string().optional(),
	quantity: z.number().int().min(1).max(100)
});

const updateItemSchema = z.object({
	quantity: z.number().int().min(1).max(100)
});

const checkoutContactSchema = z.object({
	fullName: z.string().min(2),
	email: z.string().email(),
	phone: z.string().min(6)
});

const checkoutDeliverySchema = z.object({
	mode: z.enum(['DOMICILE', 'RETRAIT', 'GPS_POINT']),
	country: z.string().optional(),
	city: z.string().optional(),
	addressLine1: z.string().optional(),
	addressLine2: z.string().optional(),
	postalCode: z.string().optional(),
	latitude: z.number().optional(),
	longitude: z.number().optional(),
	notes: z.string().max(1000).optional()
});

const checkoutSummarySchema = z.object({
	notes: z.string().max(2000).optional(),
	promoCode: z.string().optional()
});

const checkoutConfirmSchema = z.object({
	paymentMethodCode: z.string().min(2)
});

function decimalToNumber(value: unknown): number {
	return Number(value || 0);
}

async function getOrCreateCart(userId: string) {
	const existing = await prisma.cart.findUnique({ where: { userId } });

	if (!existing) {
		return prisma.cart.create({
			data: {
				userId,
				status: 'ACTIVE',
				currency: 'XOF'
			}
		});
	}

	if (existing.status !== 'ACTIVE') {
		return prisma.cart.update({
			where: { id: existing.id },
			data: { status: 'ACTIVE' }
		});
	}

	return existing;
}

function buildCartResponse(cart: any) {
	const items = cart.items.map((item: any) => {
		const unitPrice = decimalToNumber(item.unitPrice);
		const lineTotal = unitPrice * item.quantity;

		return {
			id: item.id,
			quantity: item.quantity,
			unitPrice,
			lineTotal,
			product: {
				id: item.product.id,
				name: item.product.name,
				slug: item.product.slug,
				stock: item.product.stock,
				store: {
					id: item.product.store.id,
					name: item.product.store.name,
					slug: item.product.store.slug
				}
			},
			variant: item.variant
		};
	});

	const subtotal = items.reduce((sum: number, item: any) => sum + item.lineTotal, 0);

	return {
		id: cart.id,
		status: cart.status,
		currency: cart.currency,
		items,
		subtotal
	};
}

async function getCheckoutSummaryData(cartId: string) {
	const cart = await prisma.cart.findUnique({
		where: { id: cartId },
		include: {
			items: {
				include: {
					product: {
						include: {
							store: true
						}
					},
					variant: true
				}
			}
		}
	});

	if (!cart) {
		throw new NotFoundError('Cart not found');
	}

	const storesMap = new Map<string, any>();
	let subtotal = 0;

	for (const item of cart.items) {
		const unitPrice = decimalToNumber(item.unitPrice);
		const lineTotal = unitPrice * item.quantity;
		subtotal += lineTotal;

		const storeId = item.product.storeId;

		if (!storesMap.has(storeId)) {
			storesMap.set(storeId, {
				storeId,
				storeName: item.product.store.name,
				storeSlug: item.product.store.slug,
				subtotal: 0,
				items: []
			});
		}

		const bucket = storesMap.get(storeId);
		bucket.subtotal += lineTotal;
		bucket.items.push({
			id: item.id,
			productId: item.productId,
			productName: item.product.name,
			quantity: item.quantity,
			unitPrice,
			lineTotal,
			variantId: item.variantId,
			variant: item.variant
				? {
						id: item.variant.id,
						size: item.variant.size,
						color: item.variant.color
					}
				: null
		});
	}

	const stores = Array.from(storesMap.values()).map((store) => ({
		...store,
		deliveryFee: 0,
		total: store.subtotal
	}));

	return {
		stores,
		subtotal,
		deliveryFee: 0,
		discount: 0,
		total: subtotal
	};
}

cartRoutes.get(
	'/cart',
	asyncHandler(async (request, response) => {
		const cart = await getOrCreateCart(request.user!.id);
		const hydrated = await prisma.cart.findUnique({
			where: { id: cart.id },
			include: {
				items: {
					orderBy: { createdAt: 'desc' },
					include: {
						product: {
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
						variant: true
					}
				}
			}
		});

		response.status(200).json(buildCartResponse(hydrated));
	})
);

cartRoutes.post(
	'/cart/items',
	asyncHandler(async (request, response) => {
		const parsed = addItemSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid cart item payload', parsed.error.flatten());
		}

		const payload = parsed.data;
		const cart = await getOrCreateCart(request.user!.id);

		const product = await prisma.product.findFirst({
			where: {
				id: payload.productId,
				publicationStatus: 'PUBLISHED',
				status: 'ACTIVE'
			},
			include: {
				store: true,
				variants: payload.variantId
					? {
							where: { id: payload.variantId },
							take: 1
						}
					: false
			}
		});

		if (!product) {
			throw new NotFoundError('Product not available');
		}

		const variant = payload.variantId ? product.variants[0] : null;

		if (payload.variantId && !variant) {
			throw new ValidationError('Variant not found for product');
		}

		const stockAvailable = variant ? variant.stock : product.stock;

		const existing = await prisma.cartItem.findFirst({
			where: {
				cartId: cart.id,
				productId: payload.productId,
				variantId: payload.variantId || null
			}
		});

		const requestedQuantity = existing ? existing.quantity + payload.quantity : payload.quantity;

		if (requestedQuantity > stockAvailable) {
			throw new ValidationError('Insufficient stock for this item');
		}

		const unitPrice = decimalToNumber(product.price) + (variant ? decimalToNumber(variant.priceDelta) : 0);

		let item;
		if (existing) {
			item = await prisma.cartItem.update({
				where: { id: existing.id },
				data: {
					quantity: requestedQuantity,
					unitPrice,
					oldUnitPrice: product.oldPrice
				}
			});
		} else {
			item = await prisma.cartItem.create({
				data: {
					cartId: cart.id,
					productId: payload.productId,
					variantId: payload.variantId,
					quantity: payload.quantity,
					unitPrice,
					oldUnitPrice: product.oldPrice
				}
			});
		}

		response.status(201).json(item);
	})
);

cartRoutes.patch(
	'/cart/items/:id',
	asyncHandler(async (request, response) => {
		const parsed = updateItemSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid cart item payload', parsed.error.flatten());
		}

		const item = await prisma.cartItem.findUnique({
			where: { id: request.params.id },
			include: {
				cart: true,
				product: true,
				variant: true
			}
		});

		if (!item || item.cart.userId !== request.user!.id) {
			throw new NotFoundError('Cart item not found');
		}

		const stockAvailable = item.variant ? item.variant.stock : item.product.stock;

		if (parsed.data.quantity > stockAvailable) {
			throw new ValidationError('Insufficient stock for this item');
		}

		const updated = await prisma.cartItem.update({
			where: { id: item.id },
			data: {
				quantity: parsed.data.quantity
			}
		});

		response.status(200).json(updated);
	})
);

cartRoutes.delete(
	'/cart/items/:id',
	asyncHandler(async (request, response) => {
		const item = await prisma.cartItem.findUnique({
			where: { id: request.params.id },
			include: {
				cart: {
					select: {
						userId: true
					}
				}
			}
		});

		if (!item || item.cart.userId !== request.user!.id) {
			throw new NotFoundError('Cart item not found');
		}

		await prisma.cartItem.delete({
			where: { id: request.params.id }
		});

		response.status(204).send();
	})
);

cartRoutes.post(
	'/checkout/contact',
	asyncHandler(async (request, response) => {
		const parsed = checkoutContactSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid checkout contact payload', parsed.error.flatten());
		}

		const cart = await getOrCreateCart(request.user!.id);
		const count = await prisma.cartItem.count({ where: { cartId: cart.id } });
		if (count === 0) {
			throw new ValidationError('Cart is empty');
		}

		const session = await prisma.checkoutSession.upsert({
			where: { cartId: cart.id },
			update: {
				status: 'ACTIVE',
				step: 'DELIVERY',
				contactData: parsed.data,
				expiresAt: new Date(Date.now() + 60 * 60 * 1000)
			},
			create: {
				userId: request.user!.id,
				cartId: cart.id,
				status: 'ACTIVE',
				step: 'DELIVERY',
				contactData: parsed.data,
				expiresAt: new Date(Date.now() + 60 * 60 * 1000)
			}
		});

		response.status(200).json(session);
	})
);

cartRoutes.post(
	'/checkout/delivery',
	asyncHandler(async (request, response) => {
		const parsed = checkoutDeliverySchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid checkout delivery payload', parsed.error.flatten());
		}

		const cart = await getOrCreateCart(request.user!.id);

		const session = await prisma.checkoutSession.upsert({
			where: { cartId: cart.id },
			update: {
				status: 'ACTIVE',
				step: 'SUMMARY',
				deliveryData: parsed.data,
				expiresAt: new Date(Date.now() + 60 * 60 * 1000)
			},
			create: {
				userId: request.user!.id,
				cartId: cart.id,
				status: 'ACTIVE',
				step: 'SUMMARY',
				deliveryData: parsed.data,
				expiresAt: new Date(Date.now() + 60 * 60 * 1000)
			}
		});

		response.status(200).json(session);
	})
);

cartRoutes.post(
	'/checkout/summary',
	asyncHandler(async (request, response) => {
		const parsed = checkoutSummarySchema.safeParse(request.body || {});

		if (!parsed.success) {
			throw new ValidationError('Invalid checkout summary payload', parsed.error.flatten());
		}

		const cart = await getOrCreateCart(request.user!.id);
		const summary = await getCheckoutSummaryData(cart.id);

		const session = await prisma.checkoutSession.upsert({
			where: { cartId: cart.id },
			update: {
				status: 'ACTIVE',
				step: 'PAYMENT',
				summaryData: {
					...summary,
					notes: parsed.data.notes,
					promoCode: parsed.data.promoCode
				},
				expiresAt: new Date(Date.now() + 60 * 60 * 1000)
			},
			create: {
				userId: request.user!.id,
				cartId: cart.id,
				status: 'ACTIVE',
				step: 'PAYMENT',
				summaryData: {
					...summary,
					notes: parsed.data.notes,
					promoCode: parsed.data.promoCode
				},
				expiresAt: new Date(Date.now() + 60 * 60 * 1000)
			}
		});

		response.status(200).json({
			checkoutSessionId: session.id,
			summary
		});
	})
);

cartRoutes.post(
	'/checkout/confirm',
	asyncHandler(async (request, response) => {
		const parsed = checkoutConfirmSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid checkout confirmation payload', parsed.error.flatten());
		}

		const cart = await prisma.cart.findUnique({
			where: { userId: request.user!.id },
			include: {
				items: {
					include: {
						product: {
							include: {
								store: true
							}
						},
						variant: true
					}
				}
			}
		});

		if (!cart || cart.items.length === 0) {
			throw new ValidationError('Cart is empty');
		}

		const checkoutSession = await prisma.checkoutSession.findUnique({
			where: { cartId: cart.id }
		});

		if (!checkoutSession || checkoutSession.status !== 'ACTIVE') {
			throw new ValidationError('Checkout session is not active');
		}

		const paymentMethod = await prisma.paymentMethod.findFirst({
			where: {
				code: parsed.data.paymentMethodCode,
				isActive: true
			}
		});

		if (!paymentMethod) {
			throw new ValidationError('Invalid payment method');
		}

		const orderReference = `ORD-${Date.now()}-${randomUUID().slice(0, 6).toUpperCase()}`;

		const result = await prisma.$transaction(async (tx: any) => {
			const groupedByStore = new Map<string, any[]>();

			for (const item of cart.items) {
				const bucket = groupedByStore.get(item.product.storeId) || [];
				bucket.push(item);
				groupedByStore.set(item.product.storeId, bucket);
			}

			let subtotal = 0;
			for (const item of cart.items) {
				subtotal += decimalToNumber(item.unitPrice) * item.quantity;
			}

			const order = await tx.order.create({
				data: {
					reference: orderReference,
					userId: request.user!.id,
					checkoutSessionId: checkoutSession.id,
					channel: 'MARKETPLACE',
					status: 'PENDING',
					currency: cart.currency,
					subtotal,
					discount: 0,
					deliveryFee: 0,
					total: subtotal,
					notes: (checkoutSession.summaryData as any)?.notes || null
				}
			});

			const storeOrders = [];
			let index = 1;
			for (const [storeId, items] of groupedByStore.entries()) {
				const storeSubtotal = items.reduce(
					(sum, item) => sum + decimalToNumber(item.unitPrice) * item.quantity,
					0
				);

				const storeOrder = await tx.storeOrder.create({
					data: {
						orderId: order.id,
						storeId,
						reference: `${orderReference}-S${index}`,
						status: 'PENDING',
						currency: cart.currency,
						subtotal: storeSubtotal,
						discount: 0,
						deliveryFee: 0,
						total: storeSubtotal
					}
				});

				storeOrders.push(storeOrder);

				const deliveryMode = (checkoutSession.deliveryData as any)?.mode;
				if (deliveryMode) {
					await tx.delivery.create({
						data: {
							orderId: order.id,
							storeOrderId: storeOrder.id,
							mode: deliveryMode,
							recipientName: (checkoutSession.contactData as any)?.fullName,
							recipientPhone: (checkoutSession.contactData as any)?.phone,
							country: (checkoutSession.deliveryData as any)?.country,
							city: (checkoutSession.deliveryData as any)?.city,
							addressLine1: (checkoutSession.deliveryData as any)?.addressLine1,
							addressLine2: (checkoutSession.deliveryData as any)?.addressLine2,
							postalCode: (checkoutSession.deliveryData as any)?.postalCode,
							latitude: (checkoutSession.deliveryData as any)?.latitude,
							longitude: (checkoutSession.deliveryData as any)?.longitude,
							status: 'PENDING'
						}
					});
				}

				for (const item of items) {
					const lineSubtotal = decimalToNumber(item.unitPrice) * item.quantity;

					await tx.orderItem.create({
						data: {
							orderId: order.id,
							storeOrderId: storeOrder.id,
							productId: item.productId,
							variantId: item.variantId,
							productNameSnapshot: item.product.name,
							storeNameSnapshot: item.product.store.name,
							descriptionSnapshot: item.product.description,
							unitPrice: item.unitPrice,
							oldUnitPrice: item.oldUnitPrice,
							quantity: item.quantity,
							subtotal: lineSubtotal,
							metadata: {
								productSlug: item.product.slug,
								storeSlug: item.product.store.slug
							}
						}
					});

					const productUpdate = await tx.product.updateMany({
						where: {
							id: item.productId,
							stock: { gte: item.quantity }
						},
						data: {
							stock: { decrement: item.quantity }
						}
					});

					if (productUpdate.count === 0) {
						throw new ValidationError(`Insufficient stock for ${item.product.name}`);
					}

					if (item.variantId) {
						const variantUpdate = await tx.productVariant.updateMany({
							where: {
								id: item.variantId,
								stock: { gte: item.quantity }
							},
							data: {
								stock: { decrement: item.quantity }
							}
						});

						if (variantUpdate.count === 0) {
							throw new ValidationError(`Insufficient variant stock for ${item.product.name}`);
						}
					}

					await tx.inventoryMovement.create({
						data: {
							productId: item.productId,
							variantId: item.variantId,
							movementType: 'OUT',
							quantity: item.quantity,
							reason: 'Checkout confirmation',
							referenceType: 'ORDER',
							referenceId: order.id,
							createdByUserId: request.user!.id
						}
					});
				}

				index += 1;
			}

			await tx.orderStatusHistory.create({
				data: {
					orderId: order.id,
					fromStatus: null,
					toStatus: 'PENDING',
					changedByUserId: request.user!.id,
					note: 'Order created from checkout'
				}
			});

			await tx.checkoutSession.update({
				where: { id: checkoutSession.id },
				data: {
					status: 'COMPLETED',
					step: 'PAYMENT',
					confirmedAt: new Date()
				}
			});

			await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
			await tx.cart.update({
				where: { id: cart.id },
				data: {
					status: 'CHECKED_OUT'
				}
			});

			return {
				order,
				storeOrders
			};
		});

		response.status(201).json({
			orderReference: result.order.reference,
			orderId: result.order.id,
			paymentMethod: {
				code: paymentMethod.code,
				label: paymentMethod.label,
				provider: paymentMethod.provider
			},
			storeOrders: result.storeOrders.map((item: any) => ({
				id: item.id,
				reference: item.reference,
				total: decimalToNumber(item.total),
				currency: item.currency,
				status: item.status
			}))
		});
	})
);

import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../core/middleware/auth.middleware';
import { asyncHandler } from '../core/middleware/async.middleware';
import { prisma } from '../libs/prisma';
import { ValidationError } from '../core/errors/ValidationError';
import { NotFoundError } from '../core/errors/NotFoundError';
import { assertStoreManagementAccess } from '../core/utils/storeAccess';

export const productRoutes = Router();

const createProductSchema = z.object({
	storeId: z.string().min(1),
	categoryId: z.string().optional(),
	eventId: z.string().optional(),
	name: z.string().min(2),
	slug: z.string().min(2).optional(),
	description: z.string().max(4000).optional(),
	productType: z.enum(['PHYSICAL', 'DIGITAL', 'JERSEY', 'MERCH', 'EVENT_MERCH']),
	currency: z.string().min(3).max(3).optional(),
	price: z.number().positive(),
	oldPrice: z.number().positive().optional(),
	stock: z.number().int().min(0).optional(),
	isCustomizable: z.boolean().optional(),
	metadata: z.record(z.any()).optional()
});

const updateProductSchema = createProductSchema
	.omit({ storeId: true })
	.partial();

function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-');
}

productRoutes.get(
	'/products',
	asyncHandler(async (request, response) => {
		const page = Math.max(1, Number(request.query.page) || 1);
		const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));
		const search = typeof request.query.search === 'string' ? request.query.search.trim() : undefined;
		const storeSlug =
			typeof request.query.storeSlug === 'string' ? request.query.storeSlug.trim() : undefined;

		const where: Record<string, unknown> = {
			status: 'ACTIVE',
			publicationStatus: 'PUBLISHED'
		};

		if (search) {
			where.name = { contains: search, mode: 'insensitive' };
		}

		if (storeSlug) {
			where.store = {
				slug: storeSlug,
				status: 'ACTIVE',
				publicationStatus: 'PUBLISHED'
			};
		}

		const [items, total] = await Promise.all([
			prisma.product.findMany({
				where,
				orderBy: { createdAt: 'desc' },
				skip: (page - 1) * limit,
				take: limit,
				include: {
					store: {
						select: {
							id: true,
							name: true,
							slug: true
						}
					},
					media: {
						orderBy: { sortOrder: 'asc' },
						take: 1
					}
				}
			}),
			prisma.product.count({ where })
		]);

		response.status(200).json({
			data: items,
			meta: {
				page,
				limit,
				total,
				totalPages: Math.max(1, Math.ceil(total / limit))
			}
		});
	})
);

productRoutes.get(
	'/products/:slug',
	asyncHandler(async (request, response) => {
		const product = await prisma.product.findFirst({
			where: {
				slug: request.params.slug,
				status: 'ACTIVE',
				publicationStatus: 'PUBLISHED',
				store: {
					status: 'ACTIVE',
					publicationStatus: 'PUBLISHED'
				}
			},
			include: {
				store: {
					select: {
						id: true,
						name: true,
						slug: true
					}
				},
				category: true,
				media: {
					orderBy: { sortOrder: 'asc' }
				},
				variants: true
			}
		});

		if (!product) {
			throw new NotFoundError('Product not found');
		}

		response.status(200).json(product);
	})
);

productRoutes.use('/products', authMiddleware);

productRoutes.post(
	'/products',
	asyncHandler(async (request, response) => {
		const parsed = createProductSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid product payload', parsed.error.flatten());
		}

		const payload = parsed.data;
		await assertStoreManagementAccess(payload.storeId, request.user!.id);

		const slug = payload.slug || slugify(payload.name);

		const duplicate = await prisma.product.findUnique({
			where: {
				storeId_slug: {
					storeId: payload.storeId,
					slug
				}
			},
			select: { id: true }
		});

		if (duplicate) {
			throw new ValidationError('Product slug already exists for this store');
		}

		const product = await prisma.product.create({
			data: {
				storeId: payload.storeId,
				categoryId: payload.categoryId,
				eventId: payload.eventId,
				createdByUserId: request.user!.id,
				name: payload.name,
				slug,
				description: payload.description,
				productType: payload.productType,
				currency: payload.currency || 'XOF',
				price: payload.price,
				oldPrice: payload.oldPrice,
				stock: payload.stock ?? 0,
				isCustomizable: payload.isCustomizable ?? false,
				metadata: payload.metadata,
				status: payload.stock && payload.stock > 0 ? 'ACTIVE' : 'OUT_OF_STOCK',
				publicationStatus: 'DRAFT'
			}
		});

		response.status(201).json(product);
	})
);

productRoutes.patch(
	'/products/:id',
	asyncHandler(async (request, response) => {
		const parsed = updateProductSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid product update payload', parsed.error.flatten());
		}

		const existing = await prisma.product.findUnique({
			where: { id: request.params.id },
			select: { id: true, storeId: true }
		});

		if (!existing) {
			throw new NotFoundError('Product not found');
		}

		await assertStoreManagementAccess(existing.storeId, request.user!.id);

		const updates = parsed.data;
		const nextStock = updates.stock;

		const product = await prisma.product.update({
			where: { id: request.params.id },
			data: {
				categoryId: updates.categoryId,
				eventId: updates.eventId,
				name: updates.name,
				slug: updates.slug,
				description: updates.description,
				productType: updates.productType,
				currency: updates.currency,
				price: updates.price,
				oldPrice: updates.oldPrice,
				stock: updates.stock,
				isCustomizable: updates.isCustomizable,
				metadata: updates.metadata,
				status:
					typeof nextStock === 'number'
						? nextStock > 0
							? 'ACTIVE'
							: 'OUT_OF_STOCK'
						: undefined
			}
		});

		response.status(200).json(product);
	})
);

productRoutes.delete(
	'/products/:id',
	asyncHandler(async (request, response) => {
		const existing = await prisma.product.findUnique({
			where: { id: request.params.id },
			select: { id: true, storeId: true }
		});

		if (!existing) {
			throw new NotFoundError('Product not found');
		}

		await assertStoreManagementAccess(existing.storeId, request.user!.id);

		const product = await prisma.product.update({
			where: { id: request.params.id },
			data: {
				status: 'DISCONTINUED',
				publicationStatus: 'ARCHIVED'
			}
		});

		response.status(200).json(product);
	})
);

productRoutes.post(
	'/products/:id/publish',
	asyncHandler(async (request, response) => {
		const existing = await prisma.product.findUnique({
			where: { id: request.params.id },
			select: { id: true, storeId: true, stock: true }
		});

		if (!existing) {
			throw new NotFoundError('Product not found');
		}

		await assertStoreManagementAccess(existing.storeId, request.user!.id);

		const product = await prisma.product.update({
			where: { id: request.params.id },
			data: {
				publicationStatus: 'PUBLISHED',
				status: existing.stock > 0 ? 'ACTIVE' : 'OUT_OF_STOCK'
			}
		});

		response.status(200).json(product);
	})
);

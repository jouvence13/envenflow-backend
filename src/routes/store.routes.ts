import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../core/middleware/auth.middleware';
import { asyncHandler } from '../core/middleware/async.middleware';
import { prisma } from '../libs/prisma';
import { ValidationError } from '../core/errors/ValidationError';
import { NotFoundError } from '../core/errors/NotFoundError';
import {
	assertOrganizationManagementAccess,
	assertStoreManagementAccess
} from '../core/utils/storeAccess';

export const storeRoutes = Router();

const createStoreSchema = z.object({
	name: z.string().min(2),
	slug: z.string().min(2).optional(),
	phone: z.string().min(6).optional(),
	whatsappNumber: z.string().min(6).optional(),
	description: z.string().max(2000).optional(),
	organizationId: z.string().optional()
});

const updateStoreSchema = z.object({
	name: z.string().min(2).optional(),
	phone: z.string().min(6).optional(),
	whatsappNumber: z.string().min(6).optional(),
	description: z.string().max(2000).optional(),
	status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
	publicationStatus: z.enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED']).optional()
});

const addMemberSchema = z.object({
	userId: z.string().optional(),
	email: z.string().email().optional(),
	role: z.enum(['OWNER', 'ADMIN', 'MANAGER', 'STAFF', 'MODERATOR'])
});

function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-');
}

storeRoutes.get(
	'/stores/:slug',
	asyncHandler(async (request, response) => {
		const store = await prisma.store.findFirst({
			where: {
				slug: request.params.slug,
				status: 'ACTIVE',
				publicationStatus: 'PUBLISHED'
			},
			include: {
				organization: {
					select: {
						id: true,
						name: true,
						slug: true,
						type: true
					}
				},
				_count: {
					select: {
						products: true
					}
				}
			}
		});

		if (!store) {
			throw new NotFoundError('Store not found');
		}

		response.status(200).json({
			...store,
			productsCount: store._count.products
		});
	})
);

storeRoutes.use('/stores', authMiddleware);

storeRoutes.post(
	'/stores',
	asyncHandler(async (request, response) => {
		const parsed = createStoreSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid store payload', parsed.error.flatten());
		}

		const payload = parsed.data;
		const requestedSlug = payload.slug || slugify(payload.name);

		const existingStore = await prisma.store.findUnique({
			where: { slug: requestedSlug },
			select: { id: true }
		});

		if (existingStore) {
			throw new ValidationError('Store slug already exists');
		}

		let organizationId = payload.organizationId;

		if (organizationId) {
			await assertOrganizationManagementAccess(organizationId, request.user!.id);
		} else {
			const organizationSlug = `${requestedSlug}-org-${Date.now().toString(36).slice(-4)}`;
			const organization = await prisma.organization.create({
				data: {
					name: `${payload.name} Organization`,
					slug: organizationSlug,
					ownerUserId: request.user!.id,
					type: 'STORE',
					status: 'ACTIVE',
					publicationStatus: 'DRAFT'
				}
			});

			await prisma.organizationMember.create({
				data: {
					organizationId: organization.id,
					userId: request.user!.id,
					role: 'OWNER',
					status: 'ACTIVE'
				}
			});

			organizationId = organization.id;
		}

		const store = await prisma.store.create({
			data: {
				organizationId,
				ownerUserId: request.user!.id,
				name: payload.name,
				slug: requestedSlug,
				phone: payload.phone,
				whatsappNumber: payload.whatsappNumber,
				description: payload.description,
				status: 'ACTIVE',
				publicationStatus: 'DRAFT',
				members: {
					create: {
						userId: request.user!.id,
						role: 'OWNER',
						status: 'ACTIVE'
					}
				}
			},
			include: {
				organization: {
					select: { id: true, name: true, slug: true }
				}
			}
		});

		response.status(201).json(store);
	})
);

storeRoutes.patch(
	'/stores/:id',
	asyncHandler(async (request, response) => {
		const parsed = updateStoreSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid store update payload', parsed.error.flatten());
		}

		await assertStoreManagementAccess(request.params.id, request.user!.id);

		const store = await prisma.store.update({
			where: { id: request.params.id },
			data: {
				name: parsed.data.name,
				phone: parsed.data.phone,
				whatsappNumber: parsed.data.whatsappNumber,
				description: parsed.data.description,
				status: parsed.data.status,
				publicationStatus: parsed.data.publicationStatus
			}
		});

		response.status(200).json(store);
	})
);

storeRoutes.get(
	'/stores/:id/products',
	asyncHandler(async (request, response) => {
		await assertStoreManagementAccess(request.params.id, request.user!.id);

		const products = await prisma.product.findMany({
			where: { storeId: request.params.id },
			orderBy: { createdAt: 'desc' },
			include: {
				media: {
					orderBy: { sortOrder: 'asc' },
					take: 1
				}
			}
		});

		response.status(200).json({ data: products });
	})
);

storeRoutes.post(
	'/stores/:id/members',
	asyncHandler(async (request, response) => {
		const parsed = addMemberSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid store member payload', parsed.error.flatten());
		}

		await assertStoreManagementAccess(request.params.id, request.user!.id);

		const payload = parsed.data;

		if (!payload.userId && !payload.email) {
			throw new ValidationError('userId or email is required');
		}

		const user = await prisma.user.findFirst({
			where: payload.userId ? { id: payload.userId } : { email: payload.email },
			select: { id: true, email: true }
		});

		if (!user) {
			throw new NotFoundError('Target user not found');
		}

		const member = await prisma.storeMember.upsert({
			where: {
				storeId_userId: {
					storeId: request.params.id,
					userId: user.id
				}
			},
			update: {
				role: payload.role,
				status: 'ACTIVE'
			},
			create: {
				storeId: request.params.id,
				userId: user.id,
				role: payload.role,
				status: 'ACTIVE'
			},
			include: {
				user: {
					select: {
						id: true,
						email: true
					}
				}
			}
		});

		response.status(201).json(member);
	})
);

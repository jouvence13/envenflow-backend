import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../core/middleware/auth.middleware';
import { asyncHandler } from '../core/middleware/async.middleware';
import { prisma } from '../libs/prisma';
import { NotFoundError } from '../core/errors/NotFoundError';
import { ValidationError } from '../core/errors/ValidationError';

export const userRoutes = Router();

userRoutes.use('/users', authMiddleware);

const updateMeSchema = z.object({
	firstName: z.string().min(1).optional(),
	lastName: z.string().min(1).optional(),
	phone: z.string().min(6).optional(),
	language: z.string().min(2).optional(),
	theme: z.string().min(2).optional(),
	bio: z.string().max(1000).optional()
});

const addressSchema = z.object({
	label: z.string().optional(),
	country: z.string().min(1),
	city: z.string().min(1),
	line1: z.string().min(1),
	line2: z.string().optional(),
	postalCode: z.string().optional(),
	latitude: z.number().optional(),
	longitude: z.number().optional(),
	isDefault: z.boolean().optional()
});

const organizerRequestSchema = z.object({
	organizationName: z.string().min(2),
	organizationSlug: z.string().min(2).optional(),
	description: z.string().max(2000).optional()
});

const sellerRequestSchema = z.object({
	storeName: z.string().min(2),
	storeSlug: z.string().min(2).optional(),
	phone: z.string().min(6).optional(),
	whatsappNumber: z.string().min(6).optional(),
	description: z.string().max(2000).optional()
});

const professionalRequestSchema = z
	.object({
		organizer: organizerRequestSchema.optional(),
		seller: sellerRequestSchema.optional()
	})
	.refine((value) => Boolean(value.organizer || value.seller), {
		message: 'At least one professional request is required'
	});

function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-');
}

async function buildProfessionalContext(userId: string) {
	const [
		roleRecords,
		organizerApplications,
		storeApplications,
		ownedOrganizations,
		ownedStores
	] = await Promise.all([
		prisma.userRole.findMany({
			where: { userId },
			include: { role: true }
		}),
		prisma.organizerApplication.findMany({
			where: { applicantUserId: userId },
			orderBy: { createdAt: 'desc' },
			include: {
				approvedOrganization: {
					select: {
						id: true,
						name: true,
						slug: true
					}
				}
			}
		}),
		prisma.storeApplication.findMany({
			where: { applicantUserId: userId },
			orderBy: { createdAt: 'desc' },
			include: {
				approvedStore: {
					select: {
						id: true,
						name: true,
						slug: true
					}
				}
			}
		}),
		prisma.organization.findMany({
			where: { ownerUserId: userId },
			select: {
				id: true,
				name: true,
				slug: true,
				type: true,
				status: true,
				publicationStatus: true
			}
		}),
		prisma.store.findMany({
			where: { ownerUserId: userId },
			select: {
				id: true,
				name: true,
				slug: true,
				status: true,
				publicationStatus: true
			}
		})
	]);

	const roles = roleRecords.map((record: { role: { code: string } }) => record.role.code);
	const isAdmin = roles.includes('admin');
	const organizerEnabled = isAdmin || roles.includes('organizer');
	const sellerEnabled = isAdmin || roles.includes('seller');

	const organizerOrganizationIds = ownedOrganizations
		.filter((organization: { type: string }) => organization.type === 'ORGANIZER')
		.map((organization: { id: string }) => organization.id);

	const sellerStoreIds = ownedStores.map((store: { id: string }) => store.id);

	const [eventsCount, livesCount, contestsCount, ticketsCount] = organizerOrganizationIds.length
		? await Promise.all([
				prisma.event.count({ where: { organizationId: { in: organizerOrganizationIds } } }),
				prisma.liveEvent.count({ where: { organizationId: { in: organizerOrganizationIds } } }),
				prisma.contest.count({ where: { organizationId: { in: organizerOrganizationIds } } }),
				prisma.ticket.count({ where: { event: { organizationId: { in: organizerOrganizationIds } } } })
		  ])
		: [0, 0, 0, 0];

	const [productsCount, storeOrdersCount, paymentsCount] = sellerStoreIds.length
		? await Promise.all([
				prisma.product.count({ where: { storeId: { in: sellerStoreIds } } }),
				prisma.storeOrder.count({ where: { storeId: { in: sellerStoreIds } } }),
				prisma.payment.count({ where: { storeOrder: { storeId: { in: sellerStoreIds } } } })
		  ])
		: [0, 0, 0];

	return {
		roles,
		spaces: {
			user: { enabled: true },
			organizer: {
				enabled: organizerEnabled,
				canRequest: !organizerEnabled
			},
			seller: {
				enabled: sellerEnabled,
				canRequest: !sellerEnabled
			},
			admin: { enabled: isAdmin }
		},
		applications: {
			organizer: organizerApplications,
			seller: storeApplications
		},
		resources: {
			organizerOrganizations: ownedOrganizations.filter(
				(organization: { type: string }) => organization.type === 'ORGANIZER'
			),
			sellerStores: ownedStores,
			organizerStats: {
				eventsCount,
				ticketsCount,
				livesCount,
				contestsCount
			},
			sellerStats: {
				productsCount,
				ordersCount: storeOrdersCount,
				paymentsCount
			}
		}
	};
}

userRoutes.get(
	'/users/me',
	asyncHandler(async (request, response) => {
		const user = await prisma.user.findUnique({
			where: { id: request.user!.id },
			include: {
				profile: true,
				roles: { include: { role: true } }
			}
		});

		if (!user) {
			throw new NotFoundError('User not found');
		}

		const roleCodes = user.roles.map((entry: { role: { code: string } }) => entry.role.code);
		const isAdmin = roleCodes.includes('admin');

		response.status(200).json({
			id: user.id,
			email: user.email,
			phone: user.phone,
			status: user.status,
			profile: user.profile,
			roles: roleCodes,
			spaces: {
				user: true,
				organizer: isAdmin || roleCodes.includes('organizer'),
				seller: isAdmin || roleCodes.includes('seller'),
				admin: isAdmin
			}
		});
	})
);

userRoutes.get(
	'/users/me/professional-context',
	asyncHandler(async (request, response) => {
		const context = await buildProfessionalContext(request.user!.id);
		response.status(200).json(context);
	})
);

userRoutes.post(
	'/users/me/professional-requests',
	asyncHandler(async (request, response) => {
		const parsed = professionalRequestSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid professional request payload', parsed.error.flatten());
		}

		const payload = parsed.data;
		const roleRecords = await prisma.userRole.findMany({
			where: { userId: request.user!.id },
			include: { role: true }
		});
		const roleCodes = roleRecords.map((record: { role: { code: string } }) => record.role.code);

		const results: Array<Record<string, unknown>> = [];

		if (payload.organizer) {
			if (roleCodes.includes('organizer') || roleCodes.includes('admin')) {
				results.push({
					type: 'organizer',
					status: 'ALREADY_ENABLED'
				});
			} else {
				const slug = payload.organizer.organizationSlug || slugify(payload.organizer.organizationName);
				const existingPending = await prisma.organizerApplication.findFirst({
					where: {
						applicantUserId: request.user!.id,
						status: 'PENDING'
					}
				});

				const organizerApp = existingPending
					? await prisma.organizerApplication.update({
							where: { id: existingPending.id },
							data: {
								organizationName: payload.organizer.organizationName,
								organizationSlug: slug,
								description: payload.organizer.description,
								reviewNotes: null,
								reviewedAt: null,
								reviewedByUserId: null
							}
					  })
					: await prisma.organizerApplication.create({
							data: {
								applicantUserId: request.user!.id,
								organizationName: payload.organizer.organizationName,
								organizationSlug: slug,
								description: payload.organizer.description,
								status: 'PENDING'
							}
					  });

				results.push({
					type: 'organizer',
					status: organizerApp.status,
					applicationId: organizerApp.id,
					action: existingPending ? 'UPDATED' : 'CREATED'
				});
			}
		}

		if (payload.seller) {
			if (roleCodes.includes('seller') || roleCodes.includes('admin')) {
				results.push({
					type: 'seller',
					status: 'ALREADY_ENABLED'
				});
			} else {
				const slug = payload.seller.storeSlug || slugify(payload.seller.storeName);
				const existingPending = await prisma.storeApplication.findFirst({
					where: {
						applicantUserId: request.user!.id,
						status: 'PENDING'
					}
				});

				const storeApp = existingPending
					? await prisma.storeApplication.update({
							where: { id: existingPending.id },
							data: {
								storeName: payload.seller.storeName,
								storeSlug: slug,
								phone: payload.seller.phone,
								whatsappNumber: payload.seller.whatsappNumber,
								description: payload.seller.description,
								reviewNotes: null,
								reviewedAt: null,
								reviewedByUserId: null
							}
					  })
					: await prisma.storeApplication.create({
							data: {
								applicantUserId: request.user!.id,
								storeName: payload.seller.storeName,
								storeSlug: slug,
								phone: payload.seller.phone,
								whatsappNumber: payload.seller.whatsappNumber,
								description: payload.seller.description,
								status: 'PENDING'
							}
					  });

				results.push({
					type: 'seller',
					status: storeApp.status,
					applicationId: storeApp.id,
					action: existingPending ? 'UPDATED' : 'CREATED'
				});
			}
		}

		const context = await buildProfessionalContext(request.user!.id);

		response.status(201).json({
			message: 'Professional requests submitted',
			results,
			context
		});
	})
);

userRoutes.patch(
	'/users/me',
	asyncHandler(async (request, response) => {
		const parsed = updateMeSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid profile payload', parsed.error.flatten());
		}

		const payload = parsed.data;

		if (payload.phone) {
			const phoneOwner = await prisma.user.findFirst({
				where: { phone: payload.phone, id: { not: request.user!.id } },
				select: { id: true }
			});

			if (phoneOwner) {
				throw new ValidationError('Phone already in use');
			}
		}

		const user = await prisma.user.update({
			where: { id: request.user!.id },
			data: {
				phone: payload.phone,
				profile: {
					upsert: {
						create: {
							firstName: payload.firstName || 'User',
							lastName: payload.lastName || 'Profile',
							language: payload.language || 'fr',
							theme: payload.theme || 'dark',
							bio: payload.bio
						},
						update: {
							firstName: payload.firstName,
							lastName: payload.lastName,
							language: payload.language,
							theme: payload.theme,
							bio: payload.bio
						}
					}
				}
			},
			include: { profile: true }
		});

		response.status(200).json({
			id: user.id,
			email: user.email,
			phone: user.phone,
			profile: user.profile
		});
	})
);

userRoutes.get(
	'/users/me/addresses',
	asyncHandler(async (request, response) => {
		const addresses = await prisma.userAddress.findMany({
			where: { userId: request.user!.id },
			orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }]
		});

		response.status(200).json({ data: addresses });
	})
);

userRoutes.post(
	'/users/me/addresses',
	asyncHandler(async (request, response) => {
		const parsed = addressSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid address payload', parsed.error.flatten());
		}

		const payload = parsed.data;

		if (payload.isDefault) {
			await prisma.userAddress.updateMany({
				where: { userId: request.user!.id, isDefault: true },
				data: { isDefault: false }
			});
		}

		const address = await prisma.userAddress.create({
			data: {
				userId: request.user!.id,
				label: payload.label,
				country: payload.country,
				city: payload.city,
				line1: payload.line1,
				line2: payload.line2,
				postalCode: payload.postalCode,
				latitude: payload.latitude,
				longitude: payload.longitude,
				isDefault: payload.isDefault || false
			}
		});

		response.status(201).json(address);
	})
);

userRoutes.patch(
	'/users/me/addresses/:id',
	asyncHandler(async (request, response) => {
		const parsed = addressSchema.partial().safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid address payload', parsed.error.flatten());
		}

		const existing = await prisma.userAddress.findFirst({
			where: { id: request.params.id, userId: request.user!.id }
		});

		if (!existing) {
			throw new NotFoundError('Address not found');
		}

		if (parsed.data.isDefault) {
			await prisma.userAddress.updateMany({
				where: { userId: request.user!.id, isDefault: true },
				data: { isDefault: false }
			});
		}

		const updated = await prisma.userAddress.update({
			where: { id: request.params.id },
			data: {
				label: parsed.data.label,
				country: parsed.data.country,
				city: parsed.data.city,
				line1: parsed.data.line1,
				line2: parsed.data.line2,
				postalCode: parsed.data.postalCode,
				latitude: parsed.data.latitude,
				longitude: parsed.data.longitude,
				isDefault: parsed.data.isDefault
			}
		});

		response.status(200).json(updated);
	})
);

userRoutes.delete(
	'/users/me/addresses/:id',
	asyncHandler(async (request, response) => {
		const existing = await prisma.userAddress.findFirst({
			where: { id: request.params.id, userId: request.user!.id }
		});

		if (!existing) {
			throw new NotFoundError('Address not found');
		}

		await prisma.userAddress.delete({
			where: { id: request.params.id }
		});

		response.status(204).send();
	})
);

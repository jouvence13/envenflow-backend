import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../core/middleware/auth.middleware';
import { roleMiddleware } from '../core/middleware/role.middleware';
import { asyncHandler } from '../core/middleware/async.middleware';
import { prisma } from '../libs/prisma';
import { ValidationError } from '../core/errors/ValidationError';
import { NotFoundError } from '../core/errors/NotFoundError';

export const adminRoutes = Router();

adminRoutes.use(authMiddleware, roleMiddleware(['admin']));

const reviewApplicationSchema = z.object({
	status: z.enum(['APPROVED', 'REJECTED']),
	reviewNotes: z.string().max(2000).optional()
});

function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-') || `item-${Date.now().toString(36)}`;
}

async function ensureUniqueSlug(kind: 'organization' | 'store', baseSlug: string) {
	const safeBase = slugify(baseSlug);
	let candidate = safeBase;
	let suffix = 1;

	while (true) {
		const exists =
			kind === 'organization'
				? await prisma.organization.findUnique({ where: { slug: candidate }, select: { id: true } })
				: await prisma.store.findUnique({ where: { slug: candidate }, select: { id: true } });

		if (!exists) {
			return candidate;
		}

		suffix += 1;
		candidate = `${safeBase}-${suffix}`;
	}
}

async function ensureRole(code: string, name: string) {
	return prisma.role.upsert({
		where: { code },
		update: { name },
		create: { code, name }
	});
}

async function assignRole(userId: string, roleId: string) {
	await prisma.userRole.upsert({
		where: {
			userId_roleId: {
				userId,
				roleId
			}
		},
		update: {},
		create: {
			userId,
			roleId
		}
	});
}

adminRoutes.get(
	'/admin/dashboard',
	asyncHandler(async (_request, response) => {
		const [
			pendingStoreApplications,
			pendingOrganizerApplications,
			usersCount,
			storesCount,
			eventsCount,
			ordersCount
		] = await Promise.all([
			prisma.storeApplication.count({ where: { status: 'PENDING' } }),
			prisma.organizerApplication.count({ where: { status: 'PENDING' } }),
			prisma.user.count(),
			prisma.store.count(),
			prisma.event.count(),
			prisma.order.count()
		]);

		response.status(200).json({
			pendingStoreApplications,
			pendingOrganizerApplications,
			usersCount,
			storesCount,
			eventsCount,
			ordersCount
		});
	})
);

adminRoutes.get(
	'/admin/store-applications',
	asyncHandler(async (request, response) => {
		const statusInput =
			typeof request.query.status === 'string' ? request.query.status.toUpperCase() : undefined;
		const statusFilter = ['PENDING', 'APPROVED', 'REJECTED'].includes(statusInput || '')
			? (statusInput as 'PENDING' | 'APPROVED' | 'REJECTED')
			: undefined;

		const applications = await prisma.storeApplication.findMany({
			where: statusFilter ? { status: statusFilter } : {},
			orderBy: { createdAt: 'desc' },
			include: {
				applicant: {
					select: {
						id: true,
						email: true,
						profile: {
							select: {
								firstName: true,
								lastName: true
							}
						}
					}
				},
				reviewedBy: {
					select: {
						id: true,
						email: true
					}
				},
				approvedStore: {
					select: {
						id: true,
						name: true,
						slug: true
					}
				}
			}
		});

		response.status(200).json({ data: applications });
	})
);

adminRoutes.patch(
	'/admin/store-applications/:id/review',
	asyncHandler(async (request, response) => {
		const parsed = reviewApplicationSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid store application review payload', parsed.error.flatten());
		}

		const application = await prisma.storeApplication.findUnique({
			where: { id: request.params.id },
			include: {
				approvedStore: {
					select: { id: true }
				}
			}
		});

		if (!application) {
			throw new NotFoundError('Store application not found');
		}

		let approvedStoreId = application.approvedStoreId;

		if (parsed.data.status === 'APPROVED' && !approvedStoreId) {
			const sellerRole = await ensureRole('seller', 'Seller');
			await assignRole(application.applicantUserId, sellerRole.id);

			const desiredStoreSlug = application.storeSlug || slugify(application.storeName);
			const storeSlug = await ensureUniqueSlug('store', desiredStoreSlug);
			const organizationSlug = await ensureUniqueSlug('organization', `${storeSlug}-org`);

			const organization = await prisma.organization.create({
				data: {
					name: `${application.storeName} Organization`,
					slug: organizationSlug,
					ownerUserId: application.applicantUserId,
					type: 'STORE',
					status: 'ACTIVE',
					publicationStatus: 'DRAFT'
				}
			});

			await prisma.organizationMember.upsert({
				where: {
					organizationId_userId: {
						organizationId: organization.id,
						userId: application.applicantUserId
					}
				},
				update: {
					role: 'OWNER',
					status: 'ACTIVE'
				},
				create: {
					organizationId: organization.id,
					userId: application.applicantUserId,
					role: 'OWNER',
					status: 'ACTIVE'
				}
			});

			const store = await prisma.store.create({
				data: {
					organizationId: organization.id,
					ownerUserId: application.applicantUserId,
					name: application.storeName,
					slug: storeSlug,
					phone: application.phone,
					whatsappNumber: application.whatsappNumber,
					description: application.description,
					status: 'ACTIVE',
					publicationStatus: 'DRAFT',
					members: {
						create: {
							userId: application.applicantUserId,
							role: 'OWNER',
							status: 'ACTIVE'
						}
					}
				}
			});

			approvedStoreId = store.id;
		}

		const updated = await prisma.storeApplication.update({
			where: { id: application.id },
			data: {
				status: parsed.data.status,
				reviewNotes: parsed.data.reviewNotes,
				reviewedAt: new Date(),
				reviewedByUserId: request.user!.id,
				approvedStoreId
			},
			include: {
				approvedStore: {
					select: {
						id: true,
						name: true,
						slug: true
					}
				}
			}
		});

		response.status(200).json(updated);
	})
);

adminRoutes.get(
	'/admin/organizer-applications',
	asyncHandler(async (request, response) => {
		const statusInput =
			typeof request.query.status === 'string' ? request.query.status.toUpperCase() : undefined;
		const statusFilter = ['PENDING', 'APPROVED', 'REJECTED'].includes(statusInput || '')
			? (statusInput as 'PENDING' | 'APPROVED' | 'REJECTED')
			: undefined;

		const applications = await prisma.organizerApplication.findMany({
			where: statusFilter ? { status: statusFilter } : {},
			orderBy: { createdAt: 'desc' },
			include: {
				applicant: {
					select: {
						id: true,
						email: true,
						profile: {
							select: {
								firstName: true,
								lastName: true
							}
						}
					}
				},
				reviewedBy: {
					select: {
						id: true,
						email: true
					}
				},
				approvedOrganization: {
					select: {
						id: true,
						name: true,
						slug: true
					}
				}
			}
		});

		response.status(200).json({ data: applications });
	})
);

adminRoutes.patch(
	'/admin/organizer-applications/:id/review',
	asyncHandler(async (request, response) => {
		const parsed = reviewApplicationSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid organizer application review payload', parsed.error.flatten());
		}

		const application = await prisma.organizerApplication.findUnique({
			where: { id: request.params.id },
			include: {
				approvedOrganization: {
					select: { id: true }
				}
			}
		});

		if (!application) {
			throw new NotFoundError('Organizer application not found');
		}

		let approvedOrganizationId = application.approvedOrganizationId;

		if (parsed.data.status === 'APPROVED' && !approvedOrganizationId) {
			const organizerRole = await ensureRole('organizer', 'Organizer');
			await assignRole(application.applicantUserId, organizerRole.id);

			const desiredOrganizationSlug =
				application.organizationSlug || slugify(application.organizationName);
			const organizationSlug = await ensureUniqueSlug('organization', desiredOrganizationSlug);

			const organization = await prisma.organization.create({
				data: {
					name: application.organizationName,
					slug: organizationSlug,
					ownerUserId: application.applicantUserId,
					type: 'ORGANIZER',
					status: 'ACTIVE',
					publicationStatus: 'DRAFT',
					description: application.description
				}
			});

			await prisma.organizationMember.upsert({
				where: {
					organizationId_userId: {
						organizationId: organization.id,
						userId: application.applicantUserId
					}
				},
				update: {
					role: 'OWNER',
					status: 'ACTIVE'
				},
				create: {
					organizationId: organization.id,
					userId: application.applicantUserId,
					role: 'OWNER',
					status: 'ACTIVE'
				}
			});

			approvedOrganizationId = organization.id;
		}

		const updated = await prisma.organizerApplication.update({
			where: { id: application.id },
			data: {
				status: parsed.data.status,
				reviewNotes: parsed.data.reviewNotes,
				reviewedAt: new Date(),
				reviewedByUserId: request.user!.id,
				approvedOrganizationId
			},
			include: {
				approvedOrganization: {
					select: {
						id: true,
						name: true,
						slug: true
					}
				}
			}
		});

		response.status(200).json(updated);
	})
);

adminRoutes.patch('/admin/products/:id/moderate', (_request, response) => response.status(501).json({ message: 'Not implemented' }));
adminRoutes.patch('/admin/events/:id/moderate', (_request, response) => response.status(501).json({ message: 'Not implemented' }));

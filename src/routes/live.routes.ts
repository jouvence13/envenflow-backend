import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { authMiddleware } from '../core/middleware/auth.middleware';
import { roleMiddleware } from '../core/middleware/role.middleware';
import { asyncHandler } from '../core/middleware/async.middleware';
import { prisma } from '../libs/prisma';
import { ValidationError } from '../core/errors/ValidationError';
import { NotFoundError } from '../core/errors/NotFoundError';
import { assertOrganizationManagementAccess } from '../core/utils/storeAccess';

export const liveRoutes = Router();

const createLiveSchema = z.object({
	organizationId: z.string().min(1),
	slug: z.string().min(2).optional(),
	title: z.string().min(2),
	description: z.string().max(5000).optional(),
	bannerImageUrl: z.string().url().optional(),
	streamUrl: z.string().url().optional(),
	startAt: z.coerce.date(),
	endAt: z.coerce.date(),
	isPaid: z.boolean().optional(),
	chatEnabled: z.boolean().optional(),
	viewerLimit: z.number().int().positive().optional()
});

const updateLiveSchema = createLiveSchema
	.omit({ organizationId: true })
	.extend({
		status: z.enum(['UPCOMING', 'LIVE', 'ENDED', 'CANCELLED']).optional(),
		publicationStatus: z
			.enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED'])
			.optional()
	})
	.partial();

const joinLiveSchema = z.object({
	liveTicketTypeId: z.string().optional()
});

const liveChatSchema = z.object({
	message: z.string().min(1).max(1000)
});

function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-');
}

liveRoutes.get(
	'/lives',
	asyncHandler(async (request, response) => {
		const page = Math.max(1, Number(request.query.page) || 1);
		const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));

		const livesWhere = {
			publicationStatus: 'PUBLISHED' as const,
			status: {
				in: ['UPCOMING', 'LIVE', 'ENDED'] as const
			}
		};

		const [lives, total] = await Promise.all([
			prisma.liveEvent.findMany({
				where: livesWhere,
				orderBy: { startAt: 'asc' },
				skip: (page - 1) * limit,
				take: limit,
				include: {
					organization: {
						select: {
							id: true,
							name: true,
							slug: true
						}
					}
				}
			}),
			prisma.liveEvent.count({ where: livesWhere })
		]);

		response.status(200).json({
			data: lives,
			meta: {
				page,
				limit,
				total,
				totalPages: Math.max(1, Math.ceil(total / limit))
			}
		});
	})
);

liveRoutes.get(
	'/lives/:slug',
	asyncHandler(async (request, response) => {
		const live = await prisma.liveEvent.findFirst({
			where: {
				slug: request.params.slug,
				publicationStatus: 'PUBLISHED',
				status: {
					in: ['UPCOMING', 'LIVE', 'ENDED']
				}
			},
			include: {
				organization: {
					select: {
						id: true,
						name: true,
						slug: true
					}
				},
				ticketTypes: {
					where: {
						publicationStatus: 'PUBLISHED'
					}
				}
			}
		});

		if (!live) {
			throw new NotFoundError('Live event not found');
		}

		response.status(200).json(live);
	})
);

liveRoutes.use('/lives', authMiddleware);

liveRoutes.post(
	'/lives',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const parsed = createLiveSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid live payload', parsed.error.flatten());
		}

		const payload = parsed.data;

		if (payload.endAt <= payload.startAt) {
			throw new ValidationError('Live endAt must be after startAt');
		}

		const organization = await assertOrganizationManagementAccess(payload.organizationId, request.user!.id);
		const isAdmin = request.user!.roles.includes('admin');

		if (!isAdmin && organization.type !== 'ORGANIZER') {
			throw new ValidationError('Lives can only be created under organizer organizations');
		}

		const slug = payload.slug || slugify(payload.title);
		const duplicate = await prisma.liveEvent.findUnique({ where: { slug }, select: { id: true } });

		if (duplicate) {
			throw new ValidationError('Live slug already exists');
		}

		const live = await prisma.liveEvent.create({
			data: {
				organizationId: payload.organizationId,
				createdByUserId: request.user!.id,
				slug,
				title: payload.title,
				description: payload.description,
				bannerImageUrl: payload.bannerImageUrl,
				streamUrl: payload.streamUrl,
				startAt: payload.startAt,
				endAt: payload.endAt,
				status: 'UPCOMING',
				publicationStatus: 'DRAFT',
				isPaid: payload.isPaid ?? true,
				chatEnabled: payload.chatEnabled ?? true,
				viewerLimit: payload.viewerLimit
			}
		});

		response.status(201).json(live);
	})
);

liveRoutes.patch(
	'/lives/:id',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const parsed = updateLiveSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid live update payload', parsed.error.flatten());
		}

		const existing = await prisma.liveEvent.findUnique({
			where: { id: request.params.id },
			select: {
				id: true,
				organizationId: true,
				startAt: true,
				endAt: true
			}
		});

		if (!existing) {
			throw new NotFoundError('Live event not found');
		}

		const organization = await assertOrganizationManagementAccess(existing.organizationId, request.user!.id);
		const isAdmin = request.user!.roles.includes('admin');

		if (!isAdmin && organization.type !== 'ORGANIZER') {
			throw new ValidationError('Only organizer organizations can manage lives');
		}

		const nextStartAt = parsed.data.startAt || existing.startAt;
		const nextEndAt = parsed.data.endAt || existing.endAt;

		if (nextEndAt <= nextStartAt) {
			throw new ValidationError('Live endAt must be after startAt');
		}

		let nextSlug = parsed.data.slug;
		if (!nextSlug && parsed.data.title) {
			nextSlug = slugify(parsed.data.title);
		}

		if (nextSlug) {
			const duplicate = await prisma.liveEvent.findFirst({
				where: {
					slug: nextSlug,
					id: { not: existing.id }
				},
				select: { id: true }
			});

			if (duplicate) {
				throw new ValidationError('Live slug already exists');
			}
		}

		const live = await prisma.liveEvent.update({
			where: { id: existing.id },
			data: {
				slug: nextSlug,
				title: parsed.data.title,
				description: parsed.data.description,
				bannerImageUrl: parsed.data.bannerImageUrl,
				streamUrl: parsed.data.streamUrl,
				startAt: parsed.data.startAt,
				endAt: parsed.data.endAt,
				status: parsed.data.status,
				publicationStatus: parsed.data.publicationStatus,
				isPaid: parsed.data.isPaid,
				chatEnabled: parsed.data.chatEnabled,
				viewerLimit: parsed.data.viewerLimit
			}
		});

		response.status(200).json(live);
	})
);

liveRoutes.post(
	'/lives/:id/join',
	asyncHandler(async (request, response) => {
		const parsed = joinLiveSchema.safeParse(request.body || {});

		if (!parsed.success) {
			throw new ValidationError('Invalid live join payload', parsed.error.flatten());
		}

		const live = await prisma.liveEvent.findUnique({
			where: { id: request.params.id },
			select: {
				id: true,
				title: true,
				streamUrl: true,
				status: true,
				publicationStatus: true,
				isPaid: true
			}
		});

		if (!live) {
			throw new NotFoundError('Live event not found');
		}

		if (live.publicationStatus !== 'PUBLISHED' || !['UPCOMING', 'LIVE'].includes(live.status)) {
			throw new ValidationError('Live event is not accessible at the moment');
		}

		let access = await prisma.liveAccess.findFirst({
			where: {
				liveEventId: live.id,
				userId: request.user!.id,
				status: 'GRANTED'
			}
		});

		if (live.isPaid) {
			if (!access) {
				throw new ValidationError('Paid access is required for this live event');
			}
		} else if (!access) {
			access = await prisma.liveAccess.create({
				data: {
					liveEventId: live.id,
					userId: request.user!.id,
					status: 'GRANTED'
				}
			});
		}

		const viewerSession = await prisma.liveViewerSession.create({
			data: {
				liveEventId: live.id,
				userId: request.user!.id,
				sessionToken: randomUUID(),
				ipAddress: request.ip,
				userAgent: request.headers['user-agent']
			}
		});

		response.status(200).json({
			liveId: live.id,
			liveTitle: live.title,
			sessionToken: viewerSession.sessionToken,
			accessId: access?.id || null,
			streamUrl: live.streamUrl
		});
	})
);

liveRoutes.post(
	'/lives/:id/chat',
	asyncHandler(async (request, response) => {
		const parsed = liveChatSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid live chat payload', parsed.error.flatten());
		}

		const live = await prisma.liveEvent.findUnique({
			where: { id: request.params.id },
			select: {
				id: true,
				isPaid: true,
				chatEnabled: true,
				publicationStatus: true,
				status: true
			}
		});

		if (!live) {
			throw new NotFoundError('Live event not found');
		}

		if (live.publicationStatus !== 'PUBLISHED' || !['UPCOMING', 'LIVE'].includes(live.status)) {
			throw new ValidationError('Live chat is currently unavailable');
		}

		if (!live.chatEnabled) {
			throw new ValidationError('Live chat is disabled');
		}

		if (live.isPaid) {
			const access = await prisma.liveAccess.findFirst({
				where: {
					liveEventId: live.id,
					userId: request.user!.id,
					status: 'GRANTED'
				},
				select: { id: true }
			});

			if (!access) {
				throw new ValidationError('Paid access is required to use chat');
			}
		}

		const message = await prisma.liveChatMessage.create({
			data: {
				liveEventId: live.id,
				userId: request.user!.id,
				message: parsed.data.message
			},
			include: {
				author: {
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
				}
			}
		});

		response.status(201).json(message);
	})
);

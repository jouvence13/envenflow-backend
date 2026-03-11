import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authMiddleware } from '../core/middleware/auth.middleware';
import { roleMiddleware } from '../core/middleware/role.middleware';
import { asyncHandler } from '../core/middleware/async.middleware';
import { prisma } from '../libs/prisma';
import { ValidationError } from '../core/errors/ValidationError';
import { NotFoundError } from '../core/errors/NotFoundError';
import { assertOrganizationManagementAccess } from '../core/utils/storeAccess';

export const eventRoutes = Router();

const createEventSchema = z.object({
	organizationId: z.string().min(1),
	slug: z.string().min(2).optional(),
	title: z.string().min(2),
	shortDescription: z.string().max(500).optional(),
	description: z.string().max(5000).optional(),
	location: z.string().min(2),
	timezone: z.string().min(2).optional(),
	startAt: z.coerce.date(),
	endAt: z.coerce.date(),
	bannerImageUrl: z.string().url().optional(),
	isFeatured: z.boolean().optional(),
	capacity: z.number().int().positive().optional()
});

const updateEventSchema = createEventSchema
	.omit({ organizationId: true })
	.extend({
		status: z.enum(['DRAFT', 'SCHEDULED', 'ONGOING', 'COMPLETED', 'CANCELLED']).optional(),
		publicationStatus: z
			.enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED'])
			.optional()
	})
	.partial();

const createTicketTypeSchema = z.object({
	name: z.string().min(2),
	description: z.string().max(1500).optional(),
	price: z.number().nonnegative(),
	currency: z.string().min(3).max(3).optional(),
	stock: z.number().int().positive(),
	maxPerUser: z.number().int().positive().optional(),
	salesStart: z.coerce.date().optional(),
	salesEnd: z.coerce.date().optional(),
	publicationStatus: z
		.enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED'])
		.optional()
});

const scanTicketSchema = z.object({
	gate: z.string().max(120).optional(),
	deviceInfo: z.string().max(200).optional()
});

const ORGANIZATION_MANAGER_ROLES = ['OWNER', 'ADMIN', 'MANAGER'] as const;

function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-');
}

eventRoutes.get(
	'/events',
	asyncHandler(async (request, response) => {
		const page = Math.max(1, Number(request.query.page) || 1);
		const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));
		const search = typeof request.query.search === 'string' ? request.query.search.trim() : undefined;
		const organizationSlug =
			typeof request.query.organizationSlug === 'string'
				? request.query.organizationSlug.trim()
				: undefined;

		const where: Record<string, unknown> = {
			publicationStatus: 'PUBLISHED',
			status: {
				in: ['SCHEDULED', 'ONGOING', 'COMPLETED']
			}
		};

		if (search) {
			where.OR = [
				{ title: { contains: search, mode: 'insensitive' } },
				{ location: { contains: search, mode: 'insensitive' } }
			];
		}

		if (organizationSlug) {
			where.organization = {
				slug: organizationSlug,
				status: 'ACTIVE',
				publicationStatus: 'PUBLISHED'
			};
		}

		const [events, total] = await Promise.all([
			prisma.event.findMany({
				where,
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
					},
					ticketTypes: {
						where: {
							publicationStatus: 'PUBLISHED'
						},
						select: {
							id: true,
							name: true,
							price: true,
							currency: true
						},
						orderBy: { price: 'asc' },
						take: 3
					}
				}
			}),
			prisma.event.count({ where })
		]);

		response.status(200).json({
			data: events,
			meta: {
				page,
				limit,
				total,
				totalPages: Math.max(1, Math.ceil(total / limit))
			}
		});
	})
);

eventRoutes.get(
	'/events/:slug',
	asyncHandler(async (request, response) => {
		const event = await prisma.event.findFirst({
			where: {
				slug: request.params.slug,
				publicationStatus: 'PUBLISHED',
				status: {
					in: ['SCHEDULED', 'ONGOING', 'COMPLETED']
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
					},
					orderBy: { price: 'asc' }
				}
			}
		});

		if (!event) {
			throw new NotFoundError('Event not found');
		}

		response.status(200).json(event);
	})
);

eventRoutes.use('/events', authMiddleware);
eventRoutes.use('/tickets', authMiddleware);

eventRoutes.get(
	'/events/me/managed',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const page = Math.max(1, Number(request.query.page) || 1);
		const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 20));
		const search = typeof request.query.search === 'string' ? request.query.search.trim() : undefined;
		const isAdmin = request.user!.roles.includes('admin');

		const where: Prisma.EventWhereInput = {
			organization: isAdmin
				? {
						type: 'ORGANIZER'
				  }
				: {
						OR: [
							{ ownerUserId: request.user!.id },
							{
								members: {
									some: {
										userId: request.user!.id,
										status: 'ACTIVE',
										role: {
											in: [...ORGANIZATION_MANAGER_ROLES]
										}
									}
								}
							}
						],
						type: 'ORGANIZER'
				  }
		};

		if (search) {
			where.OR = [
				{ title: { contains: search, mode: 'insensitive' } },
				{ location: { contains: search, mode: 'insensitive' } }
			];
		}

		const [events, total] = await Promise.all([
			prisma.event.findMany({
				where,
				orderBy: [{ startAt: 'desc' }, { createdAt: 'desc' }],
				skip: (page - 1) * limit,
				take: limit,
				include: {
					organization: {
						select: {
							id: true,
							name: true,
							slug: true
						}
					},
					ticketTypes: {
						select: {
							id: true,
							name: true,
							price: true,
							currency: true,
							publicationStatus: true
						},
						orderBy: { createdAt: 'desc' }
					}
				}
			}),
			prisma.event.count({ where })
		]);

		response.status(200).json({
			data: events,
			meta: {
				page,
				limit,
				total,
				totalPages: Math.max(1, Math.ceil(total / limit))
			}
		});
	})
);

eventRoutes.post(
	'/events',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const parsed = createEventSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid event payload', parsed.error.flatten());
		}

		const payload = parsed.data;

		if (payload.endAt <= payload.startAt) {
			throw new ValidationError('Event endAt must be after startAt');
		}

		const organization = await assertOrganizationManagementAccess(payload.organizationId, request.user!.id);
		const isAdmin = request.user!.roles.includes('admin');

		if (!isAdmin && organization.type !== 'ORGANIZER') {
			throw new ValidationError('Events can only be created under organizer organizations');
		}

		const slug = payload.slug || slugify(payload.title);
		const duplicate = await prisma.event.findUnique({ where: { slug }, select: { id: true } });

		if (duplicate) {
			throw new ValidationError('Event slug already exists');
		}

		const event = await prisma.event.create({
			data: {
				organizationId: payload.organizationId,
				createdByUserId: request.user!.id,
				slug,
				title: payload.title,
				shortDescription: payload.shortDescription,
				description: payload.description,
				location: payload.location,
				timezone: payload.timezone || 'Africa/Porto-Novo',
				startAt: payload.startAt,
				endAt: payload.endAt,
				bannerImageUrl: payload.bannerImageUrl,
				isFeatured: payload.isFeatured || false,
				capacity: payload.capacity,
				status: 'DRAFT',
				publicationStatus: 'DRAFT'
			}
		});

		response.status(201).json(event);
	})
);

eventRoutes.patch(
	'/events/:id',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const parsed = updateEventSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid event update payload', parsed.error.flatten());
		}

		const existing = await prisma.event.findUnique({
			where: { id: request.params.id },
			select: {
				id: true,
				organizationId: true,
				startAt: true,
				endAt: true
			}
		});

		if (!existing) {
			throw new NotFoundError('Event not found');
		}

		const organization = await assertOrganizationManagementAccess(existing.organizationId, request.user!.id);
		const isAdmin = request.user!.roles.includes('admin');

		if (!isAdmin && organization.type !== 'ORGANIZER') {
			throw new ValidationError('Only organizer organizations can manage events');
		}

		const nextStartAt = parsed.data.startAt || existing.startAt;
		const nextEndAt = parsed.data.endAt || existing.endAt;

		if (nextEndAt <= nextStartAt) {
			throw new ValidationError('Event endAt must be after startAt');
		}

		let nextSlug = parsed.data.slug;
		if (!nextSlug && parsed.data.title) {
			nextSlug = slugify(parsed.data.title);
		}

		if (nextSlug) {
			const duplicate = await prisma.event.findFirst({
				where: {
					slug: nextSlug,
					id: { not: existing.id }
				},
				select: { id: true }
			});

			if (duplicate) {
				throw new ValidationError('Event slug already exists');
			}
		}

		const event = await prisma.event.update({
			where: { id: existing.id },
			data: {
				slug: nextSlug,
				title: parsed.data.title,
				shortDescription: parsed.data.shortDescription,
				description: parsed.data.description,
				location: parsed.data.location,
				timezone: parsed.data.timezone,
				startAt: parsed.data.startAt,
				endAt: parsed.data.endAt,
				bannerImageUrl: parsed.data.bannerImageUrl,
				isFeatured: parsed.data.isFeatured,
				capacity: parsed.data.capacity,
				status: parsed.data.status,
				publicationStatus: parsed.data.publicationStatus
			}
		});

		response.status(200).json(event);
	})
);

eventRoutes.delete(
	'/events/:id',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const existing = await prisma.event.findUnique({
			where: { id: request.params.id },
			select: { id: true, organizationId: true }
		});

		if (!existing) {
			throw new NotFoundError('Event not found');
		}

		const organization = await assertOrganizationManagementAccess(existing.organizationId, request.user!.id);
		const isAdmin = request.user!.roles.includes('admin');

		if (!isAdmin && organization.type !== 'ORGANIZER') {
			throw new ValidationError('Only organizer organizations can archive events');
		}

		const [event] = await prisma.$transaction([
			prisma.event.update({
				where: { id: existing.id },
				data: {
					status: 'CANCELLED',
					publicationStatus: 'ARCHIVED'
				}
			}),
			prisma.eventTicketType.updateMany({
				where: { eventId: existing.id },
				data: {
					publicationStatus: 'ARCHIVED'
				}
			})
		]);

		response.status(200).json({
			message: 'Event archived successfully',
			event
		});
	})
);

eventRoutes.post(
	'/events/:id/ticket-types',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const parsed = createTicketTypeSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid ticket type payload', parsed.error.flatten());
		}

		const event = await prisma.event.findUnique({
			where: { id: request.params.id },
			select: { id: true, organizationId: true }
		});

		if (!event) {
			throw new NotFoundError('Event not found');
		}

		const organization = await assertOrganizationManagementAccess(event.organizationId, request.user!.id);
		const isAdmin = request.user!.roles.includes('admin');

		if (!isAdmin && organization.type !== 'ORGANIZER') {
			throw new ValidationError('Only organizer organizations can manage tickets');
		}

		const payload = parsed.data;

		if (payload.salesStart && payload.salesEnd && payload.salesEnd <= payload.salesStart) {
			throw new ValidationError('Ticket salesEnd must be after salesStart');
		}

		const duplicate = await prisma.eventTicketType.findFirst({
			where: {
				eventId: event.id,
				name: payload.name
			},
			select: { id: true }
		});

		if (duplicate) {
			throw new ValidationError('Ticket type name already exists for this event');
		}

		const ticketType = await prisma.eventTicketType.create({
			data: {
				eventId: event.id,
				name: payload.name,
				description: payload.description,
				price: payload.price,
				currency: payload.currency || 'XOF',
				stock: payload.stock,
				maxPerUser: payload.maxPerUser,
				salesStart: payload.salesStart,
				salesEnd: payload.salesEnd,
				publicationStatus: payload.publicationStatus || 'DRAFT'
			}
		});

		response.status(201).json(ticketType);
	})
);

eventRoutes.get(
	'/events/:id/bookings',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const event = await prisma.event.findUnique({
			where: { id: request.params.id },
			select: { id: true, organizationId: true }
		});

		if (!event) {
			throw new NotFoundError('Event not found');
		}

		const organization = await assertOrganizationManagementAccess(event.organizationId, request.user!.id);
		const isAdmin = request.user!.roles.includes('admin');

		if (!isAdmin && organization.type !== 'ORGANIZER') {
			throw new ValidationError('Only organizer organizations can view event bookings');
		}

		const page = Math.max(1, Number(request.query.page) || 1);
		const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 20));

		const where = { eventId: event.id };

		const [tickets, total] = await Promise.all([
			prisma.ticket.findMany({
				where,
				orderBy: { createdAt: 'desc' },
				skip: (page - 1) * limit,
				take: limit,
				include: {
					eventTicketType: {
						select: {
							id: true,
							name: true,
							price: true,
							currency: true
						}
					},
					owner: {
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
					orderItem: {
						select: {
							id: true,
							orderId: true,
							storeOrderId: true
						}
					}
				}
			}),
			prisma.ticket.count({ where })
		]);

		response.status(200).json({
			data: tickets,
			meta: {
				page,
				limit,
				total,
				totalPages: Math.max(1, Math.ceil(total / limit))
			}
		});
	})
);

eventRoutes.get(
	'/events/:id/ticket-scans',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const event = await prisma.event.findUnique({
			where: { id: request.params.id },
			select: { id: true, organizationId: true }
		});

		if (!event) {
			throw new NotFoundError('Event not found');
		}

		const organization = await assertOrganizationManagementAccess(event.organizationId, request.user!.id);
		const isAdmin = request.user!.roles.includes('admin');

		if (!isAdmin && organization.type !== 'ORGANIZER') {
			throw new ValidationError('Only organizer organizations can view ticket scans');
		}

		const page = Math.max(1, Number(request.query.page) || 1);
		const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 20));

		const where = {
			ticket: {
				eventId: event.id
			}
		};

		const [scans, total, validCount, alreadyUsedCount, cancelledCount, expiredCount, invalidCount] = await Promise.all([
			prisma.ticketScan.findMany({
				where,
				orderBy: { scannedAt: 'desc' },
				skip: (page - 1) * limit,
				take: limit,
				include: {
					ticket: {
						select: {
							id: true,
							status: true,
							beneficiaryName: true,
							beneficiaryEmail: true
						}
					},
					scanner: {
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
			}),
			prisma.ticketScan.count({ where }),
			prisma.ticketScan.count({ where: { ...where, scanResult: 'VALID' } }),
			prisma.ticketScan.count({ where: { ...where, scanResult: 'ALREADY_USED' } }),
			prisma.ticketScan.count({ where: { ...where, scanResult: 'CANCELLED' } }),
			prisma.ticketScan.count({ where: { ...where, scanResult: 'EXPIRED' } }),
			prisma.ticketScan.count({ where: { ...where, scanResult: 'INVALID' } })
		]);

		response.status(200).json({
			data: scans,
			meta: {
				page,
				limit,
				total,
				totalPages: Math.max(1, Math.ceil(total / limit))
			},
			summary: {
				valid: validCount,
				alreadyUsed: alreadyUsedCount,
				cancelled: cancelledCount,
				expired: expiredCount,
				invalid: invalidCount
			}
		});
	})
);

eventRoutes.post(
	'/tickets/:id/scan',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const parsed = scanTicketSchema.safeParse(request.body || {});

		if (!parsed.success) {
			throw new ValidationError('Invalid ticket scan payload', parsed.error.flatten());
		}

		const ticket = await prisma.ticket.findUnique({
			where: { id: request.params.id },
			include: {
				event: {
					select: {
						organizationId: true,
						title: true
					}
				}
			}
		});

		if (!ticket) {
			throw new NotFoundError('Ticket not found');
		}

		const organization = await assertOrganizationManagementAccess(ticket.event.organizationId, request.user!.id);
		const isAdmin = request.user!.roles.includes('admin');

		if (!isAdmin && organization.type !== 'ORGANIZER') {
			throw new ValidationError('Only organizer organizations can scan tickets');
		}

		const now = new Date();
		let scanResult: 'VALID' | 'ALREADY_USED' | 'CANCELLED' | 'EXPIRED' = 'VALID';

		if (ticket.status === 'CANCELLED') {
			scanResult = 'CANCELLED';
		} else if (ticket.usedAt || ticket.status === 'USED') {
			scanResult = 'ALREADY_USED';
		} else if (ticket.expiresAt && ticket.expiresAt < now) {
			scanResult = 'EXPIRED';
		}

		await prisma.ticketScan.create({
			data: {
				ticketId: ticket.id,
				scannerUserId: request.user!.id,
				gate: parsed.data.gate,
				deviceInfo: parsed.data.deviceInfo,
				ipAddress: request.ip,
				scanResult
			}
		});

		if (scanResult === 'VALID') {
			await prisma.ticket.update({
				where: { id: ticket.id },
				data: {
					status: 'USED',
					usedAt: now
				}
			});
		}

		response.status(200).json({
			ticketId: ticket.id,
			eventTitle: ticket.event.title,
			scanResult,
			statusAfterScan: scanResult === 'VALID' ? 'USED' : ticket.status,
			usedAt: scanResult === 'VALID' ? now : ticket.usedAt
		});
	})
);

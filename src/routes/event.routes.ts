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
import { buildPublicEventWhere } from '../modules/events/publicEvents';
import {
	buildTicketQrCode,
	buildTicketQrSecret,
	isTicketSaleWindowOpen,
	PURCHASABLE_EVENT_STATUSES,
	resolveBeneficiaryName
} from '../modules/events/ticketPurchase';
import {
	buildTicketPdfBuffer,
	buildTicketPdfFilename,
	buildTicketQrPng,
	mapTicketToPdfPayload
} from '../modules/events/ticketPdf';

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
	capacity: z.number().int().positive().optional(),
	status: z.enum(['DRAFT', 'SCHEDULED', 'ONGOING', 'COMPLETED', 'CANCELLED']).optional(),
	publicationStatus: z
		.enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED'])
		.optional()
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
	price: z.coerce.number().nonnegative(),
	currency: z.string().min(3).max(3).optional(),
	stock: z.coerce.number().int().positive(),
	maxPerUser: z.coerce.number().int().positive().optional(),
	salesStart: z.coerce.date().optional(),
	salesEnd: z.coerce.date().optional(),
	publicationStatus: z
		.enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED'])
		.optional()
});

const updateTicketTypeSchema = z.object({
	name: z.string().min(2).optional(),
	description: z.string().max(1500).optional(),
	price: z.coerce.number().nonnegative().optional(),
	currency: z.string().min(3).max(3).optional(),
	stock: z.coerce.number().int().positive().optional(),
	maxPerUser: z.coerce.number().int().positive().optional(),
	salesStart: z.coerce.date().optional(),
	salesEnd: z.coerce.date().optional(),
	publicationStatus: z
		.enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED'])
		.optional()
});

const purchaseTicketSchema = z.object({
	eventTicketTypeId: z.string().min(1),
	quantity: z.coerce.number().int().positive().max(20).optional(),
	beneficiaryName: z.string().min(2).max(120).optional(),
	beneficiaryEmail: z.string().email().optional()
});

const scanTicketSchema = z.object({
	gate: z.string().max(120).optional(),
	deviceInfo: z.string().max(200).optional()
});

const qrScanSchema = z.object({
	qrCode: z.string().min(1),
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

async function resolveUniqueEventSlug(baseValue: string, excludedEventId?: string) {
	const sanitizedBase = slugify(baseValue) || `event-${Date.now()}`;
	let candidate = sanitizedBase;
	let suffix = 2;

	while (true) {
		const duplicate = await prisma.event.findFirst({
			where: {
				slug: candidate,
				...(excludedEventId
					? {
							id: {
								not: excludedEventId
							}
					  }
					: {})
			},
			select: {
				id: true
			}
		});

		if (!duplicate) {
			return candidate;
		}

		candidate = `${sanitizedBase}-${suffix}`;
		suffix += 1;
	}
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

		const where = buildPublicEventWhere({ search, organizationSlug });

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
			where: buildPublicEventWhere({ slug: request.params.slug }),
			include: {
				organization: {
					select: {
						id: true,
						name: true,
						slug: true,
						owner: {
							select: {
								email: true,
								phone: true,
								profile: {
									select: {
										firstName: true,
										lastName: true
									}
								}
							}
						}
					}
				},
				media: {
					select: {
						id: true,
						url: true,
						type: true,
						sortOrder: true
					},
					orderBy: { sortOrder: 'asc' }
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

eventRoutes.post(
	'/events/:id/tickets/purchase',
	asyncHandler(async (request, response) => {
		const parsed = purchaseTicketSchema.safeParse(request.body || {});

		if (!parsed.success) {
			throw new ValidationError('Invalid ticket purchase payload', parsed.error.flatten());
		}

		const now = new Date();
		const payload = parsed.data;
		const requestedQuantity = payload.quantity || 1;

		const tickets = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
			const ticketType = await tx.eventTicketType.findFirst({
				where: {
					id: payload.eventTicketTypeId,
					eventId: request.params.id,
					publicationStatus: 'PUBLISHED',
					event: {
						publicationStatus: 'PUBLISHED',
						status: {
							in: [...PURCHASABLE_EVENT_STATUSES]
						}
					}
				},
				include: {
					event: {
						select: {
							id: true,
							title: true,
							endAt: true
						}
					}
				}
			});

			if (!ticketType) {
				throw new NotFoundError('Ticket type not found or not purchasable for this event');
			}

			if (!isTicketSaleWindowOpen(ticketType.salesStart, ticketType.salesEnd, now)) {
				throw new ValidationError('Ticket sales are not active for this ticket type');
			}

			const availableCount = Math.max(0, ticketType.stock - ticketType.sold - ticketType.reserved);
			if (requestedQuantity > availableCount) {
				throw new ValidationError('Requested quantity exceeds available tickets');
			}

			if (ticketType.maxPerUser) {
				const ownedCount = await tx.ticket.count({
					where: {
						eventTicketTypeId: ticketType.id,
						ownerUserId: request.user!.id,
						status: {
							notIn: ['CANCELLED', 'REFUNDED']
						}
					}
				});

				if (ownedCount + requestedQuantity > ticketType.maxPerUser) {
					throw new ValidationError('Max tickets reached for this ticket type');
				}
			}

			const stockUpdate = await tx.eventTicketType.updateMany({
				where: {
					id: ticketType.id,
					sold: ticketType.sold,
					reserved: ticketType.reserved
				},
				data: {
					sold: {
						increment: requestedQuantity
					}
				}
			});

			if (stockUpdate.count === 0) {
				throw new ValidationError('Ticket stock changed, please retry your purchase');
			}

			const buyer = await tx.user.findUnique({
				where: {
					id: request.user!.id
				},
				select: {
					email: true,
					profile: {
						select: {
							firstName: true,
							lastName: true
						}
					}
				}
			});

			if (!buyer) {
				throw new NotFoundError('User not found');
			}

			const beneficiaryName = resolveBeneficiaryName({
				beneficiaryName: payload.beneficiaryName,
				profileFirstName: buyer.profile?.firstName,
				profileLastName: buyer.profile?.lastName,
				email: buyer.email
			});

			const beneficiaryEmail = (payload.beneficiaryEmail || buyer.email || '').trim();

			if (!beneficiaryEmail) {
				throw new ValidationError('Beneficiary email is required');
			}

			const createdTickets = [];

			for (let i = 0; i < requestedQuantity; i += 1) {
				let createdTicket = null;

				for (let attempt = 0; attempt < 3; attempt += 1) {
					try {
						createdTicket = await tx.ticket.create({
							data: {
								eventId: ticketType.eventId,
								eventTicketTypeId: ticketType.id,
								ownerUserId: request.user!.id,
								beneficiaryName,
								beneficiaryEmail,
								qrCode: buildTicketQrCode(),
								qrSecret: buildTicketQrSecret(),
								expiresAt: ticketType.event.endAt
							},
							include: {
								eventTicketType: {
									select: {
										id: true,
										name: true,
										price: true,
										currency: true
									}
								},
								event: {
									select: {
										id: true,
										title: true
									}
								}
							}
						});
						break;
					} catch (error) {
						if (
							error instanceof Prisma.PrismaClientKnownRequestError &&
							error.code === 'P2002' &&
							attempt < 2
						) {
							continue;
						}

						throw error;
					}
				}

				if (!createdTicket) {
					throw new ValidationError('Unable to generate a unique QR ticket code');
				}

				createdTickets.push(createdTicket);
			}

			return createdTickets;
		});

		response.status(201).json({
			message: requestedQuantity > 1 ? 'Tickets purchased successfully' : 'Ticket purchased successfully',
			quantity: requestedQuantity,
			ticket: tickets[0],
			tickets
		});
	})
);

eventRoutes.get(
	'/events/:id/my-tickets',
	asyncHandler(async (request, response) => {
		const event = await prisma.event.findUnique({
			where: {
				id: request.params.id
			},
			select: {
				id: true
			}
		});

		if (!event) {
			throw new NotFoundError('Event not found');
		}

		const tickets = await prisma.ticket.findMany({
			where: {
				eventId: event.id,
				ownerUserId: request.user!.id
			},
			orderBy: {
				createdAt: 'desc'
			},
			select: {
				id: true,
				eventId: true,
				beneficiaryName: true,
				beneficiaryEmail: true,
				status: true,
				issuedAt: true,
				createdAt: true,
				expiresAt: true,
				event: {
					select: {
						id: true,
						slug: true,
						title: true,
						startAt: true,
						endAt: true,
						location: true,
						bannerImageUrl: true,
						media: {
							select: {
								url: true,
								sortOrder: true
							},
							orderBy: {
								sortOrder: 'asc'
							},
							take: 1
						}
					}
				},
				eventTicketType: {
					select: {
						id: true,
						name: true,
						price: true,
						currency: true
					}
				}
			}
		});

		response.status(200).json({
			data: tickets
		});
	})
);

eventRoutes.get(
	'/tickets/me',
	asyncHandler(async (request, response) => {
		const tickets = await prisma.ticket.findMany({
			where: {
				ownerUserId: request.user!.id
			},
			orderBy: {
				createdAt: 'desc'
			},
			select: {
				id: true,
				eventId: true,
				beneficiaryName: true,
				beneficiaryEmail: true,
				status: true,
				issuedAt: true,
				createdAt: true,
				expiresAt: true,
				event: {
					select: {
						id: true,
						slug: true,
						title: true,
						startAt: true,
						endAt: true,
						location: true,
						bannerImageUrl: true,
						media: {
							select: {
								url: true,
								sortOrder: true
							},
							orderBy: {
								sortOrder: 'asc'
							},
							take: 1
						}
					}
				},
				eventTicketType: {
					select: {
						id: true,
						name: true,
						price: true,
						currency: true
					}
				}
			}
		});

		response.status(200).json({
			data: tickets
		});
	})
);

eventRoutes.get(
	'/tickets/:id/qr',
	asyncHandler(async (request, response) => {
		const ticket = await prisma.ticket.findFirst({
			where: {
				id: request.params.id,
				ownerUserId: request.user!.id
			},
			select: {
				qrCode: true
			}
		});

		if (!ticket) {
			throw new NotFoundError('Ticket not found');
		}

		const qrPngBuffer = await buildTicketQrPng(ticket.qrCode);

		response.setHeader('Content-Type', 'image/png');
		response.setHeader('Content-Length', String(qrPngBuffer.byteLength));
		response.setHeader('Cache-Control', 'no-store');

		response.status(200).send(qrPngBuffer);
	})
);

eventRoutes.get(
	'/tickets/:id/pdf',
	asyncHandler(async (request, response) => {
		const ticket = await prisma.ticket.findFirst({
			where: {
				id: request.params.id,
				ownerUserId: request.user!.id
			},
			include: {
				event: {
					select: {
						title: true,
						startAt: true,
						location: true
					}
				},
				eventTicketType: {
					select: {
						name: true,
						description: true,
						price: true,
						currency: true
					}
				}
			}
		});

		if (!ticket) {
			throw new NotFoundError('Ticket not found');
		}

		const pdfPayload = mapTicketToPdfPayload(ticket);
		const pdfBuffer = await buildTicketPdfBuffer(pdfPayload);
		const filename = buildTicketPdfFilename(pdfPayload.eventName, pdfPayload.displayReference);

		response.setHeader('Content-Type', 'application/pdf');
		response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
		response.setHeader('Content-Length', String(pdfBuffer.byteLength));
		response.setHeader('Cache-Control', 'no-store');

		response.status(200).send(pdfBuffer);
	})
);

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

		const requestedSlug = payload.slug ? slugify(payload.slug) : '';

		if (payload.slug && !requestedSlug) {
			throw new ValidationError('Event slug is invalid');
		}

		let slug = requestedSlug;

		if (requestedSlug) {
			const duplicate = await prisma.event.findUnique({ where: { slug: requestedSlug }, select: { id: true } });

			if (duplicate) {
				throw new ValidationError('Event slug already exists');
			}
		} else {
			slug = await resolveUniqueEventSlug(payload.title);
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
				status: payload.status || 'DRAFT',
				publicationStatus: payload.publicationStatus || 'DRAFT'
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

		const requestedSlug = parsed.data.slug ? slugify(parsed.data.slug) : undefined;

		if (parsed.data.slug && !requestedSlug) {
			throw new ValidationError('Event slug is invalid');
		}

		let nextSlug = requestedSlug;

		if (!nextSlug && parsed.data.title) {
			nextSlug = await resolveUniqueEventSlug(parsed.data.title, existing.id);
		}

		if (requestedSlug) {
			const duplicate = await prisma.event.findFirst({
				where: {
					slug: requestedSlug,
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
// ─── GET /events/:id/ticket-types (organizer, all statuses) ──────────────────
eventRoutes.get(
	'/events/:id/ticket-types',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const event = await prisma.event.findUnique({
			where: { id: request.params.id },
			select: { id: true, organizationId: true }
		});

		if (!event) {
			throw new NotFoundError('Event not found');
		}

		await assertOrganizationManagementAccess(event.organizationId, request.user!.id);

		const ticketTypes = await prisma.eventTicketType.findMany({
			where: { eventId: event.id },
			orderBy: { createdAt: 'asc' }
		});

		response.status(200).json({ data: ticketTypes });
	})
);

// ─── PATCH /events/:id/ticket-types/:typeId ───────────────────────────────────
eventRoutes.patch(
	'/events/:id/ticket-types/:typeId',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const parsed = updateTicketTypeSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid ticket type update payload', parsed.error.flatten());
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
			throw new ValidationError('Only organizer organizations can update ticket types');
		}

		const existing = await prisma.eventTicketType.findFirst({
			where: { id: request.params.typeId, eventId: event.id },
			select: { id: true, name: true, salesStart: true, salesEnd: true }
		});

		if (!existing) {
			throw new NotFoundError('Ticket type not found');
		}

		if (parsed.data.name && parsed.data.name !== existing.name) {
			const duplicate = await prisma.eventTicketType.findFirst({
				where: { eventId: event.id, name: parsed.data.name, id: { not: existing.id } },
				select: { id: true }
			});

			if (duplicate) {
				throw new ValidationError('Ticket type name already exists for this event');
			}
		}

		const nextSalesStart = parsed.data.salesStart ?? existing.salesStart;
		const nextSalesEnd = parsed.data.salesEnd ?? existing.salesEnd;

		if (nextSalesStart && nextSalesEnd && nextSalesEnd <= nextSalesStart) {
			throw new ValidationError('Ticket salesEnd must be after salesStart');
		}

		const ticketType = await prisma.eventTicketType.update({
			where: { id: existing.id },
			data: {
				name: parsed.data.name,
				description: parsed.data.description,
				price: parsed.data.price,
				currency: parsed.data.currency,
				stock: parsed.data.stock,
				maxPerUser: parsed.data.maxPerUser,
				salesStart: parsed.data.salesStart,
				salesEnd: parsed.data.salesEnd,
				publicationStatus: parsed.data.publicationStatus
			}
		});

		response.status(200).json(ticketType);
	})
);

// ─── DELETE /events/:id/ticket-types/:typeId (archive) ───────────────────────
eventRoutes.delete(
	'/events/:id/ticket-types/:typeId',
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
			throw new ValidationError('Only organizer organizations can archive ticket types');
		}

		const existing = await prisma.eventTicketType.findFirst({
			where: { id: request.params.typeId, eventId: event.id },
			select: { id: true }
		});

		if (!existing) {
			throw new NotFoundError('Ticket type not found');
		}

		const ticketType = await prisma.eventTicketType.update({
			where: { id: existing.id },
			data: { publicationStatus: 'ARCHIVED' }
		});

		response.status(200).json({ message: 'Ticket type archived successfully', ticketType });
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

// ─── POST /tickets/qr-scan (scan by QR code string) ──────────────────────────
eventRoutes.post(
	'/tickets/qr-scan',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const parsed = qrScanSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid QR scan payload', parsed.error.flatten());
		}

		const { qrCode, gate, deviceInfo } = parsed.data;

		const ticket = await prisma.ticket.findUnique({
			where: { qrCode },
			include: {
				event: { select: { id: true, title: true, organizationId: true } }
			}
		});

		if (!ticket) {
			throw new NotFoundError('Ticket not found');
		}

		await assertOrganizationManagementAccess(ticket.event.organizationId, request.user!.id);

		const now = new Date();
		let scanResult: 'VALID' | 'ALREADY_USED' | 'CANCELLED' | 'EXPIRED' = 'VALID';

		if (ticket.status === 'USED') {
			scanResult = 'ALREADY_USED';
		} else if (ticket.status === 'CANCELLED' || ticket.status === 'REFUNDED') {
			scanResult = 'CANCELLED';
		} else if (ticket.status === 'EXPIRED') {
			scanResult = 'EXPIRED';
		}

		await prisma.ticketScan.create({
			data: {
				ticketId: ticket.id,
				eventId: ticket.eventId,
				scannedById: request.user!.id,
				result: scanResult,
				gate: gate ?? null,
				deviceInfo: deviceInfo ?? null,
				scannedAt: now
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

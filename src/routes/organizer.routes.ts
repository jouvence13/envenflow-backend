import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../core/middleware/auth.middleware';
import { roleMiddleware } from '../core/middleware/role.middleware';
import { asyncHandler } from '../core/middleware/async.middleware';
import { prisma } from '../libs/prisma';
import { ValidationError } from '../core/errors/ValidationError';
import { NotFoundError } from '../core/errors/NotFoundError';
import {
  assertOrganizationManagementAccess,
  assertStoreManagementAccess
} from '../core/utils/storeAccess';

export const organizerRoutes = Router();

const ORGANIZATION_MANAGER_ROLES = ['OWNER', 'ADMIN', 'MANAGER'] as const;
const STORE_MANAGER_ROLES = ['OWNER', 'ADMIN', 'MANAGER'] as const;

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
  capacity: z.coerce.number().int().positive().optional(),
  status: z.enum(['DRAFT', 'SCHEDULED', 'ONGOING', 'COMPLETED', 'CANCELLED']).optional(),
  publicationStatus: z
    .enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED'])
    .optional()
});

const updateEventSchema = createEventSchema
  .omit({ organizationId: true })
  .partial();

const createContestSchema = z.object({
  organizationId: z.string().min(1),
  slug: z.string().min(2).optional(),
  title: z.string().min(2),
  subtitle: z.string().max(300).optional(),
  description: z.string().max(5000).optional(),
  category: z.string().min(2),
  bannerImageUrl: z.string().url().optional(),
  votePrice: z.coerce.number().positive(),
  currency: z.string().min(3).max(3).optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
  votesStart: z.coerce.date().optional(),
  votesEnd: z.coerce.date().optional(),
  maxVotesPerAccount: z.coerce.number().int().positive().optional(),
  status: z.enum(['UPCOMING', 'VOTING_OPEN', 'CLOSED', 'ARCHIVED']).optional(),
  publicationStatus: z
    .enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED'])
    .optional()
});

const updateContestSchema = createContestSchema
  .omit({ organizationId: true })
  .partial();

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
  viewerLimit: z.coerce.number().int().positive().optional(),
  status: z.enum(['UPCOMING', 'LIVE', 'ENDED', 'CANCELLED']).optional(),
  publicationStatus: z
    .enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED'])
    .optional()
});

const updateLiveSchema = createLiveSchema
  .omit({ organizationId: true })
  .partial();

const createProductSchema = z.object({
  storeId: z.string().min(1),
  categoryId: z.string().optional(),
  eventId: z.string().optional(),
  name: z.string().min(2),
  slug: z.string().min(2).optional(),
  description: z.string().max(4000).optional(),
  productType: z.enum(['PHYSICAL', 'DIGITAL', 'JERSEY', 'MERCH', 'EVENT_MERCH']),
  currency: z.string().min(3).max(3).optional(),
  price: z.coerce.number().positive(),
  oldPrice: z.coerce.number().positive().optional(),
  stock: z.coerce.number().int().min(0).optional(),
  isCustomizable: z.boolean().optional(),
  metadata: z.record(z.any()).optional(),
  publicationStatus: z
    .enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED'])
    .optional()
});

const updateProductSchema = createProductSchema
  .omit({ storeId: true })
  .partial();

const createJerseySchema = z.object({
  storeId: z.string().min(1),
  categoryId: z.string().optional(),
  name: z.string().min(2),
  slug: z.string().min(2).optional(),
  description: z.string().max(4000).optional(),
  currency: z.string().min(3).max(3).optional(),
  price: z.coerce.number().positive(),
  oldPrice: z.coerce.number().positive().optional(),
  stock: z.coerce.number().int().min(0).optional(),
  isCustomizable: z.boolean().optional(),
  metadata: z.record(z.any()).optional(),
  publicationStatus: z
    .enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED'])
    .optional()
});

const updateJerseySchema = createJerseySchema
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

function parsePagination(query: { page?: unknown; limit?: unknown }) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));

  return { page, limit };
}

function parseSearch(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function buildManagedOrganizerFilter(userId: string, isAdmin: boolean) {
  if (isAdmin) {
    return {
      type: 'ORGANIZER'
    };
  }

  return {
    type: 'ORGANIZER',
    OR: [
      { ownerUserId: userId },
      {
        members: {
          some: {
            userId,
            status: 'ACTIVE',
            role: {
              in: [...ORGANIZATION_MANAGER_ROLES]
            }
          }
        }
      }
    ]
  };
}

function buildManagedStoreFilter(userId: string, isAdmin: boolean) {
  if (isAdmin) {
    return {};
  }

  return {
    OR: [
      { ownerUserId: userId },
      {
        members: {
          some: {
            userId,
            status: 'ACTIVE',
            role: {
              in: [...STORE_MANAGER_ROLES]
            }
          }
        }
      }
    ]
  };
}

async function assertOrganizerOrganizationAccess(organizationId: string, userId: string, isAdmin: boolean) {
  const organization = await assertOrganizationManagementAccess(organizationId, userId);

  if (organization.type !== 'ORGANIZER') {
    throw new ValidationError('Only organizer organizations can be managed by this route');
  }

  return organization;
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

async function resolveUniqueContestSlug(baseValue: string, excludedContestId?: string) {
  const sanitizedBase = slugify(baseValue) || `contest-${Date.now()}`;
  let candidate = sanitizedBase;
  let suffix = 2;

  while (true) {
    const duplicate = await prisma.contest.findFirst({
      where: {
        slug: candidate,
        ...(excludedContestId
          ? {
              id: {
                not: excludedContestId
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

async function resolveUniqueLiveSlug(baseValue: string, excludedLiveId?: string) {
  const sanitizedBase = slugify(baseValue) || `live-${Date.now()}`;
  let candidate = sanitizedBase;
  let suffix = 2;

  while (true) {
    const duplicate = await prisma.liveEvent.findFirst({
      where: {
        slug: candidate,
        ...(excludedLiveId
          ? {
              id: {
                not: excludedLiveId
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

async function resolveUniqueProductSlug(storeId: string, baseValue: string, excludedProductId?: string) {
  const sanitizedBase = slugify(baseValue) || `product-${Date.now()}`;
  let candidate = sanitizedBase;
  let suffix = 2;

  while (true) {
    const duplicate = await prisma.product.findFirst({
      where: {
        storeId,
        slug: candidate,
        ...(excludedProductId
          ? {
              id: {
                not: excludedProductId
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

organizerRoutes.use('/organizer', authMiddleware, roleMiddleware(['organizer', 'admin']));

// Events
organizerRoutes.post(
  '/organizer/events',
  asyncHandler(async (request, response) => {
    const parsed = createEventSchema.safeParse(request.body || {});

    if (!parsed.success) {
      throw new ValidationError('Invalid organizer event payload', parsed.error.flatten());
    }

    const payload = parsed.data;
    const isAdmin = request.user!.roles.includes('admin');

    if (payload.endAt <= payload.startAt) {
      throw new ValidationError('Event endAt must be after startAt');
    }

    await assertOrganizerOrganizationAccess(payload.organizationId, request.user!.id, isAdmin);

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

    response.status(201).json({ data: event });
  })
);

organizerRoutes.get(
  '/organizer/events',
  asyncHandler(async (request, response) => {
    const { page, limit } = parsePagination(request.query);
    const search = parseSearch(request.query.search);
    const isAdmin = request.user!.roles.includes('admin');

    const where: Record<string, unknown> = {
      organization: buildManagedOrganizerFilter(request.user!.id, isAdmin)
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

organizerRoutes.get(
  '/organizer/events/:id',
  asyncHandler(async (request, response) => {
    const event = await prisma.event.findUnique({
      where: { id: request.params.id },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            type: true,
            ownerUserId: true
          }
        },
        ticketTypes: {
          orderBy: { createdAt: 'desc' }
        },
        media: {
          orderBy: { sortOrder: 'asc' }
        }
      }
    });

    if (!event) {
      throw new NotFoundError('Event not found');
    }

    await assertOrganizerOrganizationAccess(
      event.organizationId,
      request.user!.id,
      request.user!.roles.includes('admin')
    );

    response.status(200).json({ data: event });
  })
);

organizerRoutes.patch(
  '/organizer/events/:id',
  asyncHandler(async (request, response) => {
    const parsed = updateEventSchema.safeParse(request.body || {});

    if (!parsed.success) {
      throw new ValidationError('Invalid organizer event update payload', parsed.error.flatten());
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

    const isAdmin = request.user!.roles.includes('admin');
    await assertOrganizerOrganizationAccess(existing.organizationId, request.user!.id, isAdmin);

    const nextStartAt = parsed.data.startAt || existing.startAt;
    const nextEndAt = parsed.data.endAt || existing.endAt;

    if (nextEndAt <= nextStartAt) {
      throw new ValidationError('Event endAt must be after startAt');
    }

    let nextSlug: string | undefined;

    if (parsed.data.slug) {
      nextSlug = slugify(parsed.data.slug);

      if (!nextSlug) {
        throw new ValidationError('Event slug is invalid');
      }

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

    response.status(200).json({ data: event });
  })
);

organizerRoutes.delete(
  '/organizer/events/:id',
  asyncHandler(async (request, response) => {
    const existing = await prisma.event.findUnique({
      where: { id: request.params.id },
      select: {
        id: true,
        organizationId: true
      }
    });

    if (!existing) {
      throw new NotFoundError('Event not found');
    }

    const isAdmin = request.user!.roles.includes('admin');
    await assertOrganizerOrganizationAccess(existing.organizationId, request.user!.id, isAdmin);

    const [event] = await prisma.$transaction([
      prisma.event.update({
        where: { id: existing.id },
        data: {
          status: 'CANCELLED',
          publicationStatus: 'ARCHIVED'
        }
      }),
      prisma.eventTicketType.updateMany({
        where: {
          eventId: existing.id
        },
        data: {
          publicationStatus: 'ARCHIVED'
        }
      })
    ]);

    response.status(200).json({
      message: 'Event archived successfully',
      data: event
    });
  })
);

// Contests
organizerRoutes.post(
  '/organizer/contests',
  asyncHandler(async (request, response) => {
    const parsed = createContestSchema.safeParse(request.body || {});

    if (!parsed.success) {
      throw new ValidationError('Invalid organizer contest payload', parsed.error.flatten());
    }

    const payload = parsed.data;
    const isAdmin = request.user!.roles.includes('admin');

    await assertOrganizerOrganizationAccess(payload.organizationId, request.user!.id, isAdmin);

    if (payload.votesStart && payload.votesEnd && payload.votesEnd <= payload.votesStart) {
      throw new ValidationError('Contest votesEnd must be after votesStart');
    }

    const requestedSlug = payload.slug ? slugify(payload.slug) : '';

    if (payload.slug && !requestedSlug) {
      throw new ValidationError('Contest slug is invalid');
    }

    const slug = requestedSlug || (await resolveUniqueContestSlug(payload.title));

    if (requestedSlug) {
      const duplicate = await prisma.contest.findUnique({ where: { slug: requestedSlug }, select: { id: true } });

      if (duplicate) {
        throw new ValidationError('Contest slug already exists');
      }
    }

    const contest = await prisma.contest.create({
      data: {
        organizationId: payload.organizationId,
        createdByUserId: request.user!.id,
        slug,
        title: payload.title,
        subtitle: payload.subtitle,
        description: payload.description,
        category: payload.category,
        bannerImageUrl: payload.bannerImageUrl,
        status: payload.status || 'UPCOMING',
        publicationStatus: payload.publicationStatus || 'DRAFT',
        votePrice: payload.votePrice,
        currency: payload.currency || 'XOF',
        startAt: payload.startAt,
        endAt: payload.endAt,
        votesStart: payload.votesStart,
        votesEnd: payload.votesEnd,
        maxVotesPerAccount: payload.maxVotesPerAccount
      }
    });

    response.status(201).json({ data: contest });
  })
);

organizerRoutes.get(
  '/organizer/contests',
  asyncHandler(async (request, response) => {
    const { page, limit } = parsePagination(request.query);
    const search = parseSearch(request.query.search);
    const isAdmin = request.user!.roles.includes('admin');

    const where: Record<string, unknown> = {
      organization: buildManagedOrganizerFilter(request.user!.id, isAdmin)
    };

    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } }
      ];
    }

    const [contests, total] = await Promise.all([
      prisma.contest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
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
          _count: {
            select: {
              candidates: true,
              votes: true
            }
          }
        }
      }),
      prisma.contest.count({ where })
    ]);

    response.status(200).json({
      data: contests,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit))
      }
    });
  })
);

organizerRoutes.get(
  '/organizer/contests/:id',
  asyncHandler(async (request, response) => {
    const contest = await prisma.contest.findUnique({
      where: { id: request.params.id },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            type: true,
            ownerUserId: true
          }
        },
        candidates: {
          orderBy: {
            createdAt: 'asc'
          }
        },
        _count: {
          select: {
            candidates: true,
            votes: true
          }
        }
      }
    });

    if (!contest) {
      throw new NotFoundError('Contest not found');
    }

    await assertOrganizerOrganizationAccess(
      contest.organizationId,
      request.user!.id,
      request.user!.roles.includes('admin')
    );

    response.status(200).json({ data: contest });
  })
);

organizerRoutes.patch(
  '/organizer/contests/:id',
  asyncHandler(async (request, response) => {
    const parsed = updateContestSchema.safeParse(request.body || {});

    if (!parsed.success) {
      throw new ValidationError('Invalid organizer contest update payload', parsed.error.flatten());
    }

    const existing = await prisma.contest.findUnique({
      where: { id: request.params.id },
      select: {
        id: true,
        organizationId: true
      }
    });

    if (!existing) {
      throw new NotFoundError('Contest not found');
    }

    const isAdmin = request.user!.roles.includes('admin');
    await assertOrganizerOrganizationAccess(existing.organizationId, request.user!.id, isAdmin);

    const nextVotesStart = parsed.data.votesStart;
    const nextVotesEnd = parsed.data.votesEnd;

    if (nextVotesStart && nextVotesEnd && nextVotesEnd <= nextVotesStart) {
      throw new ValidationError('Contest votesEnd must be after votesStart');
    }

    let nextSlug: string | undefined;

    if (parsed.data.slug) {
      nextSlug = slugify(parsed.data.slug);

      if (!nextSlug) {
        throw new ValidationError('Contest slug is invalid');
      }

      const duplicate = await prisma.contest.findFirst({
        where: {
          slug: nextSlug,
          id: {
            not: existing.id
          }
        },
        select: { id: true }
      });

      if (duplicate) {
        throw new ValidationError('Contest slug already exists');
      }
    }

    const contest = await prisma.contest.update({
      where: { id: existing.id },
      data: {
        slug: nextSlug,
        title: parsed.data.title,
        subtitle: parsed.data.subtitle,
        description: parsed.data.description,
        category: parsed.data.category,
        bannerImageUrl: parsed.data.bannerImageUrl,
        status: parsed.data.status,
        publicationStatus: parsed.data.publicationStatus,
        votePrice: parsed.data.votePrice,
        currency: parsed.data.currency,
        startAt: parsed.data.startAt,
        endAt: parsed.data.endAt,
        votesStart: parsed.data.votesStart,
        votesEnd: parsed.data.votesEnd,
        maxVotesPerAccount: parsed.data.maxVotesPerAccount
      }
    });

    response.status(200).json({ data: contest });
  })
);

organizerRoutes.delete(
  '/organizer/contests/:id',
  asyncHandler(async (request, response) => {
    const existing = await prisma.contest.findUnique({
      where: { id: request.params.id },
      select: {
        id: true,
        organizationId: true
      }
    });

    if (!existing) {
      throw new NotFoundError('Contest not found');
    }

    const isAdmin = request.user!.roles.includes('admin');
    await assertOrganizerOrganizationAccess(existing.organizationId, request.user!.id, isAdmin);

    const contest = await prisma.contest.update({
      where: { id: existing.id },
      data: {
        status: 'ARCHIVED',
        publicationStatus: 'ARCHIVED'
      }
    });

    response.status(200).json({
      message: 'Contest archived successfully',
      data: contest
    });
  })
);

// Lives
organizerRoutes.post(
  '/organizer/lives',
  asyncHandler(async (request, response) => {
    const parsed = createLiveSchema.safeParse(request.body || {});

    if (!parsed.success) {
      throw new ValidationError('Invalid organizer live payload', parsed.error.flatten());
    }

    const payload = parsed.data;
    const isAdmin = request.user!.roles.includes('admin');

    if (payload.endAt <= payload.startAt) {
      throw new ValidationError('Live endAt must be after startAt');
    }

    await assertOrganizerOrganizationAccess(payload.organizationId, request.user!.id, isAdmin);

    const requestedSlug = payload.slug ? slugify(payload.slug) : '';

    if (payload.slug && !requestedSlug) {
      throw new ValidationError('Live slug is invalid');
    }

    const slug = requestedSlug || (await resolveUniqueLiveSlug(payload.title));

    if (requestedSlug) {
      const duplicate = await prisma.liveEvent.findUnique({ where: { slug: requestedSlug }, select: { id: true } });

      if (duplicate) {
        throw new ValidationError('Live slug already exists');
      }
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
        status: payload.status || 'UPCOMING',
        publicationStatus: payload.publicationStatus || 'DRAFT',
        isPaid: payload.isPaid ?? true,
        chatEnabled: payload.chatEnabled ?? true,
        viewerLimit: payload.viewerLimit
      }
    });

    response.status(201).json({ data: live });
  })
);

organizerRoutes.get(
  '/organizer/lives',
  asyncHandler(async (request, response) => {
    const { page, limit } = parsePagination(request.query);
    const search = parseSearch(request.query.search);
    const isAdmin = request.user!.roles.includes('admin');

    const where: Record<string, unknown> = {
      organization: buildManagedOrganizerFilter(request.user!.id, isAdmin)
    };

    if (search) {
      where.OR = [
        {
          title: {
            contains: search,
            mode: 'insensitive'
          }
        }
      ];
    }

    const [lives, total] = await Promise.all([
      prisma.liveEvent.findMany({
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
            orderBy: { createdAt: 'desc' }
          }
        }
      }),
      prisma.liveEvent.count({ where })
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

organizerRoutes.get(
  '/organizer/lives/:id',
  asyncHandler(async (request, response) => {
    const live = await prisma.liveEvent.findUnique({
      where: { id: request.params.id },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            type: true,
            ownerUserId: true
          }
        },
        ticketTypes: {
          orderBy: {
            createdAt: 'asc'
          }
        }
      }
    });

    if (!live) {
      throw new NotFoundError('Live event not found');
    }

    await assertOrganizerOrganizationAccess(
      live.organizationId,
      request.user!.id,
      request.user!.roles.includes('admin')
    );

    response.status(200).json({ data: live });
  })
);

organizerRoutes.patch(
  '/organizer/lives/:id',
  asyncHandler(async (request, response) => {
    const parsed = updateLiveSchema.safeParse(request.body || {});

    if (!parsed.success) {
      throw new ValidationError('Invalid organizer live update payload', parsed.error.flatten());
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

    const isAdmin = request.user!.roles.includes('admin');
    await assertOrganizerOrganizationAccess(existing.organizationId, request.user!.id, isAdmin);

    const nextStartAt = parsed.data.startAt || existing.startAt;
    const nextEndAt = parsed.data.endAt || existing.endAt;

    if (nextEndAt <= nextStartAt) {
      throw new ValidationError('Live endAt must be after startAt');
    }

    let nextSlug: string | undefined;

    if (parsed.data.slug) {
      nextSlug = slugify(parsed.data.slug);

      if (!nextSlug) {
        throw new ValidationError('Live slug is invalid');
      }

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

    response.status(200).json({ data: live });
  })
);

organizerRoutes.delete(
  '/organizer/lives/:id',
  asyncHandler(async (request, response) => {
    const existing = await prisma.liveEvent.findUnique({
      where: { id: request.params.id },
      select: {
        id: true,
        organizationId: true
      }
    });

    if (!existing) {
      throw new NotFoundError('Live event not found');
    }

    const isAdmin = request.user!.roles.includes('admin');
    await assertOrganizerOrganizationAccess(existing.organizationId, request.user!.id, isAdmin);

    const live = await prisma.liveEvent.update({
      where: { id: existing.id },
      data: {
        status: 'CANCELLED',
        publicationStatus: 'ARCHIVED'
      }
    });

    response.status(200).json({
      message: 'Live archived successfully',
      data: live
    });
  })
);

// Products
organizerRoutes.post(
  '/organizer/products',
  asyncHandler(async (request, response) => {
    const parsed = createProductSchema.safeParse(request.body || {});

    if (!parsed.success) {
      throw new ValidationError('Invalid organizer product payload', parsed.error.flatten());
    }

    const payload = parsed.data;
    const store = await assertStoreManagementAccess(payload.storeId, request.user!.id);

    const requestedSlug = payload.slug ? slugify(payload.slug) : '';

    if (payload.slug && !requestedSlug) {
      throw new ValidationError('Product slug is invalid');
    }

    const slug = requestedSlug || (await resolveUniqueProductSlug(store.id, payload.name));

    if (requestedSlug) {
      const duplicate = await prisma.product.findFirst({
        where: {
          storeId: store.id,
          slug: requestedSlug
        },
        select: { id: true }
      });

      if (duplicate) {
        throw new ValidationError('Product slug already exists for this store');
      }
    }

    if (payload.oldPrice && payload.oldPrice <= payload.price) {
      throw new ValidationError('oldPrice must be greater than price');
    }

    const stock = payload.stock ?? 0;

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
        stock,
        isCustomizable: payload.isCustomizable ?? false,
        metadata: payload.metadata,
        status: stock > 0 ? 'ACTIVE' : 'OUT_OF_STOCK',
        publicationStatus: payload.publicationStatus || 'DRAFT'
      }
    });

    response.status(201).json({ data: product });
  })
);

organizerRoutes.get(
  '/organizer/products',
  asyncHandler(async (request, response) => {
    const { page, limit } = parsePagination(request.query);
    const search = parseSearch(request.query.search);
    const isAdmin = request.user!.roles.includes('admin');

    const where: Record<string, unknown> = {
      store: buildManagedStoreFilter(request.user!.id, isAdmin)
    };

    if (search) {
      where.OR = [{ name: { contains: search, mode: 'insensitive' } }];
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
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
          category: true,
          media: {
            orderBy: { sortOrder: 'asc' },
            take: 1
          }
        }
      }),
      prisma.product.count({ where })
    ]);

    response.status(200).json({
      data: products,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit))
      }
    });
  })
);

organizerRoutes.get(
  '/organizer/products/:id',
  asyncHandler(async (request, response) => {
    const product = await prisma.product.findUnique({
      where: {
        id: request.params.id
      },
      include: {
        store: {
          select: {
            id: true,
            name: true,
            slug: true,
            ownerUserId: true
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

    await assertStoreManagementAccess(product.storeId, request.user!.id);

    response.status(200).json({ data: product });
  })
);

organizerRoutes.patch(
  '/organizer/products/:id',
  asyncHandler(async (request, response) => {
    const parsed = updateProductSchema.safeParse(request.body || {});

    if (!parsed.success) {
      throw new ValidationError('Invalid organizer product update payload', parsed.error.flatten());
    }

    const existing = await prisma.product.findUnique({
      where: {
        id: request.params.id
      },
      select: {
        id: true,
        storeId: true,
        slug: true
      }
    });

    if (!existing) {
      throw new NotFoundError('Product not found');
    }

    await assertStoreManagementAccess(existing.storeId, request.user!.id);

    const updates = parsed.data;

    if (updates.oldPrice && updates.price && updates.oldPrice <= updates.price) {
      throw new ValidationError('oldPrice must be greater than price');
    }

    let nextSlug: string | undefined;

    if (updates.slug) {
      nextSlug = slugify(updates.slug);

      if (!nextSlug) {
        throw new ValidationError('Product slug is invalid');
      }

      const duplicate = await prisma.product.findFirst({
        where: {
          storeId: existing.storeId,
          slug: nextSlug,
          id: {
            not: existing.id
          }
        },
        select: {
          id: true
        }
      });

      if (duplicate) {
        throw new ValidationError('Product slug already exists for this store');
      }
    }

    const stock = typeof updates.stock === 'number' ? updates.stock : undefined;

    const product = await prisma.product.update({
      where: {
        id: existing.id
      },
      data: {
        categoryId: updates.categoryId,
        eventId: updates.eventId,
        name: updates.name,
        slug: nextSlug,
        description: updates.description,
        productType: updates.productType,
        currency: updates.currency,
        price: updates.price,
        oldPrice: updates.oldPrice,
        stock: updates.stock,
        isCustomizable: updates.isCustomizable,
        metadata: updates.metadata,
        publicationStatus: updates.publicationStatus,
        status:
          typeof stock === 'number'
            ? stock > 0
              ? 'ACTIVE'
              : 'OUT_OF_STOCK'
            : undefined
      }
    });

    response.status(200).json({ data: product });
  })
);

organizerRoutes.delete(
  '/organizer/products/:id',
  asyncHandler(async (request, response) => {
    const existing = await prisma.product.findUnique({
      where: { id: request.params.id },
      select: {
        id: true,
        storeId: true
      }
    });

    if (!existing) {
      throw new NotFoundError('Product not found');
    }

    await assertStoreManagementAccess(existing.storeId, request.user!.id);

    const product = await prisma.product.update({
      where: { id: existing.id },
      data: {
        status: 'DISCONTINUED',
        publicationStatus: 'ARCHIVED'
      }
    });

    response.status(200).json({
      message: 'Product archived successfully',
      data: product
    });
  })
);

// Jerseys (mapped on Product with productType = JERSEY)
organizerRoutes.post(
  '/organizer/jerseys',
  asyncHandler(async (request, response) => {
    const parsed = createJerseySchema.safeParse(request.body || {});

    if (!parsed.success) {
      throw new ValidationError('Invalid organizer jersey payload', parsed.error.flatten());
    }

    const payload = parsed.data;
    const store = await assertStoreManagementAccess(payload.storeId, request.user!.id);

    const requestedSlug = payload.slug ? slugify(payload.slug) : '';

    if (payload.slug && !requestedSlug) {
      throw new ValidationError('Jersey slug is invalid');
    }

    const slug = requestedSlug || (await resolveUniqueProductSlug(store.id, payload.name));

    if (requestedSlug) {
      const duplicate = await prisma.product.findFirst({
        where: {
          storeId: store.id,
          slug: requestedSlug
        },
        select: { id: true }
      });

      if (duplicate) {
        throw new ValidationError('Jersey slug already exists for this store');
      }
    }

    if (payload.oldPrice && payload.oldPrice <= payload.price) {
      throw new ValidationError('oldPrice must be greater than price');
    }

    const stock = payload.stock ?? 0;

    const jersey = await prisma.product.create({
      data: {
        storeId: payload.storeId,
        categoryId: payload.categoryId,
        createdByUserId: request.user!.id,
        name: payload.name,
        slug,
        description: payload.description,
        productType: 'JERSEY',
        currency: payload.currency || 'XOF',
        price: payload.price,
        oldPrice: payload.oldPrice,
        stock,
        isCustomizable: payload.isCustomizable ?? false,
        metadata: payload.metadata,
        status: stock > 0 ? 'ACTIVE' : 'OUT_OF_STOCK',
        publicationStatus: payload.publicationStatus || 'DRAFT'
      }
    });

    response.status(201).json({ data: jersey });
  })
);

organizerRoutes.get(
  '/organizer/jerseys',
  asyncHandler(async (request, response) => {
    const { page, limit } = parsePagination(request.query);
    const search = parseSearch(request.query.search);
    const isAdmin = request.user!.roles.includes('admin');

    const where: Record<string, unknown> = {
      productType: 'JERSEY',
      store: buildManagedStoreFilter(request.user!.id, isAdmin)
    };

    if (search) {
      where.OR = [{ name: { contains: search, mode: 'insensitive' } }];
    }

    const [jerseys, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
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
          category: true,
          media: {
            orderBy: { sortOrder: 'asc' },
            take: 1
          }
        }
      }),
      prisma.product.count({ where })
    ]);

    response.status(200).json({
      data: jerseys,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit))
      }
    });
  })
);

organizerRoutes.get(
  '/organizer/jerseys/:id',
  asyncHandler(async (request, response) => {
    const jersey = await prisma.product.findFirst({
      where: {
        id: request.params.id,
        productType: 'JERSEY'
      },
      include: {
        store: {
          select: {
            id: true,
            name: true,
            slug: true,
            ownerUserId: true
          }
        },
        category: true,
        media: {
          orderBy: { sortOrder: 'asc' }
        },
        variants: true
      }
    });

    if (!jersey) {
      throw new NotFoundError('Jersey not found');
    }

    await assertStoreManagementAccess(jersey.storeId, request.user!.id);

    response.status(200).json({ data: jersey });
  })
);

organizerRoutes.patch(
  '/organizer/jerseys/:id',
  asyncHandler(async (request, response) => {
    const parsed = updateJerseySchema.safeParse(request.body || {});

    if (!parsed.success) {
      throw new ValidationError('Invalid organizer jersey update payload', parsed.error.flatten());
    }

    const existing = await prisma.product.findFirst({
      where: {
        id: request.params.id,
        productType: 'JERSEY'
      },
      select: {
        id: true,
        storeId: true,
        slug: true
      }
    });

    if (!existing) {
      throw new NotFoundError('Jersey not found');
    }

    await assertStoreManagementAccess(existing.storeId, request.user!.id);

    const updates = parsed.data;

    if (updates.oldPrice && updates.price && updates.oldPrice <= updates.price) {
      throw new ValidationError('oldPrice must be greater than price');
    }

    let nextSlug: string | undefined;

    if (updates.slug) {
      nextSlug = slugify(updates.slug);

      if (!nextSlug) {
        throw new ValidationError('Jersey slug is invalid');
      }

      const duplicate = await prisma.product.findFirst({
        where: {
          storeId: existing.storeId,
          slug: nextSlug,
          id: {
            not: existing.id
          }
        },
        select: {
          id: true
        }
      });

      if (duplicate) {
        throw new ValidationError('Jersey slug already exists for this store');
      }
    }

    const stock = typeof updates.stock === 'number' ? updates.stock : undefined;

    const jersey = await prisma.product.update({
      where: { id: existing.id },
      data: {
        categoryId: updates.categoryId,
        name: updates.name,
        slug: nextSlug,
        description: updates.description,
        productType: 'JERSEY',
        currency: updates.currency,
        price: updates.price,
        oldPrice: updates.oldPrice,
        stock: updates.stock,
        isCustomizable: updates.isCustomizable,
        metadata: updates.metadata,
        publicationStatus: updates.publicationStatus,
        status:
          typeof stock === 'number'
            ? stock > 0
              ? 'ACTIVE'
              : 'OUT_OF_STOCK'
            : undefined
      }
    });

    response.status(200).json({ data: jersey });
  })
);

organizerRoutes.delete(
  '/organizer/jerseys/:id',
  asyncHandler(async (request, response) => {
    const existing = await prisma.product.findFirst({
      where: {
        id: request.params.id,
        productType: 'JERSEY'
      },
      select: {
        id: true,
        storeId: true
      }
    });

    if (!existing) {
      throw new NotFoundError('Jersey not found');
    }

    await assertStoreManagementAccess(existing.storeId, request.user!.id);

    const jersey = await prisma.product.update({
      where: { id: existing.id },
      data: {
        status: 'DISCONTINUED',
        publicationStatus: 'ARCHIVED'
      }
    });

    response.status(200).json({
      message: 'Jersey archived successfully',
      data: jersey
    });
  })
);

import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../core/middleware/auth.middleware';
import { roleMiddleware } from '../core/middleware/role.middleware';
import { asyncHandler } from '../core/middleware/async.middleware';
import { prisma } from '../libs/prisma';
import { ValidationError } from '../core/errors/ValidationError';
import { NotFoundError } from '../core/errors/NotFoundError';
import { assertOrganizationManagementAccess } from '../core/utils/storeAccess';

export const contestRoutes = Router();

const createContestSchema = z.object({
	organizationId: z.string().min(1),
	slug: z.string().min(2).optional(),
	title: z.string().min(2),
	subtitle: z.string().max(300).optional(),
	description: z.string().max(5000).optional(),
	category: z.string().min(2),
	bannerImageUrl: z.string().url().optional(),
	votePrice: z.number().positive(),
	currency: z.string().min(3).max(3).optional(),
	startAt: z.coerce.date().optional(),
	endAt: z.coerce.date().optional(),
	votesStart: z.coerce.date().optional(),
	votesEnd: z.coerce.date().optional(),
	maxVotesPerAccount: z.number().int().positive().optional()
});

const updateContestSchema = createContestSchema
	.omit({ organizationId: true })
	.extend({
		status: z.enum(['UPCOMING', 'VOTING_OPEN', 'CLOSED', 'ARCHIVED']).optional(),
		publicationStatus: z
			.enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED'])
			.optional()
	})
	.partial();

const createCandidateSchema = z.object({
	name: z.string().min(2),
	slug: z.string().min(2).optional(),
	slogan: z.string().max(400).optional(),
	biography: z.string().max(5000).optional(),
	imageUrl: z.string().url().optional(),
	socialLinks: z.record(z.any()).optional(),
	publicationStatus: z
		.enum(['DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ARCHIVED', 'REJECTED'])
		.optional()
});

const voteSchema = z.object({
	candidateId: z.string().min(1),
	quantity: z.number().int().min(1).max(100)
});

function slugify(value: string): string {
	return value
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-');
}

contestRoutes.get(
	'/contests',
	asyncHandler(async (request, response) => {
		const page = Math.max(1, Number(request.query.page) || 1);
		const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 20));
		const search = typeof request.query.search === 'string' ? request.query.search.trim() : undefined;

		const where: Record<string, unknown> = {
			publicationStatus: 'PUBLISHED',
			status: {
				in: ['UPCOMING', 'VOTING_OPEN', 'CLOSED']
			}
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
				orderBy: { createdAt: 'desc' },
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

contestRoutes.get(
	'/contests/:slug',
	asyncHandler(async (request, response) => {
		const contest = await prisma.contest.findFirst({
			where: {
				slug: request.params.slug,
				publicationStatus: 'PUBLISHED',
				status: {
					in: ['UPCOMING', 'VOTING_OPEN', 'CLOSED']
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
				candidates: {
					where: {
						publicationStatus: 'PUBLISHED'
					},
					orderBy: { createdAt: 'asc' }
				}
			}
		});

		if (!contest) {
			throw new NotFoundError('Contest not found');
		}

		response.status(200).json(contest);
	})
);

contestRoutes.use('/contests', authMiddleware);

contestRoutes.post(
	'/contests',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const parsed = createContestSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid contest payload', parsed.error.flatten());
		}

		const payload = parsed.data;
		const organization = await assertOrganizationManagementAccess(payload.organizationId, request.user!.id);
		const isAdmin = request.user!.roles.includes('admin');

		if (!isAdmin && organization.type !== 'ORGANIZER') {
			throw new ValidationError('Contests can only be created under organizer organizations');
		}

		if (payload.votesStart && payload.votesEnd && payload.votesEnd <= payload.votesStart) {
			throw new ValidationError('Contest votesEnd must be after votesStart');
		}

		const slug = payload.slug || slugify(payload.title);
		const duplicate = await prisma.contest.findUnique({ where: { slug }, select: { id: true } });

		if (duplicate) {
			throw new ValidationError('Contest slug already exists');
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
				status: 'UPCOMING',
				publicationStatus: 'DRAFT',
				votePrice: payload.votePrice,
				currency: payload.currency || 'XOF',
				startAt: payload.startAt,
				endAt: payload.endAt,
				votesStart: payload.votesStart,
				votesEnd: payload.votesEnd,
				maxVotesPerAccount: payload.maxVotesPerAccount
			}
		});

		response.status(201).json(contest);
	})
);

contestRoutes.patch(
	'/contests/:id',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const parsed = updateContestSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid contest update payload', parsed.error.flatten());
		}

		const existing = await prisma.contest.findUnique({
			where: { id: request.params.id },
			select: {
				id: true,
				organizationId: true,
				slug: true
			}
		});

		if (!existing) {
			throw new NotFoundError('Contest not found');
		}

		const organization = await assertOrganizationManagementAccess(existing.organizationId, request.user!.id);
		const isAdmin = request.user!.roles.includes('admin');

		if (!isAdmin && organization.type !== 'ORGANIZER') {
			throw new ValidationError('Only organizer organizations can manage contests');
		}

		let nextSlug = parsed.data.slug;
		if (!nextSlug && parsed.data.title) {
			nextSlug = slugify(parsed.data.title);
		}

		if (nextSlug) {
			const duplicate = await prisma.contest.findFirst({
				where: {
					slug: nextSlug,
					id: { not: existing.id }
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

		response.status(200).json(contest);
	})
);

contestRoutes.post(
	'/contests/:id/candidates',
	roleMiddleware(['organizer', 'admin']),
	asyncHandler(async (request, response) => {
		const parsed = createCandidateSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid contest candidate payload', parsed.error.flatten());
		}

		const contest = await prisma.contest.findUnique({
			where: { id: request.params.id },
			select: {
				id: true,
				organizationId: true
			}
		});

		if (!contest) {
			throw new NotFoundError('Contest not found');
		}

		const organization = await assertOrganizationManagementAccess(contest.organizationId, request.user!.id);
		const isAdmin = request.user!.roles.includes('admin');

		if (!isAdmin && organization.type !== 'ORGANIZER') {
			throw new ValidationError('Only organizer organizations can manage candidates');
		}

		const payload = parsed.data;
		const slug = payload.slug || slugify(payload.name);

		const duplicate = await prisma.contestCandidate.findUnique({
			where: {
				contestId_slug: {
					contestId: contest.id,
					slug
				}
			},
			select: { id: true }
		});

		if (duplicate) {
			throw new ValidationError('Candidate slug already exists for this contest');
		}

		const candidate = await prisma.contestCandidate.create({
			data: {
				contestId: contest.id,
				slug,
				name: payload.name,
				slogan: payload.slogan,
				biography: payload.biography,
				imageUrl: payload.imageUrl,
				socialLinks: payload.socialLinks,
				publicationStatus: payload.publicationStatus || 'DRAFT'
			}
		});

		response.status(201).json(candidate);
	})
);

contestRoutes.post(
	'/contests/:id/votes',
	asyncHandler(async (request, response) => {
		const parsed = voteSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid vote payload', parsed.error.flatten());
		}

		const contest = await prisma.contest.findUnique({
			where: { id: request.params.id },
			select: {
				id: true,
				status: true,
				publicationStatus: true,
				votePrice: true,
				currency: true,
				maxVotesPerAccount: true
			}
		});

		if (!contest) {
			throw new NotFoundError('Contest not found');
		}

		if (contest.publicationStatus !== 'PUBLISHED' || contest.status !== 'VOTING_OPEN') {
			throw new ValidationError('Voting is currently closed for this contest');
		}

		const candidate = await prisma.contestCandidate.findFirst({
			where: {
				id: parsed.data.candidateId,
				contestId: contest.id,
				publicationStatus: 'PUBLISHED'
			},
			select: { id: true }
		});

		if (!candidate) {
			throw new ValidationError('Contest candidate is invalid');
		}

		if (contest.maxVotesPerAccount) {
			const aggregate = await prisma.contestVote.aggregate({
				where: {
					contestId: contest.id,
					userId: request.user!.id,
					status: {
						in: ['PAID', 'PENDING']
					}
				},
				_sum: {
					quantity: true
				}
			});

			const alreadyUsed = Number(aggregate._sum.quantity || 0);

			if (alreadyUsed + parsed.data.quantity > contest.maxVotesPerAccount) {
				throw new ValidationError('Max votes per account reached for this contest');
			}
		}

		const amount = Number(contest.votePrice) * parsed.data.quantity;

		const vote = await prisma.contestVote.create({
			data: {
				contestId: contest.id,
				candidateId: candidate.id,
				userId: request.user!.id,
				quantity: parsed.data.quantity,
				amount,
				currency: contest.currency,
				status: 'PAID'
			}
		});

		response.status(201).json(vote);
	})
);

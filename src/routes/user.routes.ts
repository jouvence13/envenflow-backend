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

		response.status(200).json({
			id: user.id,
			email: user.email,
			phone: user.phone,
			status: user.status,
			profile: user.profile,
			roles: user.roles.map((entry: { role: { code: string } }) => entry.role.code)
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

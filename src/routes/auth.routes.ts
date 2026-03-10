import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../libs/prisma';
import { asyncHandler } from '../core/middleware/async.middleware';
import { ValidationError } from '../core/errors/ValidationError';
import { UnauthorizedError } from '../core/errors/UnauthorizedError';
import { hashPassword, verifyPassword } from '../core/utils/password';
import {
	createAccessToken,
	createRefreshToken,
	generateToken,
	hashToken
} from '../core/utils/tokens';
import { authMiddleware } from '../core/middleware/auth.middleware';

export const authRoutes = Router();

const registerSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8),
	firstName: z.string().min(1),
	lastName: z.string().min(1),
	phone: z.string().min(6).optional()
});

const loginSchema = z.object({
	email: z.string().email(),
	password: z.string().min(1)
});

const refreshSchema = z.object({
	refreshToken: z.string().min(1)
});

const forgotPasswordSchema = z.object({
	email: z.string().email()
});

const resetPasswordSchema = z.object({
	token: z.string().min(1),
	password: z.string().min(8)
});

const passwordResetTokens = new Map<string, { userId: string; expiresAt: Date }>();

async function getUserRoles(userId: string): Promise<string[]> {
	const records = await prisma.userRole.findMany({
		where: { userId },
		include: { role: true }
	});

	return records.map((record: { role: { code: string } }) => record.role.code);
}

async function issueAuthTokens(userId: string): Promise<{ accessToken: string; refreshToken: string }> {
	const roles = await getUserRoles(userId);
	const accessToken = createAccessToken({ sub: userId, roles });
	const refreshToken = createRefreshToken();

	await prisma.userSession.create({
		data: {
			userId,
			refreshTokenHash: hashToken(refreshToken),
			expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
		}
	});

	return { accessToken, refreshToken };
}

authRoutes.post(
	'/auth/register',
	asyncHandler(async (request, response) => {
		const parsed = registerSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid registration payload', parsed.error.flatten());
		}

		const payload = parsed.data;
		const existing = await prisma.user.findUnique({ where: { email: payload.email } });

		if (existing) {
			throw new ValidationError('Email already registered');
		}

		const passwordHash = await hashPassword(payload.password);

		const userRole = await prisma.role.upsert({
			where: { code: 'user' },
			update: { name: 'User' },
			create: { code: 'user', name: 'User' }
		});

		const user = await prisma.user.create({
			data: {
				email: payload.email,
				phone: payload.phone,
				passwordHash,
				status: 'ACTIVE',
				profile: {
					create: {
						firstName: payload.firstName,
						lastName: payload.lastName,
						language: 'fr',
						theme: 'dark'
					}
				},
				roles: {
					create: {
						roleId: userRole.id
					}
				}
			}
		});

		const tokens = await issueAuthTokens(user.id);

		response.status(201).json({
			user: {
				id: user.id,
				email: user.email,
				phone: user.phone
			},
			...tokens
		});
	})
);

authRoutes.post(
	'/auth/login',
	asyncHandler(async (request, response) => {
		const parsed = loginSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid login payload', parsed.error.flatten());
		}

		const payload = parsed.data;
		const user = await prisma.user.findUnique({
			where: { email: payload.email },
			include: {
				profile: true
			}
		});

		if (!user) {
			throw new UnauthorizedError('Invalid credentials');
		}

		const passwordValid = await verifyPassword(payload.password, user.passwordHash);

		if (!passwordValid) {
			throw new UnauthorizedError('Invalid credentials');
		}

		if (user.status !== 'ACTIVE') {
			throw new UnauthorizedError('Account is not active');
		}

		await prisma.user.update({
			where: { id: user.id },
			data: { lastLoginAt: new Date() }
		});

		const tokens = await issueAuthTokens(user.id);

		response.status(200).json({
			user: {
				id: user.id,
				email: user.email,
				phone: user.phone,
				profile: user.profile
			},
			...tokens
		});
	})
);

authRoutes.post(
	'/auth/refresh',
	asyncHandler(async (request, response) => {
		const parsed = refreshSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid refresh payload', parsed.error.flatten());
		}

		const { refreshToken } = parsed.data;
		const session = await prisma.userSession.findUnique({
			where: { refreshTokenHash: hashToken(refreshToken) }
		});

		if (!session || session.revokedAt || session.expiresAt < new Date()) {
			throw new UnauthorizedError('Invalid refresh token');
		}

		const roles = await getUserRoles(session.userId);
		const accessToken = createAccessToken({ sub: session.userId, roles });
		const nextRefreshToken = createRefreshToken();

		await prisma.userSession.update({
			where: { id: session.id },
			data: {
				refreshTokenHash: hashToken(nextRefreshToken),
				expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
			}
		});

		response.status(200).json({
			accessToken,
			refreshToken: nextRefreshToken
		});
	})
);

authRoutes.post(
	'/auth/logout',
	authMiddleware,
	asyncHandler(async (request, response) => {
		const refreshToken = typeof request.body?.refreshToken === 'string' ? request.body.refreshToken : null;

		if (refreshToken) {
			await prisma.userSession.updateMany({
				where: {
					userId: request.user!.id,
					refreshTokenHash: hashToken(refreshToken),
					revokedAt: null
				},
				data: {
					revokedAt: new Date()
				}
			});
		} else {
			await prisma.userSession.updateMany({
				where: {
					userId: request.user!.id,
					revokedAt: null
				},
				data: {
					revokedAt: new Date()
				}
			});
		}

		response.status(200).json({ message: 'Logged out' });
	})
);

authRoutes.post(
	'/auth/forgot-password',
	asyncHandler(async (request, response) => {
		const parsed = forgotPasswordSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid forgot-password payload', parsed.error.flatten());
		}

		const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });

		if (user) {
			const resetToken = generateToken(32);
			passwordResetTokens.set(resetToken, {
				userId: user.id,
				expiresAt: new Date(Date.now() + 15 * 60 * 1000)
			});

			response.status(200).json({
				message: 'Password reset instructions sent if account exists',
				resetToken
			});
			return;
		}

		response.status(200).json({
			message: 'Password reset instructions sent if account exists'
		});
	})
);

authRoutes.post(
	'/auth/reset-password',
	asyncHandler(async (request, response) => {
		const parsed = resetPasswordSchema.safeParse(request.body);

		if (!parsed.success) {
			throw new ValidationError('Invalid reset-password payload', parsed.error.flatten());
		}

		const tokenData = passwordResetTokens.get(parsed.data.token);

		if (!tokenData || tokenData.expiresAt < new Date()) {
			throw new ValidationError('Reset token is invalid or expired');
		}

		const nextHash = await hashPassword(parsed.data.password);

		await prisma.user.update({
			where: { id: tokenData.userId },
			data: { passwordHash: nextHash }
		});

		await prisma.userSession.updateMany({
			where: { userId: tokenData.userId, revokedAt: null },
			data: { revokedAt: new Date() }
		});

		passwordResetTokens.delete(parsed.data.token);

		response.status(200).json({ message: 'Password reset successful' });
	})
);

import { createHash, createHmac, randomBytes } from 'crypto';
import { env } from '../../config/env';

export type AccessTokenPayload = {
  sub: string;
  roles: string[];
  exp: number;
};

function toBase64Url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url<T>(value: string): T | null {
  try {
    const parsed = Buffer.from(value, 'base64url').toString('utf8');
    return JSON.parse(parsed) as T;
  } catch {
    return null;
  }
}

function sign(payloadPart: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadPart).digest('base64url');
}

export function generateToken(size = 32): string {
  return randomBytes(size).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createRefreshToken(): string {
  return generateToken(48);
}

export function createAccessToken(payload: Omit<AccessTokenPayload, 'exp'>, ttlSeconds = 15 * 60): string {
  const tokenPayload: AccessTokenPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  };

  const payloadPart = toBase64Url(JSON.stringify(tokenPayload));
  const signature = sign(payloadPart, env.JWT_ACCESS_SECRET);
  return `${payloadPart}.${signature}`;
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  const [payloadPart, signature] = token.split('.');

  if (!payloadPart || !signature) {
    return null;
  }

  const expectedSignature = sign(payloadPart, env.JWT_ACCESS_SECRET);

  if (expectedSignature !== signature) {
    return null;
  }

  const payload = fromBase64Url<AccessTokenPayload>(payloadPart);

  if (!payload) {
    return null;
  }

  if (!payload.sub || !Array.isArray(payload.roles) || !payload.exp) {
    return null;
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

import { randomBytes } from 'crypto';

export function generateQrPayload(prefix = 'ENV'): { code: string; secret: string } {
  const secret = randomBytes(16).toString('hex');
  const code = `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  return { code, secret };
}

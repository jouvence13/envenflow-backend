import { randomBytes, randomUUID } from 'crypto';

export const PURCHASABLE_EVENT_STATUSES = ['SCHEDULED', 'ONGOING'] as const;

type BuildTicketQrCodeInput = {
  timestamp?: number;
  uuid?: string;
};

export function buildTicketQrCode(input: BuildTicketQrCodeInput = {}): string {
  const timestamp = Number.isFinite(input.timestamp) ? Number(input.timestamp) : Date.now();
  const uuidSegment = (input.uuid || randomUUID()).replace(/-/g, '').toUpperCase();

  return `EVT-${timestamp.toString(36).toUpperCase()}-${uuidSegment}`;
}

export function buildTicketQrSecret(secretBytes?: Buffer): string {
  const bytes = secretBytes || randomBytes(24);
  return bytes.toString('hex');
}

export function isTicketSaleWindowOpen(
  salesStart?: Date | null,
  salesEnd?: Date | null,
  now: Date = new Date()
): boolean {
  if (salesStart && salesStart > now) {
    return false;
  }

  if (salesEnd && salesEnd < now) {
    return false;
  }

  return true;
}

export function resolveBeneficiaryName(input: {
  beneficiaryName?: string;
  profileFirstName?: string | null;
  profileLastName?: string | null;
  email?: string | null;
}): string {
  const explicitName = String(input.beneficiaryName || '').trim();

  if (explicitName) {
    return explicitName;
  }

  const profileName = `${input.profileFirstName || ''} ${input.profileLastName || ''}`.trim();

  if (profileName) {
    return profileName;
  }

  const email = String(input.email || '').trim();

  if (email) {
    return email;
  }

  return 'Participant';
}

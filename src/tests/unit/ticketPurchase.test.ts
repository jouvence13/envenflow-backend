import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTicketQrCode,
  buildTicketQrSecret,
  isTicketSaleWindowOpen,
  resolveBeneficiaryName
} from '../../modules/events/ticketPurchase';

test('buildTicketQrCode creates deterministic QR code when timestamp and uuid are provided', () => {
  const qrCode = buildTicketQrCode({ timestamp: 1710000000000, uuid: 'abcd-1234' });

  assert.equal(qrCode, 'EVT-LTK9UKG0-ABCD1234');
});

test('buildTicketQrSecret returns an hex string', () => {
  const qrSecret = buildTicketQrSecret(Buffer.from('00112233445566778899aabbccddeeff', 'hex'));

  assert.equal(qrSecret, '00112233445566778899aabbccddeeff');
});

test('isTicketSaleWindowOpen validates sales windows correctly', () => {
  const now = new Date('2026-03-16T12:00:00.000Z');

  assert.equal(isTicketSaleWindowOpen(new Date('2026-03-16T10:00:00.000Z'), new Date('2026-03-16T14:00:00.000Z'), now), true);
  assert.equal(isTicketSaleWindowOpen(new Date('2026-03-16T13:00:00.000Z'), new Date('2026-03-16T14:00:00.000Z'), now), false);
  assert.equal(isTicketSaleWindowOpen(new Date('2026-03-16T10:00:00.000Z'), new Date('2026-03-16T11:59:59.000Z'), now), false);
});

test('resolveBeneficiaryName prioritizes explicit value then profile then email', () => {
  assert.equal(
    resolveBeneficiaryName({
      beneficiaryName: 'Invite Premium',
      profileFirstName: 'Awa',
      profileLastName: 'Kouassi',
      email: 'awa@example.com'
    }),
    'Invite Premium'
  );

  assert.equal(
    resolveBeneficiaryName({
      profileFirstName: 'Awa',
      profileLastName: 'Kouassi',
      email: 'awa@example.com'
    }),
    'Awa Kouassi'
  );

  assert.equal(resolveBeneficiaryName({ email: 'awa@example.com' }), 'awa@example.com');
  assert.equal(resolveBeneficiaryName({}), 'Participant');
});

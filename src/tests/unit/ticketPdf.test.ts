import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTicketPdfBuffer,
  buildTicketPdfFilename,
  buildTicketQrPng,
  mapTicketToPdfPayload
} from '../../modules/events/ticketPdf';

const TICKET_SOURCE = {
  id: 'tkt_001',
  qrCode: 'EVT-TEST-QR-001',
  beneficiaryName: 'Alice Johnson',
  beneficiaryEmail: 'alice@example.com',
  status: 'ISSUED',
  issuedAt: new Date('2026-03-17T09:00:00.000Z'),
  event: {
    title: 'Festival EvenFlow',
    startAt: new Date('2026-06-01T18:00:00.000Z'),
    location: 'Palais des Congres - Cotonou'
  },
  eventTicketType: {
    name: 'VIP',
    description: 'Acces prioritaire et zone reservee',
    price: '1500',
    currency: 'XOF'
  }
};

test('mapTicketToPdfPayload keeps the ticket qrCode value', () => {
  const payload = mapTicketToPdfPayload(TICKET_SOURCE);

  assert.match(payload.displayReference, /^VIP-2026-\d{4}$/);
  assert.match(payload.bookingNumber, /^\d{4}$/);
  assert.equal(payload.qrCode, TICKET_SOURCE.qrCode);
  assert.match(payload.ticketInformation, /Tarif:/);
  assert.match(payload.ticketInformation, /Beneficiaire:/);
});

test('buildTicketPdfFilename sanitizes event title for safe download names', () => {
  const filename = buildTicketPdfFilename('Festival Premium 2026! #Abomey', 'VIP-2026-0042');

  assert.equal(filename, 'billet-festival-premium-2026-abomey-vip-2026-0042.pdf');
});

test('buildTicketQrPng generates a PNG image buffer', async () => {
  const pngBuffer = await buildTicketQrPng('EVT-TEST-QR-001');

  assert.equal(pngBuffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(pngBuffer.byteLength > 100);
});

test('buildTicketPdfBuffer uses the ticket qrCode to build the QR block', async () => {
  const payload = mapTicketToPdfPayload(TICKET_SOURCE);
  let receivedQrCode = '';

  const pdfBuffer = await buildTicketPdfBuffer(payload, {
    generatedAt: new Date('2026-03-17T10:30:00.000Z'),
    qrImageBuilder: async (qrCode) => {
      receivedQrCode = qrCode;
      return buildTicketQrPng(qrCode);
    }
  });

  assert.equal(receivedQrCode, TICKET_SOURCE.qrCode);
  assert.equal(pdfBuffer.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdfBuffer.byteLength > 1000);
});

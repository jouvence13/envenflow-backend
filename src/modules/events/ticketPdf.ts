import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

type QrImageBuilder = (qrCode: string) => Promise<Buffer>;

export type TicketPdfPayload = {
  displayReference: string;
  bookingNumber: string;
  eventName: string;
  eventStartAt: Date;
  eventLocation: string;
  ticketTypeName: string;
  ticketInformation: string;
  beneficiaryName: string;
  beneficiaryEmail: string;
  ticketStatus: string;
  issuedAt: Date;
  qrCode: string;
};

export type TicketPdfDataSource = {
  id: string;
  qrCode: string;
  beneficiaryName: string;
  beneficiaryEmail: string;
  status: string;
  issuedAt: Date;
  event: {
    title: string;
    startAt: Date;
    location: string;
  };
  eventTicketType: {
    name: string;
    description?: string | null;
    price?: number | string | { toString(): string };
    currency?: string | null;
  };
};

type BuildTicketPdfOptions = {
  qrImageBuilder?: QrImageBuilder;
  generatedAt?: Date;
};

function hashText(value: string): number {
  let hash = 5381;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }

  return Math.abs(hash >>> 0);
}

function normalizeTicketTypePrefix(value: string): string {
  const normalized = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();

  return (normalized.slice(0, 3) || 'TKT').padEnd(3, 'X');
}

function buildReadableBookingNumber(ticketId: string, issuedAt: Date): string {
  const seed = hashText(`${ticketId}|${issuedAt.toISOString()}`);
  return String((seed % 9000) + 1000).padStart(4, '0');
}

function buildReadableTicketReference(ticketTypeName: string, issuedAt: Date, ticketId: string): string {
  const prefix = normalizeTicketTypePrefix(ticketTypeName);
  const year = issuedAt.getFullYear();
  const bookingNumber = buildReadableBookingNumber(ticketId, issuedAt);

  return `${prefix}-${year}-${bookingNumber}`;
}

function formatFrenchDate(value: Date | null | undefined): string {
  if (!value) {
    return 'Date non renseignee';
  }

  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(value);
}

function formatMoney(value: number, currency = 'XOF'): string {
  return `${new Intl.NumberFormat('fr-FR').format(value)} ${currency}`;
}

function formatTicketStatus(status: string): string {
  const normalizedStatus = String(status || '').toUpperCase();

  if (normalizedStatus === 'ISSUED') {
    return 'Valide';
  }

  if (normalizedStatus === 'USED') {
    return 'Utilise';
  }

  if (normalizedStatus === 'CANCELLED') {
    return 'Annule';
  }

  if (normalizedStatus === 'REFUNDED') {
    return 'Rembourse';
  }

  if (normalizedStatus === 'EXPIRED') {
    return 'Expire';
  }

  return normalizedStatus || 'Inconnu';
}

function drawField(
  doc: PDFKit.PDFDocument,
  input: { label: string; value: string; x: number; y: number; width: number }
): number {
  doc
    .fillColor('#475569')
    .font('Helvetica-Bold')
    .fontSize(9)
    .text(input.label.toUpperCase(), input.x, input.y, {
      width: input.width
    });

  const valueY = input.y + 12;

  doc
    .fillColor('#0F172A')
    .font('Helvetica')
    .fontSize(11)
    .text(input.value, input.x, valueY, {
      width: input.width,
      lineGap: 2
    });

  const valueHeight = doc.heightOfString(input.value, {
    width: input.width,
    lineGap: 2
  });

  return valueY + valueHeight + 16;
}

export async function buildTicketQrPng(qrCode: string): Promise<Buffer> {
  return QRCode.toBuffer(qrCode, {
    type: 'png',
    width: 320,
    margin: 1,
    errorCorrectionLevel: 'H'
  });
}

export function mapTicketToPdfPayload(ticket: TicketPdfDataSource): TicketPdfPayload {
  const issuedAt = ticket.issuedAt instanceof Date ? ticket.issuedAt : new Date(ticket.issuedAt);
  const amount = Number(ticket.eventTicketType?.price || 0);
  const currency = (ticket.eventTicketType?.currency || 'XOF').toUpperCase();
  const hasAmount = Number.isFinite(amount) && amount >= 0;
  const bookingNumber = buildReadableBookingNumber(ticket.id, issuedAt);
  const displayReference = buildReadableTicketReference(ticket.eventTicketType.name, issuedAt, ticket.id);

  const informationLines = [
    ticket.eventTicketType?.description?.trim() || 'Billet nominatif',
    hasAmount ? `Tarif: ${formatMoney(amount, currency)}` : null,
    'Paiement: valide',
    `Beneficiaire: ${ticket.beneficiaryName}`,
    `Date d'achat: ${formatFrenchDate(issuedAt)}`
  ].filter(Boolean);

  return {
    displayReference,
    bookingNumber,
    eventName: ticket.event.title,
    eventStartAt: ticket.event.startAt,
    eventLocation: ticket.event.location,
    ticketTypeName: ticket.eventTicketType.name,
    ticketInformation: informationLines.join(' | '),
    beneficiaryName: ticket.beneficiaryName,
    beneficiaryEmail: ticket.beneficiaryEmail,
    ticketStatus: formatTicketStatus(ticket.status),
    issuedAt,
    qrCode: ticket.qrCode
  };
}

export function buildTicketPdfFilename(eventName: string, displayReference: string): string {
  const eventSlug = String(eventName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  const referenceSlug = String(displayReference || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);

  return `billet-${eventSlug || 'evenement'}-${referenceSlug || 'reference'}.pdf`;
}

export async function buildTicketPdfBuffer(
  payload: TicketPdfPayload,
  options: BuildTicketPdfOptions = {}
): Promise<Buffer> {
  const qrImageBuilder = options.qrImageBuilder || buildTicketQrPng;
  const generatedAt = options.generatedAt || new Date();
  const qrPngBuffer = await qrImageBuilder(payload.qrCode);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0
    });

    const chunks: Buffer[] = [];

    doc.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    doc.on('error', (error) => {
      reject(error);
    });

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const cardX = 32;
    const cardY = 32;
    const cardWidth = pageWidth - 64;
    const cardHeight = pageHeight - 64;

    doc.rect(0, 0, pageWidth, pageHeight).fill('#F1F5F9');

    doc
      .roundedRect(cardX, cardY, cardWidth, cardHeight, 18)
      .fillAndStroke('#FFFFFF', '#CBD5E1');

    doc
      .roundedRect(cardX, cardY, cardWidth, 122, 18)
      .fill('#0F172A');

    doc
      .fillColor('#93C5FD')
      .font('Helvetica-Bold')
      .fontSize(11)
      .text('BILLET EVENFLOW', cardX + 24, cardY + 20);

    doc
      .fillColor('#FFFFFF')
      .font('Helvetica-Bold')
      .fontSize(24)
      .text(payload.eventName, cardX + 24, cardY + 40, {
        width: cardWidth - 48,
        ellipsis: true
      });

    doc
      .fillColor('#E2E8F0')
      .font('Helvetica')
      .fontSize(11)
      .text(`${formatFrenchDate(payload.eventStartAt)} - ${payload.eventLocation}`, cardX + 24, cardY + 90, {
        width: cardWidth - 48,
        ellipsis: true
      });

    const bodyStartY = cardY + 150;
    const leftColumnX = cardX + 24;
    const rightColumnX = cardX + cardWidth - 210;
    const leftColumnWidth = rightColumnX - leftColumnX - 18;

    let currentY = bodyStartY;

    currentY = drawField(doc, {
      label: 'Type de billet',
      value: payload.ticketTypeName,
      x: leftColumnX,
      y: currentY,
      width: leftColumnWidth
    });

    currentY = drawField(doc, {
      label: 'Reference billet',
      value: payload.displayReference,
      x: leftColumnX,
      y: currentY,
      width: leftColumnWidth
    });

    currentY = drawField(doc, {
      label: 'Reservation',
      value: `No ${payload.bookingNumber}`,
      x: leftColumnX,
      y: currentY,
      width: leftColumnWidth
    });

    currentY = drawField(doc, {
      label: 'Informations billet',
      value: payload.ticketInformation,
      x: leftColumnX,
      y: currentY,
      width: leftColumnWidth
    });

    currentY = drawField(doc, {
      label: 'Beneficiaire',
      value: `${payload.beneficiaryName} (${payload.beneficiaryEmail})`,
      x: leftColumnX,
      y: currentY,
      width: leftColumnWidth
    });

    currentY = drawField(doc, {
      label: 'Statut',
      value: payload.ticketStatus,
      x: leftColumnX,
      y: currentY,
      width: leftColumnWidth
    });

    doc
      .roundedRect(rightColumnX - 10, bodyStartY - 10, 190, 260, 12)
      .fillAndStroke('#F8FAFC', '#CBD5E1');

    doc.image(qrPngBuffer, rightColumnX, bodyStartY, {
      fit: [170, 170],
      align: 'center',
      valign: 'center'
    });

    doc
      .fillColor('#0F172A')
      .font('Helvetica-Bold')
      .fontSize(10)
      .text('Presentez ce QR code a l entree', rightColumnX, bodyStartY + 180, {
        width: 170,
        align: 'center'
      });

    doc
      .fillColor('#475569')
      .font('Helvetica')
      .fontSize(9)
      .text(
        `Emis le ${formatFrenchDate(payload.issuedAt)} | Genere le ${formatFrenchDate(generatedAt)}`,
        cardX + 24,
        cardY + cardHeight - 56,
        {
          width: cardWidth - 48
        }
      );

    doc
      .fillColor('#64748B')
      .font('Helvetica')
      .fontSize(8)
      .text(
        'Presentez simplement ce billet a l entree. Aucun telechargement n est obligatoire.',
        cardX + 24,
        cardY + cardHeight - 40,
        {
          width: cardWidth - 48
        }
      );

    // Keep room coherent even with long multiline blocks on the left.
    if (currentY > cardY + cardHeight - 90) {
      doc
        .fillColor('#B91C1C')
        .font('Helvetica')
        .fontSize(8)
        .text('Attention: certaines informations ont ete tronquees pour tenir sur une page.', cardX + 24, cardY + cardHeight - 70, {
          width: leftColumnWidth
        });
    }

    doc.end();
  });
}

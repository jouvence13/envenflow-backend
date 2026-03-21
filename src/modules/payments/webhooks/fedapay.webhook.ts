import { Request } from 'express';
import { Webhook } from 'fedapay';
import { Prisma } from '@prisma/client';
import { AppError } from '../../../core/errors/AppError';
import { env } from '../../../config/env';
import { prisma } from '../../../libs/prisma';

type JsonRecord = Record<string, unknown>;
type PaymentStatusValue =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED';

type OrderStatusValue =
  | 'PENDING'
  | 'CONFIRMED'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'FULFILLED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'FAILED';

type FedapayWebhookResult = {
  received: true;
  processed: boolean;
  eventId: string | null;
  paymentStatus: PaymentStatusValue | null;
};

const paymentStatusRank: Record<PaymentStatusValue, number> = {
  PENDING: 10,
  AUTHORIZED: 20,
  SUCCEEDED: 30,
  FAILED: 30,
  CANCELLED: 30,
  EXPIRED: 30,
  PARTIALLY_REFUNDED: 40,
  REFUNDED: 50
};

const successLikePaymentStatuses = new Set<PaymentStatusValue>([
  'SUCCEEDED',
  'PARTIALLY_REFUNDED',
  'REFUNDED'
]);

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  return undefined;
}

function normalizeToken(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function getRawBody(request: Request): string {
  const requestWithRawBody = request as Request & { rawBody?: string };

  if (typeof requestWithRawBody.rawBody === 'string' && requestWithRawBody.rawBody.length > 0) {
    return requestWithRawBody.rawBody;
  }

  return JSON.stringify(request.body || {});
}

function getSignatureHeader(request: Request): string | undefined {
  const candidates = [
    request.headers['x-fedapay-signature'],
    request.headers['fedapay-signature'],
    request.headers['x-signature'],
    request.headers.signature
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const first = asString(candidate[0]);
      if (first) {
        return first;
      }
      continue;
    }

    const normalized = asString(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function deriveStatusFromEventType(eventType: string | undefined): string | undefined {
  const normalized = normalizeToken(eventType);

  if (!normalized || !normalized.includes('.')) {
    return undefined;
  }

  return normalized.split('.').pop();
}

function extractTransactionIdentifiers(payload: JsonRecord) {
  const entity = asRecord(payload.entity);
  const data = asRecord(payload.data);
  const transaction =
    asRecord(payload.transaction) || asRecord(entity?.transaction) || asRecord(data?.transaction);

  const paymentIds = uniqueStrings([
    asString(payload.object_id),
    asString(payload.objectId),
    asString(payload.transaction_id),
    asString(payload.transactionId),
    asString(entity?.object_id),
    asString(entity?.objectId),
    asString(entity?.id),
    asString(data?.object_id),
    asString(data?.objectId),
    asString(data?.id),
    asString(transaction?.id)
  ]);

  const references = uniqueStrings([
    asString(payload.reference),
    asString(payload.transaction_reference),
    asString(payload.transactionReference),
    asString(entity?.reference),
    asString(data?.reference),
    asString(transaction?.reference)
  ]);

  return {
    paymentIds,
    references
  };
}

function extractFedapayStatus(payload: JsonRecord, eventType: string | undefined): string | undefined {
  const entity = asRecord(payload.entity);
  const data = asRecord(payload.data);
  const transaction =
    asRecord(payload.transaction) || asRecord(entity?.transaction) || asRecord(data?.transaction);

  return (
    normalizeToken(asString(payload.status)) ||
    normalizeToken(asString(payload.transaction_status)) ||
    normalizeToken(asString(entity?.status)) ||
    normalizeToken(asString(data?.status)) ||
    normalizeToken(asString(transaction?.status)) ||
    deriveStatusFromEventType(eventType)
  );
}

function mapFedapayStatusToPaymentStatus(value: string | undefined): PaymentStatusValue | null {
  const normalized = normalizeToken(value);

  switch (normalized) {
    case 'pending':
    case 'created':
    case 'processing':
    case 'initiated':
      return 'PENDING';
    case 'authorized':
      return 'AUTHORIZED';
    case 'approved':
    case 'transferred':
    case 'paid':
    case 'successful':
    case 'succeeded':
      return 'SUCCEEDED';
    case 'failed':
    case 'declined':
    case 'rejected':
    case 'error':
      return 'FAILED';
    case 'cancelled':
    case 'canceled':
      return 'CANCELLED';
    case 'expired':
    case 'timeout':
      return 'EXPIRED';
    case 'partially_refunded':
    case 'approved_partially_refunded':
    case 'transferred_partially_refunded':
      return 'PARTIALLY_REFUNDED';
    case 'refunded':
      return 'REFUNDED';
    default:
      return null;
  }
}

function toAttemptStatus(status: PaymentStatusValue): 'INITIATED' | 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED' {
  if (status === 'FAILED') {
    return 'FAILED';
  }

  if (status === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (status === 'EXPIRED') {
    return 'TIMEOUT';
  }

  if (status === 'PENDING') {
    return 'INITIATED';
  }

  return 'SUCCEEDED';
}

function shouldApplyIncomingStatus(current: PaymentStatusValue, incoming: PaymentStatusValue): boolean {
  if (current === incoming) {
    return false;
  }

  // Allow recovery to success if provider notifies successful payment after a transient failure.
  if (current === 'FAILED' && incoming === 'SUCCEEDED') {
    return true;
  }

  return paymentStatusRank[incoming] >= paymentStatusRank[current];
}

function isPaidLikeOrderStatus(status: OrderStatusValue): boolean {
  return status === 'PAID' || status === 'FULFILLED' || status === 'REFUNDED';
}

function canPromoteOrderToPaid(status: OrderStatusValue): boolean {
  return status === 'PENDING' || status === 'CONFIRMED' || status === 'PARTIALLY_PAID' || status === 'FAILED';
}

function canPromoteOrderToPartiallyPaid(status: OrderStatusValue): boolean {
  return status === 'PENDING' || status === 'CONFIRMED' || status === 'FAILED';
}

function getNextGlobalOrderStatus(currentStatus: OrderStatusValue, storeOrderStatuses: OrderStatusValue[]): OrderStatusValue | null {
  if (storeOrderStatuses.length === 0) {
    return canPromoteOrderToPaid(currentStatus) ? 'PAID' : null;
  }

  const paidLikeCount = storeOrderStatuses.filter((status) => isPaidLikeOrderStatus(status)).length;

  if (paidLikeCount === storeOrderStatuses.length) {
    return canPromoteOrderToPaid(currentStatus) ? 'PAID' : null;
  }

  if (paidLikeCount > 0) {
    return canPromoteOrderToPartiallyPaid(currentStatus) ? 'PARTIALLY_PAID' : null;
  }

  return null;
}

async function syncOrderStatusesAfterSuccessfulPayment(input: {
  orderId?: string | null;
  storeOrderId?: string | null;
  eventType: string;
  eventId?: string | null;
}): Promise<void> {
  if (!input.orderId) {
    return;
  }

  const note = `Payment webhook (${input.eventType}${input.eventId ? `:${input.eventId}` : ''})`;

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (input.storeOrderId) {
      const storeOrder = await tx.storeOrder.findUnique({
        where: { id: input.storeOrderId },
        select: {
          id: true,
          orderId: true,
          status: true
        }
      });

      if (storeOrder) {
        const currentStoreStatus = storeOrder.status as OrderStatusValue;

        if (canPromoteOrderToPaid(currentStoreStatus)) {
          await tx.storeOrder.update({
            where: { id: storeOrder.id },
            data: { status: 'PAID' }
          });

          await tx.orderStatusHistory.create({
            data: {
              orderId: storeOrder.orderId,
              storeOrderId: storeOrder.id,
              fromStatus: currentStoreStatus,
              toStatus: 'PAID',
              note
            }
          });
        }
      }
    }

    const order = await tx.order.findUnique({
      where: { id: input.orderId! },
      select: {
        id: true,
        status: true,
        storeOrders: {
          select: {
            status: true
          }
        }
      }
    });

    if (!order) {
      return;
    }

    const currentOrderStatus = order.status as OrderStatusValue;
    const storeStatuses = order.storeOrders.map((item) => item.status as OrderStatusValue);
    const nextOrderStatus = getNextGlobalOrderStatus(currentOrderStatus, storeStatuses);

    if (!nextOrderStatus || nextOrderStatus === currentOrderStatus) {
      return;
    }

    await tx.order.update({
      where: { id: order.id },
      data: { status: nextOrderStatus }
    });

    await tx.orderStatusHistory.create({
      data: {
        orderId: order.id,
        fromStatus: currentOrderStatus,
        toStatus: nextOrderStatus,
        note
      }
    });
  });
}

function sanitizePayload(payload: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(payload)) as JsonRecord;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Unknown webhook processing error';
}

async function createOrRefreshWebhookEvent(input: {
  payload: JsonRecord;
  eventType: string;
  externalId?: string;
  signature: string;
}) {
  if (input.externalId) {
    const existing = await prisma.webhookEvent.findUnique({
      where: {
        provider_externalId: {
          provider: 'FEDAPAY',
          externalId: input.externalId
        }
      }
    });

    if (existing?.status === 'PROCESSED') {
      return {
        id: existing.id,
        alreadyProcessed: true
      };
    }

    if (existing) {
      const updated = await prisma.webhookEvent.update({
        where: { id: existing.id },
        data: {
          eventType: input.eventType,
          signature: input.signature,
          payload: input.payload,
          status: 'RECEIVED',
          processedAt: null,
          errorMessage: null
        }
      });

      return {
        id: updated.id,
        alreadyProcessed: false
      };
    }
  }

  const created = await prisma.webhookEvent.create({
    data: {
      provider: 'FEDAPAY',
      eventType: input.eventType,
      externalId: input.externalId,
      signature: input.signature,
      payload: input.payload,
      status: 'RECEIVED'
    }
  });

  return {
    id: created.id,
    alreadyProcessed: false
  };
}

export async function handleFedapayWebhook(request: Request): Promise<FedapayWebhookResult> {
  if (!env.FEDAPAY_WEBHOOK_SECRET) {
    throw new AppError(
      'FEDAPAY_WEBHOOK_SECRET is missing. Configure webhook signature secret first.',
      500,
      'PAYMENT_PROVIDER_CONFIG_MISSING'
    );
  }

  const signature = getSignatureHeader(request);

  if (!signature) {
    throw new AppError('Missing FedaPay webhook signature header', 400, 'WEBHOOK_SIGNATURE_MISSING');
  }

  const rawBody = getRawBody(request);
  let payload: JsonRecord;

  try {
    payload = Webhook.constructEvent(rawBody, signature, env.FEDAPAY_WEBHOOK_SECRET) as JsonRecord;
  } catch (error) {
    throw new AppError('Invalid FedaPay webhook signature', 400, 'WEBHOOK_SIGNATURE_INVALID', {
      reason: extractErrorMessage(error)
    });
  }

  const sanitizedPayload = sanitizePayload(payload);
  const eventType = asString(payload.type) || 'unknown';
  const eventId = asString(payload.id) || asString(payload.event_id) || asString(payload.eventId);

  let webhookEventId: string | null = null;

  try {
    const persisted = await createOrRefreshWebhookEvent({
      payload: sanitizedPayload,
      eventType,
      externalId: eventId,
      signature
    });

    webhookEventId = persisted.id;

    if (persisted.alreadyProcessed) {
      return {
        received: true,
        processed: false,
        eventId: eventId || null,
        paymentStatus: null
      };
    }

    const fedapayStatus = extractFedapayStatus(payload, eventType);
    const mappedStatus = mapFedapayStatusToPaymentStatus(fedapayStatus);

    if (!mappedStatus) {
      await prisma.webhookEvent.update({
        where: { id: persisted.id },
        data: {
          status: 'IGNORED',
          processedAt: new Date(),
          errorMessage: `Unsupported or missing FedaPay status for event '${eventType}'`
        }
      });

      return {
        received: true,
        processed: false,
        eventId: eventId || null,
        paymentStatus: null
      };
    }

    const identifiers = extractTransactionIdentifiers(payload);

    if (identifiers.paymentIds.length === 0 && identifiers.references.length === 0) {
      await prisma.webhookEvent.update({
        where: { id: persisted.id },
        data: {
          status: 'FAILED',
          processedAt: new Date(),
          errorMessage: 'Missing transaction identifiers in FedaPay webhook payload'
        }
      });

      return {
        received: true,
        processed: false,
        eventId: eventId || null,
        paymentStatus: mappedStatus
      };
    }

    const payment = await prisma.payment.findFirst({
      where: {
        provider: 'FEDAPAY',
        OR: [
          ...identifiers.paymentIds.map((value) => ({ providerPaymentId: value })),
          ...identifiers.paymentIds.map((value) => ({ providerTransactionRef: value })),
          ...identifiers.references.map((value) => ({ providerTransactionRef: value })),
          ...identifiers.references.map((value) => ({ reference: value }))
        ]
      }
    });

    if (!payment) {
      await prisma.webhookEvent.update({
        where: { id: persisted.id },
        data: {
          status: 'FAILED',
          processedAt: new Date(),
          errorMessage: `No matching payment found for FedaPay identifiers: ${[
            ...identifiers.paymentIds,
            ...identifiers.references
          ].join(', ')}`
        }
      });

      return {
        received: true,
        processed: false,
        eventId: eventId || null,
        paymentStatus: mappedStatus
      };
    }

    const currentStatus = payment.status as PaymentStatusValue;
    const applyStatus = shouldApplyIncomingStatus(currentStatus, mappedStatus);

    if (applyStatus) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: mappedStatus,
          paidAt:
            mappedStatus === 'SUCCEEDED' ||
            mappedStatus === 'PARTIALLY_REFUNDED' ||
            mappedStatus === 'REFUNDED'
              ? payment.paidAt || new Date()
              : payment.paidAt,
          failedAt:
            mappedStatus === 'FAILED' || mappedStatus === 'CANCELLED' || mappedStatus === 'EXPIRED'
              ? payment.failedAt || new Date()
              : payment.failedAt,
          failureReason:
            mappedStatus === 'FAILED' || mappedStatus === 'CANCELLED' || mappedStatus === 'EXPIRED'
              ? `FedaPay status: ${fedapayStatus || 'unknown'}`
              : null
        }
      });
    }

    if (successLikePaymentStatuses.has(mappedStatus)) {
      await syncOrderStatusesAfterSuccessfulPayment({
        orderId: payment.orderId,
        storeOrderId: payment.storeOrderId,
        eventType,
        eventId
      });
    }

    const attemptRequestId = eventId || identifiers.paymentIds[0] || identifiers.references[0] || null;
    const existingAttempt = attemptRequestId
      ? await prisma.paymentAttempt.findFirst({
          where: {
            paymentId: payment.id,
            providerRequestId: attemptRequestId
          },
          select: {
            id: true
          }
        })
      : null;

    if (!existingAttempt) {
      await prisma.paymentAttempt.create({
        data: {
          paymentId: payment.id,
          status: toAttemptStatus(mappedStatus),
          providerRequestId: attemptRequestId,
          requestPayload: {
            eventType,
            webhookEventId: persisted.id,
            fedapayStatus
          },
          responsePayload: sanitizedPayload,
          errorMessage: mappedStatus === 'FAILED' ? 'FedaPay reported payment failure' : null,
          completedAt: new Date()
        }
      });
    }

    await prisma.webhookEvent.update({
      where: { id: persisted.id },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
        errorMessage: null
      }
    });

    return {
      received: true,
      processed: true,
      eventId: eventId || null,
      paymentStatus: mappedStatus
    };
  } catch (error) {
    if (webhookEventId) {
      await prisma.webhookEvent
        .update({
          where: { id: webhookEventId },
          data: {
            status: 'FAILED',
            processedAt: new Date(),
            errorMessage: extractErrorMessage(error)
          }
        })
        .catch(() => undefined);
    }

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('Failed to process FedaPay webhook', 500, 'WEBHOOK_PROCESSING_ERROR', {
      reason: extractErrorMessage(error)
    });
  }
}

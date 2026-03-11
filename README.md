# Envenflow Backend (PostgreSQL + Prisma)

Production-ready backend foundation for Envenflow with a normalized relational schema for:

- users and security
- organizations and teams
- stores and seller dashboard
- marketplace and inventory
- cart/checkout/orders
- payments and webhooks
- events and ticketing with QR scan logs
- contests with paid voting
- live streaming access and chat
- CMS, notifications, and audit logs

## 1) Full Prisma Schema

The full schema is implemented in:

- `prisma/schema.prisma`

It contains:

- all requested models
- all enums
- explicit PK/FK relations
- join tables for many-to-many cases (`UserRole`, `OrganizationMember`, `StoreMember`)
- money as `Decimal`
- time fields as `DateTime`
- publication workflow states via enum `PublicationStatus`
- non-destructive data lifecycle via status fields

## 2) Enum Strategy

Main enums include:

- identity/security: `UserStatus`, `MemberRole`, `MemberStatus`
- workflow/publication: `PublicationStatus`, `ApplicationStatus`
- commerce: `ProductType`, `ProductStatus`, `CartStatus`, `CheckoutStatus`, `OrderStatus`, `DeliveryStatus`
- payments: `PaymentProvider`, `PaymentStatus`, `PaymentAttemptStatus`, `RefundStatus`
- ticket/live/contest: `TicketStatus`, `TicketScanResult`, `LiveStatus`, `LiveAccessStatus`, `ContestStatus`, `VoteStatus`
- platform: `NotificationType`, `NotificationChannel`, `PlatformSettingScope`

## 3) Relationship Highlights

- `User` 1-1 `UserProfile`
- `User` 1-n `UserSession`, `UserAddress`, `Notification`, `AuditLog`
- `User` n-n `Role` via `UserRole`
- `Organization` 1-n `OrganizationMember`, `Store`, `Event`, `Contest`, `LiveEvent`
- `Store` 1-n `Product`
- `Product` 1-n `ProductMedia`, `ProductVariant`, `InventoryMovement`
- `Cart` 1-1 `User`, 1-n `CartItem`
- `Order` 1-n `StoreOrder` (multi-store split)
- `StoreOrder` 1-n `OrderItem`
- `OrderItem` optional links to `ProductVariant`, `EventTicketType`, `LiveTicketType`
- `OrderItem` 1-1 optional `OrderItemCustomization`
- `Ticket` links to `OrderItem` and logs validation attempts in `TicketScan`
- `ContestVote` linked to `Payment` and optional `Order`
- `LiveAccess` linked to `Payment` and `OrderItem`

## 4) Index Strategy

Indexes were added for all high-frequency paths:

- auth/session lookups: `User.email`, `User.phone`, `UserSession(userId, expiresAt)`
- publication queries: `publicationStatus` + lifecycle status on public entities
- marketplace filters: `Product(storeId, publicationStatus, status)`, category/event indexes
- checkout and order retrieval: `Order(userId, createdAt)`, `Order(status, createdAt)`, `StoreOrder(storeId, status)`
- payment observability: provider/status indexes, unique provider refs
- QR scan and live analytics: `TicketScan(ticketId, scannedAt)`, `LiveViewerSession(liveEventId, joinedAt)`
- CMS rendering: section/item ordering and publication windows
- audit and notification feed indexes for user timeline reads

## 5) Modeling Choices (Why)

- **Order snapshots**: `OrderItem` stores snapshot fields (`productNameSnapshot`, `unitPrice`, etc.) so historic orders never break after catalog edits.
- **Multi-store checkout**: global `Order` + per-store `StoreOrder` enables independent store-level fulfillment and payment.
- **Payment targeting**: `Payment` can point to global `Order` or specific `StoreOrder`.
- **Non-destructive governance**: core records are not hard-deleted through cascade on critical relations; statuses manage lifecycle.
- **Publication moderation**: reusable `PublicationStatus` supports draft/review/published/archived/rejected across stores/products/events/contests/live/CMS.
- **Ticket validation forensics**: `TicketScan` stores every scan with explicit result enum.
- **Relational-first**: JSON used only for flexible payloads (`metadata`, CMS payload, webhook payload, snapshots).

## 6) Minimal Seed Data

Implemented in:

- `prisma/seed.ts`

Seed creates:

- roles: `admin`, `seller`, `organizer`, `user`
- admin user + profile + admin role assignment
- payment methods (KKiaPay/FedaPay/Stripe)
- CMS sections (`hero`, `featured-events`)
- baseline platform settings
- one organization + one store + one category + one sample product
- sample translations (`fr`, `en`)

Run:

```bash
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run prisma:seed
```

### Local admin credentials (development)

After running `npm run prisma:seed`, a default admin account is available:

- Email: `admin@envenflow.com`
- Password: `Admin1234!`

You can override the password during seeding:

```bash
SEED_ADMIN_PASSWORD="YourStrongPassword" npm run prisma:seed
```

PowerShell (Windows):

```powershell
$env:SEED_ADMIN_PASSWORD="YourStrongPassword"; npm run prisma:seed
```

Use this admin account to approve organizer/seller requests from `/admin-space`.

## 7) Prisma Client Usage Examples

### Create store application

```ts
const application = await prisma.storeApplication.create({
  data: {
    applicantUserId: userId,
    storeName: 'CITE SISKA',
    storeSlug: 'cite-siska',
    phone: '+2290100000000',
    whatsappNumber: '+2290100000000',
    status: 'PENDING'
  }
});
```

### Publish a product after moderation

```ts
await prisma.product.update({
  where: { id: productId },
  data: {
    publicationStatus: 'PUBLISHED',
    status: 'ACTIVE'
  }
});
```

### Build multi-store order from cart

```ts
await prisma.$transaction(async (tx) => {
  const order = await tx.order.create({
    data: {
      reference: `ENV-${Date.now()}`,
      userId,
      channel: 'MARKETPLACE',
      status: 'PENDING',
      currency: 'XOF',
      subtotal,
      discount,
      deliveryFee,
      total
    }
  });

  for (const group of groupedByStore) {
    const storeOrder = await tx.storeOrder.create({
      data: {
        orderId: order.id,
        storeId: group.storeId,
        reference: `${order.reference}-${group.storeCode}`,
        status: 'PENDING',
        currency: 'XOF',
        subtotal: group.subtotal,
        total: group.total
      }
    });

    for (const item of group.items) {
      await tx.orderItem.create({
        data: {
          orderId: order.id,
          storeOrderId: storeOrder.id,
          productId: item.productId,
          variantId: item.variantId,
          productNameSnapshot: item.name,
          storeNameSnapshot: group.storeName,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          subtotal: item.subtotal
        }
      });
    }
  }
});
```

### Initialize payment for a store order

```ts
const payment = await prisma.payment.create({
  data: {
    reference: `PAY-${Date.now()}`,
    storeOrderId,
    paymentMethodId,
    provider: 'KKIAPAY',
    status: 'PENDING',
    amount,
    currency: 'XOF',
    createdByUserId: userId
  }
});
```

### Ticket QR scan logging

```ts
await prisma.ticketScan.create({
  data: {
    ticketId,
    scannerUserId,
    gate: 'North Gate',
    scanResult: 'VALID'
  }
});

await prisma.ticket.update({
  where: { id: ticketId },
  data: {
    status: 'USED',
    usedAt: new Date()
  }
});
```

### Contest vote linked to payment

```ts
await prisma.contestVote.create({
  data: {
    contestId,
    candidateId,
    userId,
    paymentId,
    orderId,
    quantity: 3,
    amount: new Prisma.Decimal('1500.00'),
    currency: 'XOF',
    status: 'PAID'
  }
});
```

## Project files delivered

- `prisma/schema.prisma`
- `prisma/seed.ts`
- `src/app.ts`
- `src/server.ts`
- config/middleware/core utils baseline
- routes matching requested endpoint map

## Notes

- Route handlers are scaffolded with `501 Not implemented` to keep architecture clean while schema-first implementation is finalized module by module.
- Next step is to wire each route to repository/service/controller files under `src/modules/**` with transactional use-cases using this schema.

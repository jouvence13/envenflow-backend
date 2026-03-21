import prismaModule from '@prisma/client';
import { hashPassword } from '../src/core/utils/password';

const { PrismaClient } = prismaModule as unknown as {
  PrismaClient: new () => any;
};

const prisma = new PrismaClient();
const DEFAULT_ADMIN_EMAIL = 'admin@envenflow.com';
const DEFAULT_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin1234!';

async function seedRoles() {
  const roles = [
    { code: 'admin', name: 'Administrator' },
    { code: 'seller', name: 'Seller' },
    { code: 'organizer', name: 'Organizer' },
    { code: 'user', name: 'User' }
  ];

  for (const role of roles) {
    await prisma.role.upsert({
      where: { code: role.code },
      update: { name: role.name },
      create: role
    });
  }
}

async function seedAdminUser() {
  const passwordHash = await hashPassword(DEFAULT_ADMIN_PASSWORD);

  const admin = await prisma.user.upsert({
    where: { email: DEFAULT_ADMIN_EMAIL },
    update: {
      status: 'ACTIVE',
      passwordHash
    },
    create: {
      email: DEFAULT_ADMIN_EMAIL,
      passwordHash,
      status: 'ACTIVE',
      profile: {
        create: {
          firstName: 'Envenflow',
          lastName: 'Admin',
          language: 'fr',
          theme: 'dark'
        }
      }
    }
  });

  const adminRole = await prisma.role.findUnique({ where: { code: 'admin' } });

  if (adminRole) {
    await prisma.userRole.upsert({
      where: {
        userId_roleId: {
          userId: admin.id,
          roleId: adminRole.id
        }
      },
      update: {},
      create: {
        userId: admin.id,
        roleId: adminRole.id
      }
    });
  }

  return admin;
}

async function seedPaymentMethods() {
  const methods = [
    {
      code: 'kkiapay-mobile',
      label: 'KKiaPay Mobile',
      provider: 'KKIAPAY',
      sortOrder: 10,
      isDefault: true
    },
    {
      code: 'fedapay-card',
      label: 'FedaPay Card',
      provider: 'FEDAPAY',
      sortOrder: 20,
      isDefault: false
    },
    {
      code: 'stripe-card',
      label: 'Stripe Card',
      provider: 'STRIPE',
      sortOrder: 30,
      isDefault: false
    }
  ] as const;

  for (const method of methods) {
    await prisma.paymentMethod.upsert({
      where: { code: method.code },
      update: {
        label: method.label,
        provider: method.provider,
        sortOrder: method.sortOrder,
        isDefault: method.isDefault,
        isActive: true
      },
      create: {
        code: method.code,
        label: method.label,
        provider: method.provider,
        sortOrder: method.sortOrder,
        isDefault: method.isDefault,
        isActive: true
      }
    });
  }
}

async function seedCmsAndSettings(adminUserId: string) {
  await prisma.cmsSection.upsert({
    where: { code: 'hero' },
    update: {
      title: 'Hero',
      publicationStatus: 'PUBLISHED',
      sortOrder: 1
    },
    create: {
      code: 'hero',
      title: 'Hero',
      description: 'Homepage hero section',
      publicationStatus: 'PUBLISHED',
      sortOrder: 1
    }
  });

  await prisma.cmsSection.upsert({
    where: { code: 'featured-events' },
    update: {
      title: 'Featured Events',
      publicationStatus: 'PUBLISHED',
      sortOrder: 2
    },
    create: {
      code: 'featured-events',
      title: 'Featured Events',
      description: 'Highlighted events on homepage',
      publicationStatus: 'PUBLISHED',
      sortOrder: 2
    }
  });

  await prisma.platformSetting.upsert({
    where: { key: 'platform.brand' },
    update: {
      value: {
        name: 'Envenflow',
        defaultLocale: 'fr'
      },
      isPublic: true,
      updatedByUserId: adminUserId
    },
    create: {
      key: 'platform.brand',
      value: {
        name: 'Envenflow',
        defaultLocale: 'fr'
      },
      scope: 'PUBLIC',
      description: 'Public brand configuration',
      isPublic: true,
      updatedByUserId: adminUserId
    }
  });

  await prisma.platformSetting.upsert({
    where: { key: 'payments.defaultCurrency' },
    update: {
      value: { currency: 'XOF' },
      updatedByUserId: adminUserId
    },
    create: {
      key: 'payments.defaultCurrency',
      value: { currency: 'XOF' },
      scope: 'GLOBAL',
      description: 'Default payment currency',
      isPublic: false,
      updatedByUserId: adminUserId
    }
  });
}

async function cleanupLegacyDemoData() {
  const legacyStore = await prisma.store.findUnique({
    where: { slug: 'envenflow-main-store' },
    select: { id: true, organizationId: true }
  });

  if (!legacyStore) {
    return;
  }

  await prisma.product.deleteMany({ where: { storeId: legacyStore.id } });
  await prisma.storeMember.deleteMany({ where: { storeId: legacyStore.id } });
  await prisma.store.delete({ where: { id: legacyStore.id } });

  // Remove orphan legacy organization if no store references remain.
  const storeCount = await prisma.store.count({ where: { organizationId: legacyStore.organizationId } });

  if (storeCount === 0) {
    await prisma.organizationMember.deleteMany({ where: { organizationId: legacyStore.organizationId } });
    await prisma.organization.delete({ where: { id: legacyStore.organizationId } });
  }

  await prisma.productCategory.deleteMany({ where: { slug: 'epicerie' } });
}

async function cleanupAdminGeneratedData() {
  const organizerOrganization = await prisma.organization.findUnique({
    where: { slug: 'admin-event-hub' },
    select: { id: true }
  });

  const store = await prisma.store.findUnique({
    where: { slug: 'admin-marketplace-store' },
    select: { id: true }
  });

  if (store) {
    await prisma.product.deleteMany({ where: { storeId: store.id } });
  }

  if (!organizerOrganization) {
    return;
  }

  const events = await prisma.event.findMany({
    where: { organizationId: organizerOrganization.id },
    select: { id: true }
  });

  const eventIds = events.map((event: { id: string }) => event.id);

  if (eventIds.length) {
    await prisma.ticketScan.deleteMany({
      where: {
        ticket: {
          eventId: {
            in: eventIds
          }
        }
      }
    });
    await prisma.ticket.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.eventTicketType.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
  }

  const liveEvents = await prisma.liveEvent.findMany({
    where: { organizationId: organizerOrganization.id },
    select: { id: true }
  });

  const liveIds = liveEvents.map((live: { id: string }) => live.id);

  if (liveIds.length) {
    await prisma.liveViewerSession.deleteMany({ where: { liveEventId: { in: liveIds } } });
    await prisma.liveChatMessage.deleteMany({ where: { liveEventId: { in: liveIds } } });
    await prisma.liveAccess.deleteMany({ where: { liveEventId: { in: liveIds } } });
    await prisma.liveTicketType.deleteMany({ where: { liveEventId: { in: liveIds } } });
    await prisma.liveEvent.deleteMany({ where: { id: { in: liveIds } } });
  }

  const contests = await prisma.contest.findMany({
    where: { organizationId: organizerOrganization.id },
    select: { id: true }
  });

  const contestIds = contests.map((contest: { id: string }) => contest.id);

  if (!contestIds.length) {
    return;
  }

  const candidates = await prisma.contestCandidate.findMany({
    where: { contestId: { in: contestIds } },
    select: { id: true }
  });

  const candidateIds = candidates.map((candidate: { id: string }) => candidate.id);

  if (candidateIds.length) {
    await prisma.contestCandidateMedia.deleteMany({ where: { candidateId: { in: candidateIds } } });
  }

  await prisma.contestVote.deleteMany({ where: { contestId: { in: contestIds } } });
  await prisma.contestRankSnapshot.deleteMany({ where: { contestId: { in: contestIds } } });
  await prisma.contestCandidate.deleteMany({ where: { contestId: { in: contestIds } } });
  await prisma.contest.deleteMany({ where: { id: { in: contestIds } } });
}

async function seedAdminOrganizationsAndStore(adminUserId: string) {
  const storeOrganization = await prisma.organization.upsert({
    where: { slug: 'admin-commerce-hub' },
    update: {
      name: 'Admin Commerce Hub',
      type: 'STORE',
      status: 'ACTIVE',
      publicationStatus: 'PUBLISHED'
    },
    create: {
      name: 'Admin Commerce Hub',
      slug: 'admin-commerce-hub',
      ownerUserId: adminUserId,
      type: 'STORE',
      status: 'ACTIVE',
      publicationStatus: 'PUBLISHED'
    }
  });

  const organizerOrganization = await prisma.organization.upsert({
    where: { slug: 'admin-event-hub' },
    update: {
      name: 'Admin Event Hub',
      type: 'ORGANIZER',
      status: 'ACTIVE',
      publicationStatus: 'PUBLISHED',
      description: 'Organisation principale admin pour evenements, lives et concours'
    },
    create: {
      name: 'Admin Event Hub',
      slug: 'admin-event-hub',
      ownerUserId: adminUserId,
      type: 'ORGANIZER',
      status: 'ACTIVE',
      publicationStatus: 'PUBLISHED',
      description: 'Organisation principale admin pour evenements, lives et concours'
    }
  });

  await prisma.organizationMember.upsert({
    where: {
      organizationId_userId: {
        organizationId: organizerOrganization.id,
        userId: adminUserId
      }
    },
    update: {
      role: 'OWNER',
      status: 'ACTIVE'
    },
    create: {
      organizationId: organizerOrganization.id,
      userId: adminUserId,
      role: 'OWNER',
      status: 'ACTIVE'
    }
  });

  const store = await prisma.store.upsert({
    where: { slug: 'admin-marketplace-store' },
    update: {
      name: 'Admin Marketplace Store',
      phone: '+2290100000000',
      whatsappNumber: '+2290100000000',
      description: 'Boutique principale admin',
      status: 'ACTIVE',
      publicationStatus: 'PUBLISHED'
    },
    create: {
      organizationId: storeOrganization.id,
      ownerUserId: adminUserId,
      name: 'Admin Marketplace Store',
      slug: 'admin-marketplace-store',
      phone: '+2290100000000',
      whatsappNumber: '+2290100000000',
      description: 'Boutique principale admin',
      status: 'ACTIVE',
      publicationStatus: 'PUBLISHED',
      members: {
        create: {
          userId: adminUserId,
          role: 'OWNER',
          status: 'ACTIVE'
        }
      }
    }
  });

  return { store, organizerOrganization };
}

async function seedTranslations() {
  const translations = [
    { locale: 'fr', namespace: 'common', key: 'app.name', value: 'Envenflow' },
    { locale: 'en', namespace: 'common', key: 'app.name', value: 'Envenflow' },
    { locale: 'fr', namespace: 'shop', key: 'checkout.title', value: 'Finalisation de commande' },
    { locale: 'en', namespace: 'shop', key: 'checkout.title', value: 'Checkout' }
  ];

  for (const item of translations) {
    await prisma.translation.upsert({
      where: {
        locale_namespace_key: {
          locale: item.locale,
          namespace: item.namespace,
          key: item.key
        }
      },
      update: {
        value: item.value
      },
      create: item
    });
  }
}

async function main() {
  await seedRoles();
  const admin = await seedAdminUser();
  await seedPaymentMethods();
  await seedCmsAndSettings(admin.id);
  await cleanupLegacyDemoData();
  await cleanupAdminGeneratedData();
  await seedAdminOrganizationsAndStore(admin.id);
  await seedTranslations();

  // Keep dev credentials visible after seeding for local role-approval flows.
  console.info(`[seed] admin email: ${DEFAULT_ADMIN_EMAIL}`);
  console.info(`[seed] admin password: ${DEFAULT_ADMIN_PASSWORD}`);
  console.info('[seed] admin base data prepared without demo events/shop/contests/lives');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

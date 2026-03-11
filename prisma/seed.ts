import prismaModule from '@prisma/client';
import { hashPassword } from '../src/core/utils/password';

const { PrismaClient } = prismaModule as unknown as {
  PrismaClient: new () => any;
};

const prisma = new PrismaClient();
const DEFAULT_ADMIN_EMAIL = 'admin@envenflow.com';
const DEFAULT_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin1234!';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

const EVENT_CATEGORIES = [
  'Concerts',
  'Festivals',
  'Soirees',
  'Sportif',
  'Conferences',
  'Theatre',
  'Cinema',
  'Formations',
  'Gastronomie',
  'Style de vie'
] as const;

const EVENT_LOCATIONS = [
  'Cotonou',
  'Porto-Novo',
  'Parakou',
  'Abomey',
  'Ouidah',
  'Bohicon',
  'Natitingou',
  'Djougou',
  'Lokossa',
  'Grand-Popo'
] as const;

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
      description: 'Boutique principale admin avec catalogue exemple',
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
      description: 'Boutique principale admin avec catalogue exemple',
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

async function seedAdminProducts(adminUserId: string, storeId: string) {
  const category = await prisma.productCategory.upsert({
    where: { slug: 'epicerie-premium' },
    update: {
      name: 'Epicerie Premium',
      publicationStatus: 'PUBLISHED'
    },
    create: {
      name: 'Epicerie Premium',
      slug: 'epicerie-premium',
      publicationStatus: 'PUBLISHED'
    }
  });

  const productCatalog = [
    {
      name: 'Gari blanc premium 2kg',
      description: 'Gari blanc finement selectionne pour cuisine quotidienne.',
      productType: 'PHYSICAL',
      price: '3200.00',
      oldPrice: '3700.00',
      stock: 180
    },
    {
      name: 'Riz parfume local 5kg',
      description: 'Riz local calibre premium, ideal pour repas familiaux.',
      productType: 'PHYSICAL',
      price: '8900.00',
      oldPrice: '9400.00',
      stock: 140
    },
    {
      name: 'Huile rouge artisanale 1L',
      description: 'Huile rouge naturelle issue de production artisanale controlee.',
      productType: 'PHYSICAL',
      price: '2600.00',
      oldPrice: '2900.00',
      stock: 220
    },
    {
      name: 'Farine de mais locale 3kg',
      description: 'Farine de mais fine pour pate, beignets et bouillies.',
      productType: 'PHYSICAL',
      price: '3400.00',
      oldPrice: '3900.00',
      stock: 160
    }
  ] as const;

  for (const item of productCatalog) {
    const slug = slugify(item.name);

    await prisma.product.upsert({
      where: {
        storeId_slug: {
          storeId,
          slug
        }
      },
      update: {
        categoryId: category.id,
        createdByUserId: adminUserId,
        name: item.name,
        description: item.description,
        productType: item.productType,
        price: item.price,
        oldPrice: item.oldPrice,
        stock: item.stock,
        status: 'ACTIVE',
        publicationStatus: 'PUBLISHED'
      },
      create: {
        storeId,
        categoryId: category.id,
        createdByUserId: adminUserId,
        name: item.name,
        slug,
        description: item.description,
        productType: item.productType,
        price: item.price,
        oldPrice: item.oldPrice,
        stock: item.stock,
        status: 'ACTIVE',
        publicationStatus: 'PUBLISHED'
      }
    });
  }
}

async function seedAdminEvents(adminUserId: string, organizationId: string) {
  const now = new Date();
  const scheduleOffsets = [7, 14, 21, -12, 2];
  const scheduleStatuses = ['SCHEDULED', 'SCHEDULED', 'SCHEDULED', 'COMPLETED', 'ONGOING'] as const;

  for (const [categoryIndex, category] of EVENT_CATEGORIES.entries()) {
    for (let itemIndex = 0; itemIndex < 5; itemIndex += 1) {
      const title = `${category} Edition ${itemIndex + 1}`;
      const slug = slugify(`${title}-${categoryIndex + 1}`);
      const startAt = new Date(now.getTime() + scheduleOffsets[itemIndex] * 24 * 60 * 60 * 1000);
      startAt.setHours(18, 0, 0, 0);
      const endAt = new Date(startAt.getTime() + 4 * 60 * 60 * 1000);
      const location = EVENT_LOCATIONS[(categoryIndex + itemIndex) % EVENT_LOCATIONS.length];

      const event = await prisma.event.upsert({
        where: { slug },
        update: {
          organizationId,
          createdByUserId: adminUserId,
          title,
          shortDescription: category,
          description: `Evenement ${category} cree pour le compte admin avec billetterie complete.`,
          location,
          timezone: 'Africa/Porto-Novo',
          startAt,
          endAt,
          status: scheduleStatuses[itemIndex],
          publicationStatus: 'PUBLISHED',
          isFeatured: itemIndex === 0,
          capacity: 500 + itemIndex * 100
        },
        create: {
          organizationId,
          createdByUserId: adminUserId,
          slug,
          title,
          shortDescription: category,
          description: `Evenement ${category} cree pour le compte admin avec billetterie complete.`,
          location,
          timezone: 'Africa/Porto-Novo',
          startAt,
          endAt,
          status: scheduleStatuses[itemIndex],
          publicationStatus: 'PUBLISHED',
          isFeatured: itemIndex === 0,
          capacity: 500 + itemIndex * 100
        }
      });

      await prisma.eventTicketType.upsert({
        where: {
          eventId_name: {
            eventId: event.id,
            name: 'Standard'
          }
        },
        update: {
          description: 'Acces standard',
          price: '2500.00',
          currency: 'XOF',
          stock: 600,
          publicationStatus: 'PUBLISHED'
        },
        create: {
          eventId: event.id,
          name: 'Standard',
          description: 'Acces standard',
          price: '2500.00',
          currency: 'XOF',
          stock: 600,
          publicationStatus: 'PUBLISHED'
        }
      });

      await prisma.eventTicketType.upsert({
        where: {
          eventId_name: {
            eventId: event.id,
            name: 'VIP'
          }
        },
        update: {
          description: 'Acces VIP avec place reservee',
          price: '9000.00',
          currency: 'XOF',
          stock: 150,
          publicationStatus: 'PUBLISHED'
        },
        create: {
          eventId: event.id,
          name: 'VIP',
          description: 'Acces VIP avec place reservee',
          price: '9000.00',
          currency: 'XOF',
          stock: 150,
          publicationStatus: 'PUBLISHED'
        }
      });
    }
  }
}

async function seedAdminLives(adminUserId: string, organizationId: string) {
  const now = new Date();
  const liveTemplates = [
    { title: 'Live Backstage Festival Urbain', dayOffset: 5, status: 'UPCOMING' },
    { title: 'Talk Show Talent Afrique', dayOffset: 9, status: 'UPCOMING' },
    { title: 'Session Coaching Candidats', dayOffset: -2, status: 'ENDED' },
    { title: 'Masterclass Scene & Performance', dayOffset: 12, status: 'UPCOMING' },
    { title: 'After Event Recap', dayOffset: -6, status: 'ENDED' }
  ] as const;

  for (const template of liveTemplates) {
    const startAt = new Date(now.getTime() + template.dayOffset * 24 * 60 * 60 * 1000);
    startAt.setHours(20, 0, 0, 0);
    const endAt = new Date(startAt.getTime() + 2 * 60 * 60 * 1000);
    const slug = slugify(template.title);

    const live = await prisma.liveEvent.upsert({
      where: { slug },
      update: {
        organizationId,
        createdByUserId: adminUserId,
        title: template.title,
        description: 'Live admin exemple pour diffusion et engagement communautaire.',
        streamUrl: 'https://stream.example.com/admin/live',
        startAt,
        endAt,
        status: template.status,
        publicationStatus: 'PUBLISHED',
        isPaid: true,
        chatEnabled: true
      },
      create: {
        organizationId,
        createdByUserId: adminUserId,
        slug,
        title: template.title,
        description: 'Live admin exemple pour diffusion et engagement communautaire.',
        streamUrl: 'https://stream.example.com/admin/live',
        startAt,
        endAt,
        status: template.status,
        publicationStatus: 'PUBLISHED',
        isPaid: true,
        chatEnabled: true
      }
    });

    await prisma.liveTicketType.upsert({
      where: {
        liveEventId_name: {
          liveEventId: live.id,
          name: 'Pass Live'
        }
      },
      update: {
        description: 'Acces unique au live',
        price: '1500.00',
        currency: 'XOF',
        stock: 1000,
        publicationStatus: 'PUBLISHED'
      },
      create: {
        liveEventId: live.id,
        name: 'Pass Live',
        description: 'Acces unique au live',
        price: '1500.00',
        currency: 'XOF',
        stock: 1000,
        publicationStatus: 'PUBLISHED'
      }
    });
  }
}

async function seedAdminContests(adminUserId: string, organizationId: string) {
  const now = new Date();
  const startAt = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const endAt = new Date(startAt.getTime() + 14 * 24 * 60 * 60 * 1000);
  const votesStart = new Date(startAt.getTime() + 1 * 24 * 60 * 60 * 1000);
  const votesEnd = new Date(startAt.getTime() + 10 * 24 * 60 * 60 * 1000);
  const contest = await prisma.contest.upsert({
    where: { slug: 'grand-concours-admin-2026' },
    update: {
      organizationId,
      createdByUserId: adminUserId,
      title: 'Grand Concours Admin 2026',
      subtitle: 'Edition unique',
      description: 'Concours principal rattache au compte admin.',
      category: 'Talent',
      status: 'VOTING_OPEN',
      publicationStatus: 'PUBLISHED',
      votePrice: '500.00',
      currency: 'XOF',
      startAt,
      endAt,
      votesStart,
      votesEnd,
      maxVotesPerAccount: 50
    },
    create: {
      organizationId,
      createdByUserId: adminUserId,
      slug: 'grand-concours-admin-2026',
      title: 'Grand Concours Admin 2026',
      subtitle: 'Edition unique',
      description: 'Concours principal rattache au compte admin.',
      category: 'Talent',
      status: 'VOTING_OPEN',
      publicationStatus: 'PUBLISHED',
      votePrice: '500.00',
      currency: 'XOF',
      startAt,
      endAt,
      votesStart,
      votesEnd,
      maxVotesPerAccount: 50
    }
  });

  const candidates = ['Talent Star A', 'Talent Star B', 'Talent Star C'];

  for (const candidateName of candidates) {
    const candidateSlug = slugify(candidateName);

    await prisma.contestCandidate.upsert({
      where: {
        contestId_slug: {
          contestId: contest.id,
          slug: candidateSlug
        }
      },
      update: {
        name: candidateName,
        slogan: 'Performance, discipline et impact.',
        biography: 'Candidat exemple cree automatiquement pour tests du module concours.',
        publicationStatus: 'PUBLISHED'
      },
      create: {
        contestId: contest.id,
        slug: candidateSlug,
        name: candidateName,
        slogan: 'Performance, discipline et impact.',
        biography: 'Candidat exemple cree automatiquement pour tests du module concours.',
        publicationStatus: 'PUBLISHED'
      }
    });
  }
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
  const { store, organizerOrganization } = await seedAdminOrganizationsAndStore(admin.id);
  await seedAdminProducts(admin.id, store.id);
  await seedAdminEvents(admin.id, organizerOrganization.id);
  await seedAdminContests(admin.id, organizerOrganization.id);
  await seedTranslations();

  // Keep dev credentials visible after seeding for local role-approval flows.
  console.info(`[seed] admin email: ${DEFAULT_ADMIN_EMAIL}`);
  console.info(`[seed] admin password: ${DEFAULT_ADMIN_PASSWORD}`);
  console.info('[seed] 4 products, 50 events (5 x 10 categories), 1 contest prepared for admin account');
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

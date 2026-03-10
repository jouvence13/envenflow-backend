import prismaModule from '@prisma/client';

const { PrismaClient } = prismaModule as unknown as {
  PrismaClient: new () => any;
};

const prisma = new PrismaClient();

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
  const admin = await prisma.user.upsert({
    where: { email: 'admin@envenflow.com' },
    update: {
      status: 'ACTIVE'
    },
    create: {
      email: 'admin@envenflow.com',
      passwordHash: '$2b$12$2v9n0wI.w8mN6vqfI6P1d.uD9bwM5cglk3W5lYdrQ3pS8QZ1A2h7K',
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

async function seedOrganizationStoreAndProducts(adminUserId: string) {
  const organization = await prisma.organization.upsert({
    where: { slug: 'envenflow-store-org' },
    update: {
      name: 'Envenflow Store Org',
      type: 'STORE',
      status: 'ACTIVE',
      publicationStatus: 'PUBLISHED'
    },
    create: {
      name: 'Envenflow Store Org',
      slug: 'envenflow-store-org',
      ownerUserId: adminUserId,
      type: 'STORE',
      status: 'ACTIVE',
      publicationStatus: 'PUBLISHED'
    }
  });

  await prisma.store.upsert({
    where: { slug: 'envenflow-main-store' },
    update: {
      name: 'Envenflow Main Store',
      phone: '+2290100000000',
      whatsappNumber: '+2290100000000',
      status: 'ACTIVE',
      publicationStatus: 'PUBLISHED'
    },
    create: {
      organizationId: organization.id,
      ownerUserId: adminUserId,
      name: 'Envenflow Main Store',
      slug: 'envenflow-main-store',
      phone: '+2290100000000',
      whatsappNumber: '+2290100000000',
      status: 'ACTIVE',
      publicationStatus: 'PUBLISHED'
    }
  });

  const category = await prisma.productCategory.upsert({
    where: { slug: 'epicerie' },
    update: {
      name: 'Epicerie',
      publicationStatus: 'PUBLISHED'
    },
    create: {
      name: 'Epicerie',
      slug: 'epicerie',
      publicationStatus: 'PUBLISHED'
    }
  });

  const store = await prisma.store.findUniqueOrThrow({ where: { slug: 'envenflow-main-store' } });

  await prisma.product.upsert({
    where: {
      storeId_slug: {
        storeId: store.id,
        slug: 'gari-lait-coco'
      }
    },
    update: {
      name: 'Gari au lait de coco',
      description: 'Produit demo marketplace',
      price: '1300.00',
      oldPrice: '2000.00',
      stock: 100,
      status: 'ACTIVE',
      publicationStatus: 'PUBLISHED',
      productType: 'PHYSICAL'
    },
    create: {
      storeId: store.id,
      categoryId: category.id,
      createdByUserId: adminUserId,
      name: 'Gari au lait de coco',
      slug: 'gari-lait-coco',
      description: 'Produit demo marketplace',
      price: '1300.00',
      oldPrice: '2000.00',
      stock: 100,
      status: 'ACTIVE',
      publicationStatus: 'PUBLISHED',
      productType: 'PHYSICAL'
    }
  });
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
  await seedOrganizationStoreAndProducts(admin.id);
  await seedTranslations();
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

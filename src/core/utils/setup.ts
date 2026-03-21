import { prisma } from '../../libs/prisma';
import { hashPassword } from './password';

export async function ensureAdminUser() {
  const adminEmail = 'admin@envenflow.com';
  const adminPassword = 'Admin1234!';

  // 1. Seed Roles
  const roles = [
    { code: 'admin', name: 'Administrator' },
    { code: 'seller', name: 'Seller' },
    { code: 'organizer', name: 'Organizer' },
    { code: 'user', name: 'User' }
  ];

  for (const role of roles) {
    await prisma.role.upsert({
      where: { code: role.code },
      update: {},
      create: role
    });
  }

  // 2. Check if Admin exists
  const existingAdmin = await prisma.user.findUnique({
    where: { email: adminEmail }
  });

  if (!existingAdmin) {
    const passwordHash = await hashPassword(adminPassword);
    
    const admin = await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash,
        status: 'ACTIVE',
        profile: {
          create: {
            firstName: 'Evenflow',
            lastName: 'Admin',
            language: 'fr',
            theme: 'dark'
          }
        }
      }
    });

    const adminRole = await prisma.role.findUnique({ where: { code: 'admin' } });
    if (adminRole) {
      await prisma.userRole.create({
        data: {
          userId: admin.id,
          roleId: adminRole.id
        }
      });
    }
    
    // eslint-disable-next-line no-console
    console.log('[setup] Admin user created automatically');
  }
}

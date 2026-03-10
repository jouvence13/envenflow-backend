import { prisma } from '../../libs/prisma';
import { NotFoundError } from '../errors/NotFoundError';
import { UnauthorizedError } from '../errors/UnauthorizedError';

const MANAGER_ROLES = ['OWNER', 'ADMIN', 'MANAGER'];

export async function assertStoreManagementAccess(storeId: string, userId: string) {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    include: {
      members: {
        where: {
          userId,
          status: 'ACTIVE',
          role: { in: MANAGER_ROLES }
        },
        take: 1
      }
    }
  });

  if (!store) {
    throw new NotFoundError('Store not found');
  }

  const isOwner = store.ownerUserId === userId;
  const hasManagerMembership = store.members.length > 0;

  if (!isOwner && !hasManagerMembership) {
    throw new UnauthorizedError('You cannot manage this store');
  }

  return store;
}

export async function assertOrganizationManagementAccess(organizationId: string, userId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      members: {
        where: {
          userId,
          status: 'ACTIVE',
          role: { in: MANAGER_ROLES }
        },
        take: 1
      }
    }
  });

  if (!organization) {
    throw new NotFoundError('Organization not found');
  }

  const isOwner = organization.ownerUserId === userId;
  const hasManagerMembership = organization.members.length > 0;

  if (!isOwner && !hasManagerMembership) {
    throw new UnauthorizedError('You cannot manage this organization');
  }

  return organization;
}

import prismaModule from '@prisma/client';

const { PrismaClient } = prismaModule as unknown as {
  PrismaClient: new () => any;
};

declare global {
  // eslint-disable-next-line no-var
  var __envenflowPrisma: any;
}

export const prisma = global.__envenflowPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  global.__envenflowPrisma = prisma;
}

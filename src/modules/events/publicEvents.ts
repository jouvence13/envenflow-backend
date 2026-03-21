import { Prisma } from '@prisma/client';

export const PUBLIC_EVENT_STATUSES = ['SCHEDULED', 'ONGOING', 'COMPLETED'] as const;

type BuildPublicEventWhereInput = {
  search?: string;
  organizationSlug?: string;
  slug?: string;
};

export function buildPublicEventWhere(input: BuildPublicEventWhereInput = {}): Prisma.EventWhereInput {
  const search = typeof input.search === 'string' ? input.search.trim() : '';
  const organizationSlug = typeof input.organizationSlug === 'string' ? input.organizationSlug.trim() : '';
  const slug = typeof input.slug === 'string' ? input.slug.trim() : '';

  const where: Prisma.EventWhereInput = {
    publicationStatus: 'PUBLISHED',
    status: {
      in: [...PUBLIC_EVENT_STATUSES]
    }
  };

  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { location: { contains: search, mode: 'insensitive' } }
    ];
  }

  if (organizationSlug) {
    where.organization = {
      slug: organizationSlug,
      status: 'ACTIVE',
      publicationStatus: 'PUBLISHED'
    };
  }

  if (slug) {
    where.slug = slug;
  }

  return where;
}

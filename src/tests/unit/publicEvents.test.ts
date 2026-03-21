import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPublicEventWhere, PUBLIC_EVENT_STATUSES } from '../../modules/events/publicEvents';

test('buildPublicEventWhere returns the default public filters', () => {
  const where = buildPublicEventWhere();

  assert.deepEqual(where, {
    publicationStatus: 'PUBLISHED',
    status: {
      in: [...PUBLIC_EVENT_STATUSES]
    }
  });
});

test('buildPublicEventWhere adds search filters on title and location', () => {
  const where = buildPublicEventWhere({ search: 'Cotonou' });

  assert.deepEqual(where.OR, [
    { title: { contains: 'Cotonou', mode: 'insensitive' } },
    { location: { contains: 'Cotonou', mode: 'insensitive' } }
  ]);
});

test('buildPublicEventWhere adds organization and slug filters when provided', () => {
  const where = buildPublicEventWhere({ organizationSlug: 'orga-test', slug: 'concert-2026' });

  assert.equal(where.slug, 'concert-2026');
  assert.deepEqual(where.organization, {
    slug: 'orga-test',
    status: 'ACTIVE',
    publicationStatus: 'PUBLISHED'
  });
});

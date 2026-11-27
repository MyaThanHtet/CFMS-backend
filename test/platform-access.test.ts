import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { accessPolicy, type SubscriptionState } from '../src/modules/platform/access-policy.js';
import { createApp } from '../src/infrastructure/http/create-app.js';
import { CheckHealth } from '../src/modules/health/application/check-health.js';
import { CatalogService } from '../src/modules/catalog/application/catalog-service.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/infrastructure/memory-catalog-repository.js';
const now = new Date('2026-11-18T00:00:00Z');
const paid: SubscriptionState = {
  status: 'active',
  expiresAt: new Date('2026-12-18T00:00:00Z'),
  graceUntil: null,
  planCode: 'pro',
  planName: 'CFMS Pro',
  entitlements: { max_categories: 20, cloud_sync: true },
  version: 2,
  cancelAtPeriodEnd: true,
};
describe('ByteCraft subscription access', () => {
  it('defaults to Free/offline with the specified limits', () => {
    const access = accessPolicy(null, now);
    assert.equal(access.tier, 'Free');
    assert.equal(access.canSync, false);
    assert.equal(access.limits.max_shops, 1);
    assert.equal(access.limits.max_categories, 3);
    assert.equal(access.limits.max_items, 5);
    assert.equal(access.limits.max_contacts, 5);
  });
  it('keeps paid access after cancellation until the paid expiry', () => {
    const access = accessPolicy(paid, now);
    assert.equal(access.canSync, true);
    assert.equal(access.cancelAtPeriodEnd, true);
    assert.equal(access.limits.max_categories, 20);
  });
  it('automatically falls back to Free after expiry or suspension', () => {
    assert.equal(accessPolicy(paid, new Date('2027-01-01')).canSync, false);
    assert.equal(accessPolicy({ ...paid, status: 'suspended' }, now).canSync, false);
  });
  it('treats max_branches as the shop cap when max_shops is absent', () => {
    const access = accessPolicy({ ...paid, entitlements: { max_branches: 3, cloud_sync: true } }, now);
    assert.equal(access.limits.max_shops, 3);
    assert.equal(access.limits.max_branches, 3);
  });
  it('honors explicit cloud entitlement denial', () => {
    assert.equal(accessPolicy({ ...paid, entitlements: { cloud_sync: false } }, now).canSync, false);
  });
  it('denies catalog routes when no paid access policy is supplied', async () => {
    const app = createApp(
      {
        checkHealth: new CheckHealth({ ping: async () => true }),
        catalog: new CatalogService(new MemoryCatalogRepository()),
        accessTokens: { verify: async () => 'customer' },
        disconnect: async () => {},
      },
      { logger: false },
    );
    const response = await app.inject({
      method: 'GET',
      url: '/v1/stores',
      headers: { authorization: 'Bearer token' },
    });
    assert.equal(response.statusCode, 402);
    assert.equal(response.json().error.code, 'subscription_required');
    await app.close();
  });
});

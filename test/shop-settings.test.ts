import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { CheckHealth } from '../src/modules/health/application/check-health.js';
import { CatalogService } from '../src/modules/catalog/application/catalog-service.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/infrastructure/memory-catalog-repository.js';
import { createApp } from '../src/infrastructure/http/create-app.js';

describe('shop settings', () => {
  it('updates the profile and tax, and keeps one default payment method', async () => {
    const app = createApp(
      {
        checkHealth: new CheckHealth({ ping: async () => true }),
        catalog: new CatalogService(new MemoryCatalogRepository()),
        accessTokens: { verify: async (token: string) => token },
        disconnect: async () => {},
      },
      { logger: false },
    );
    const storeId = randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/stores',
      headers: { authorization: 'Bearer owner' },
      payload: { id: storeId, name: 'Morning Star', deviceId: 'device-1' },
    });
    const snapshot = created.json();
    const drawerId = snapshot.accounts[0].id as string;
    const profileId = randomUUID();
    const profile = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer owner' },
      payload: {
        commands: [
          {
            id: profileId,
            storeId,
            deviceId: 'device-1',
            type: 'store.profile',
            payload: {
              name: 'Morning Star',
              address: 'No. 12, Bogalay Zay, Yangon',
              phone: '09 111 222 333',
              email: 'shop@morningstar.com',
              baseRevision: 1,
            },
          },
        ],
      },
    });
    assert.equal(profile.statusCode, 200);
    assert.equal(profile.json().results[0].status, 'accepted');
    assert.equal(profile.json().results[0].store.revision, 2);
    assert.equal(profile.json().results[0].changeSequence, 19);

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer owner' },
      payload: {
        commands: [
          {
            id: profileId,
            storeId,
            deviceId: 'device-1',
            type: 'store.profile',
            payload: { name: 'Other', baseRevision: 1 },
          },
        ],
      },
    });
    assert.equal(replay.json().results[0].changeSequence, 19);

    const tax = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer owner' },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId: 'device-1',
            type: 'store.tax',
            payload: { taxName: 'Commercial tax', currencySymbol: 'Ks', taxRatePercent: 5, currencyCode: 'MMK', decimalPlaces: 0, baseRevision: 2 },
          },
        ],
      },
    });
    assert.equal(tax.json().results[0].store.taxRatePercent, 5);

    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer owner' },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId: 'device-1',
            type: 'store.tax',
            payload: { taxName: 'Commercial tax', currencySymbol: 'Ks', taxRatePercent: 150, baseRevision: 3 },
          },
        ],
      },
    });
    assert.equal(rejected.json().results[0].status, 'rejected');

    const methodId = randomUUID();
    const added = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer owner' },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId: 'device-1',
            type: 'paymentMethod.create',
            payload: { id: methodId, name: 'KBZPay', accountId: drawerId, isDefault: false },
          },
        ],
      },
    });
    const methods = added.json().results[0].paymentMethods as Array<{ name: string; isDefault: boolean }>;
    assert.equal(methods.length, 2);
    assert.equal(methods.find((method) => method.name === 'Cash')?.isDefault, true);
    assert.equal(methods.find((method) => method.name === 'KBZPay')?.isDefault, false);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer owner' },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId: 'device-1',
            type: 'paymentMethod.create',
            payload: { id: randomUUID(), name: 'cash', accountId: drawerId, isDefault: false },
          },
        ],
      },
    });
    assert.equal(duplicate.json().results[0].status, 'rejected');

    const promoted = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer owner' },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId: 'device-1',
            type: 'paymentMethod.update',
            payload: { id: methodId, name: 'KBZPay', accountId: drawerId, isDefault: true, baseRevision: 1 },
          },
        ],
      },
    });
    const next = promoted.json().results[0].paymentMethods as Array<{ name: string; isDefault: boolean }>;
    assert.equal(next.find((method) => method.name === 'KBZPay')?.isDefault, true);
    assert.equal(next.find((method) => method.name === 'Cash')?.isDefault, false);

    const stranger = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer stranger' },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId: 'device-2',
            type: 'store.profile',
            payload: { name: 'Taken', baseRevision: 3 },
          },
        ],
      },
    });
    assert.equal(stranger.statusCode, 403);
    await app.close();
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { AuthError } from '../src/modules/auth/domain/auth-error.js';
import { CheckHealth } from '../src/modules/health/application/check-health.js';
import { CatalogService } from '../src/modules/catalog/application/catalog-service.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/infrastructure/memory-catalog-repository.js';
import { createApp } from '../src/infrastructure/http/create-app.js';

const owner = 'user-owner';
const other = 'user-other';
const deviceId = 'device-1';

describe('category sync', () => {
  it('seeds a shop, accepts a category, replays it, and rejects a duplicate name', async () => {
    const { app, catalog } = buildApp();
    const storeId = randomUUID();

    const created = await app.inject({
      method: 'POST',
      url: '/v1/stores',
      headers: { authorization: `Bearer ${owner}` },
      payload: {
        id: storeId,
        name: 'Morning Star Groceries',
        address: 'No. 45, Merchant Street, Kyauktada',
        phone: '+95 9 4500 1289',
        email: 'contact@morningstar.com',
        deviceId,
      },
    });
    assert.equal(created.statusCode, 200);
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/stores',
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().stores.length, 1);
    assert.equal(listed.json().stores[0].name, 'Morning Star Groceries');
    const hidden = await app.inject({
      method: 'GET',
      url: '/v1/stores',
      headers: { authorization: `Bearer ${other}` },
    });
    assert.equal(hidden.statusCode, 200);
    assert.equal(hidden.json().stores.length, 0);
    const snapshot = created.json();
    assert.equal(snapshot.store.currencyCode, 'MMK');
    assert.equal(snapshot.store.timezone, 'Asia/Yangon');
    assert.equal(snapshot.categories.length, 17);
    assert.equal(snapshot.lastSequence, 18);
    assert.equal(snapshot.accounts.length, 1);
    assert.equal(snapshot.accounts[0].name, 'Cash drawer');
    assert.equal(snapshot.accounts[0].openingMinor, 0);
    assert.equal(snapshot.store.taxRatePercent, 0);
    assert.equal(snapshot.store.currencySymbol, 'Ks');
    assert.equal(snapshot.paymentMethods.length, 1);
    assert.equal(snapshot.paymentMethods[0].name, 'Cash');
    assert.equal(snapshot.paymentMethods[0].isDefault, true);
    assert.equal(snapshot.categories.filter((category: { kind: string }) => category.kind === 'ITEM').length, 6);

    const repeated = await app.inject({
      method: 'POST',
      url: '/v1/stores',
      headers: { authorization: `Bearer ${owner}` },
      payload: { id: storeId, name: 'Morning Star Groceries', deviceId },
    });
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.json().categories.length, 17);

    const stolen = await app.inject({
      method: 'POST',
      url: '/v1/stores',
      headers: { authorization: `Bearer ${other}` },
      payload: { id: storeId, name: 'Morning Star Groceries', deviceId },
    });
    assert.equal(stolen.statusCode, 409);
    assert.equal(stolen.json().error.code, 'store_taken');

    const outsider = await app.inject({
      method: 'GET',
      url: `/v1/stores/${storeId}/snapshot`,
      headers: { authorization: `Bearer ${other}` },
    });
    assert.equal(outsider.statusCode, 403);

    const categoryId = randomUUID();
    const commandId = randomUUID();
    const payload = {
      commands: [
        {
          id: commandId,
          storeId,
          deviceId,
          type: 'category.create',
          payload: {
            id: categoryId,
            kind: 'ITEM',
            name: ' Fresh   food ',
            description: 'Vegetables',
          },
        },
      ],
    };
    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: `Bearer ${owner}` },
      payload,
    });
    assert.equal(accepted.statusCode, 200);
    const first = accepted.json().results[0];
    assert.equal(first.status, 'accepted');
    assert.equal(first.category.name, 'Fresh food');
    assert.equal(first.category.revision, 1);
    assert.equal(first.changeSequence, 19);

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: `Bearer ${owner}` },
      payload,
    });
    assert.deepEqual(replay.json().results[0], first);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: `Bearer ${owner}` },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId,
            type: 'category.create',
            payload: {
              id: randomUUID(),
              kind: 'ITEM',
              name: 'fresh food',
              description: '',
            },
          },
        ],
      },
    });
    assert.equal(duplicate.json().results[0].status, 'rejected');
    assert.equal(duplicate.json().results[0].code, 'name_taken');

    const renamed = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: `Bearer ${owner}` },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId,
            type: 'category.rename',
            payload: { id: categoryId, name: 'Fresh produce', baseRevision: 1 },
          },
        ],
      },
    });
    assert.equal(renamed.json().results[0].status, 'accepted');
    assert.equal(renamed.json().results[0].category.revision, 2);

    const stale = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: `Bearer ${owner}` },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId,
            type: 'category.set_active',
            payload: { id: categoryId, isActive: false, baseRevision: 1 },
          },
        ],
      },
    });
    assert.equal(stale.json().results[0].code, 'revision_conflict');

    const changes = await app.inject({
      method: 'GET',
      url: `/v1/stores/${storeId}/changes?after=18&deviceId=${deviceId}&ack=20`,
      headers: { authorization: `Bearer ${owner}` },
    });
    assert.equal(changes.statusCode, 200);
    const body = changes.json();
    assert.equal(body.changes.length, 2);
    assert.equal(body.changes[0].sequence, 19);
    assert.equal(body.changes[1].category.name, 'Fresh produce');
    assert.equal(catalog.cursor(storeId, deviceId), 20);

    const missing = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer missing' },
      payload,
    });
    assert.equal(missing.statusCode, 401);

    await app.close();
  });
});

function buildApp() {
  const repository = new MemoryCatalogRepository();
  const catalog = new CatalogService(repository);
  const app = createApp(
    {
      checkHealth: new CheckHealth({ ping: async () => true }),
      cloudAccess: { requireCloud: async () => {} },
      catalog,
      accessTokens: {
        async verify(token: string): Promise<string> {
          if (token === 'missing') {
            throw new AuthError('unauthenticated', 'Sign in again.', 401);
          }
          return token;
        },
      },
      disconnect: async () => {},
    },
    { logger: false },
  );
  return {
    app,
    cloudAccess: { requireCloud: async () => {} },
    catalog: repository,
  };
}

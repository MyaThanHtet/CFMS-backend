import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { CheckHealth } from '../src/modules/health/application/check-health.js';
import { CatalogService } from '../src/modules/catalog/application/catalog-service.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/infrastructure/memory-catalog-repository.js';
import { createApp } from '../src/infrastructure/http/create-app.js';

describe('contacts', () => {
  it('creates, replays, settles without overpayment, and hides a deleted contact', async () => {
    const repository = new MemoryCatalogRepository();
    const catalog = new CatalogService(repository);
    const app = createApp(
      {
        checkHealth: new CheckHealth({ ping: async () => true }),
        catalog,
        accessTokens: { verify: async (token: string) => token },
        disconnect: async () => {},
      },
      { logger: false },
    );
    const storeId = randomUUID();
    const createdShop = await app.inject({
      method: 'POST',
      url: '/v1/stores',
      headers: { authorization: 'Bearer owner' },
      payload: { id: storeId, name: 'Morning Star', deviceId: 'device-1' },
    });
    const categoryId = createdShop.json().categories.find(
      (category: { kind: string; name: string }) => category.kind === 'CONTACT' && category.name === 'Customer',
    ).id as string;
    const contactId = randomUUID();
    const createId = randomUUID();
    const createPayload = {
      commands: [
        {
          id: createId,
          storeId,
          deviceId: 'device-1',
          type: 'contact.create',
          payload: {
            id: contactId,
            contactType: 'CUSTOMER',
            name: 'Ma Hla',
            categoryId,
            phone: '09 111 222 333',
            email: 'hla@shop.com',
            address: 'No. 12, Bogalay Zay, Yangon',
          },
        },
      ],
    };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer owner' },
      payload: createPayload,
    });
    assert.equal(created.json().results[0].status, 'accepted');
    assert.equal(created.json().results[0].contact.name, 'Ma Hla');
    assert.equal(created.json().results[0].contact.categoryName, 'Customer');
    assert.equal(created.json().results[0].contact.receivableMinor, 0);

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer owner' },
      payload: createPayload,
    });
    assert.equal(replay.json().results[0].changeSequence, created.json().results[0].changeSequence);

    const opened = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer owner' },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId: 'device-1',
            type: 'contact.set_opening_balance',
            payload: {
              id: contactId,
              baseRevision: 1,
              amountMinor: 50000,
              side: 'RECEIVABLE',
              effectiveDate: '2026-11-01',
              note: 'Brought forward',
            },
          },
        ],
      },
    });
    assert.equal(opened.json().results[0].contact.receivableMinor, 50000);
    assert.equal(opened.json().results[0].contact.receivableAsOf, '2026-11-01');
    assert.equal(opened.json().results[0].contact.receivableNote, 'Brought forward');

    const badDate = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer owner' },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId: 'device-1',
            type: 'contact.set_opening_balance',
            payload: { id: contactId, baseRevision: 2, amountMinor: 50000, effectiveDate: '2026-02-31' },
          },
        ],
      },
    });
    assert.equal(badDate.json().results[0].code, 'validation_error');

    const overpaid = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer owner' },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId: 'device-1',
            type: 'contact.settle',
            payload: { id: contactId, baseRevision: 2, amountMinor: 60000 },
          },
        ],
      },
    });
    assert.equal(overpaid.json().results[0].code, 'overpayment');

    const settled = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer owner' },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId: 'device-1',
            type: 'contact.settle',
            payload: {
              id: contactId,
              baseRevision: 2,
              amountMinor: 20000,
              side: 'RECEIVABLE',
              effectiveDate: '2026-11-14',
              accountName: 'Cash drawer',
              paymentMethodName: 'Cash',
              settlementId: randomUUID(),
              note: '',
            },
          },
        ],
      },
    });
    assert.equal(settled.json().results[0].status, 'accepted');
    assert.equal(settled.json().results[0].contact.receivableMinor, 30000);
    assert.equal(settled.json().results[0].contact.collectedMinor, 20000);
    assert.equal(settled.json().results[0].contact.settlements.length, 1);
    assert.equal(settled.json().results[0].contact.settlements[0].accountName, 'Cash drawer');
    assert.equal(settled.json().results[0].contact.settlements[0].amountMinor, 20000);

    const removed = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer owner' },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId: 'device-1',
            type: 'contact.deactivate',
            payload: { id: contactId, baseRevision: 3 },
          },
        ],
      },
    });
    assert.equal(removed.json().results[0].status, 'accepted');
    const snapshot = await app.inject({
      method: 'GET',
      url: `/v1/stores/${storeId}/snapshot`,
      headers: { authorization: 'Bearer owner' },
    });
    assert.equal(snapshot.json().contacts.length, 0);

    const outsider = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer stranger' },
      payload: createPayload,
    });
    assert.equal(outsider.statusCode, 403);
    await app.close();
  });
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { CheckHealth } from '../src/modules/health/application/check-health.js';
import { CatalogService } from '../src/modules/catalog/application/catalog-service.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/infrastructure/memory-catalog-repository.js';
import { createApp } from '../src/infrastructure/http/create-app.js';

describe('expenses', () => {
  it('records a paid expense, voids it, and hides a deleted one', async () => {
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
    const createdShop = await app.inject({
      method: 'POST',
      url: '/v1/stores',
      headers: { authorization: 'Bearer owner' },
      payload: { id: storeId, name: 'Morning Star', deviceId: 'device-1' },
    });
    const rentId = createdShop.json().categories.find(
      (category: { kind: string; name: string }) => category.kind === 'EXPENSE' && category.name === 'Rent',
    ).id as string;

    const expenseId = randomUUID();
    const created = await send(app, storeId, 'expense.create', {
      id: expenseId,
      title: 'Shop rent',
      categoryId: rentId,
      amountMinor: 50000,
      accountName: 'Cash drawer',
      paymentMethodName: 'Cash',
      effectiveDate: '2026-11-14',
      note: 'November rent',
    });
    assert.equal(created.status, 'accepted');
    assert.equal(created.expense?.amountMinor, 50000);
    assert.equal(created.expense?.status, 'PAID');
    assert.equal(created.expense?.categoryName, 'Rent');
    assert.equal(created.expense?.actorName, 'owner');
    assert.equal(created.expense?.revision, 1);

    const invalidDate = await send(app, storeId, 'expense.create', {
      id: randomUUID(),
      title: 'Bad date',
      amountMinor: 1000,
      accountName: 'Cash drawer',
      paymentMethodName: 'Cash',
      effectiveDate: '2026-02-31',
    });
    assert.equal(invalidDate.code, 'validation_error');

    const zero = await send(app, storeId, 'expense.create', {
      id: randomUUID(),
      title: 'Zero',
      amountMinor: 0,
      accountName: 'Cash drawer',
      paymentMethodName: 'Cash',
      effectiveDate: '2026-11-14',
    });
    assert.equal(zero.code, 'validation_error');

    const voided = await send(app, storeId, 'expense.void', { id: expenseId, baseRevision: 1 });
    assert.equal(voided.expense?.status, 'VOID');
    assert.equal(voided.expense?.amountMinor, 50000);
    assert.equal(voided.expense?.revision, 2);

    const again = await send(app, storeId, 'expense.void', { id: expenseId, baseRevision: 2 });
    assert.equal(again.code, 'validation_error');

    const removed = await send(app, storeId, 'expense.deactivate', { id: expenseId, baseRevision: 2 });
    assert.equal(removed.expense?.isActive, false);

    const snapshot = await app.inject({
      method: 'GET',
      url: `/v1/stores/${storeId}/snapshot`,
      headers: { authorization: 'Bearer owner' },
    });
    assert.equal(snapshot.json().expenses.length, 0);

    const outsider = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer stranger' },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId: 'device-2',
            type: 'expense.create',
            payload: {
              id: randomUUID(),
              title: 'Tea',
              amountMinor: 1000,
              accountName: 'Cash drawer',
              paymentMethodName: 'Cash',
              effectiveDate: '2026-11-14',
            },
          },
        ],
      },
    });
    assert.equal(outsider.statusCode, 403);
    await app.close();
  });
});

async function send(
  app: { inject: (input: object) => Promise<{ json: () => { results: Array<Record<string, unknown>> } }> },
  storeId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/commands',
    headers: { authorization: 'Bearer owner' },
    payload: {
      commands: [{ id: randomUUID(), storeId, deviceId: 'device-1', type, payload }],
    },
  });
  return response.json().results[0] as {
    status: string;
    code: string | null;
    expense: {
      amountMinor: number;
      status: string;
      categoryName: string | null;
      actorName: string;
      revision: number;
      isActive: boolean;
    } | null;
  };
}

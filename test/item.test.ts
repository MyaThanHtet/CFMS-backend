import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { CheckHealth } from '../src/modules/health/application/check-health.js';
import { CatalogService } from '../src/modules/catalog/application/catalog-service.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/infrastructure/memory-catalog-repository.js';
import { createApp } from '../src/infrastructure/http/create-app.js';

describe('items', () => {
  it('tracks opening stock, FIFO batches, and a count adjustment', async () => {
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
    const categoryId = createdShop.json().categories.find(
      (category: { kind: string; name: string }) => category.kind === 'ITEM' && category.name === 'Grocery',
    ).id as string;
    const unitId = randomUUID();
    const unit = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer owner' },
      payload: {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId: 'device-1',
            type: 'unit.create',
            payload: { id: unitId, name: 'bag' },
          },
        ],
      },
    });
    assert.equal(unit.json().results[0].unit.name, 'bag');

    const itemId = randomUUID();
    const created = await send(app, storeId, 'item.create', {
      id: itemId,
      itemType: 'PRODUCT',
      name: 'Rice 5 kg',
      sku: 'RICE-5',
      unitId,
      categoryId,
      salePriceMinor: 8000,
      purchaseCostMinor: 7000,
      stockQty: 6,
      lowStockLevel: 5,
      openingMovementId: randomUUID(),
      openingBatchId: randomUUID(),
      effectiveDate: '2026-11-01',
    });
    assert.equal(created.item.stockQty, 6);
    assert.equal(created.item.fifoCostMinor, 7000);
    assert.equal(created.batches.length, 1);
    assert.equal(created.movement?.quantityChange, 6);

    const duplicate = await send(app, storeId, 'item.create', {
      id: randomUUID(),
      itemType: 'PRODUCT',
      name: 'Other rice',
      sku: 'rice-5',
      salePriceMinor: 1000,
      purchaseCostMinor: 1000,
      stockQty: 0,
      lowStockLevel: 0,
    });
    assert.equal(duplicate.code, 'sku_taken');

    const increased = await send(app, storeId, 'item.adjust_stock', {
      id: itemId,
      baseRevision: 1,
      countedQty: 16,
      effectiveDate: '2026-11-14',
      reason: 'Count correction',
      movementId: randomUUID(),
      batchId: randomUUID(),
    });
    assert.equal(increased.item.stockQty, 16);
    assert.equal(increased.batches.length, 2);

    const counted = await send(app, storeId, 'item.adjust_stock', {
      id: itemId,
      baseRevision: 2,
      countedQty: 12,
      effectiveDate: '2026-11-14',
      reason: 'Count correction',
      movementId: randomUUID(),
    });
    assert.equal(counted.status, 'accepted');
    assert.equal(counted.item.stockQty, 12);
    assert.equal(counted.item.fifoCostMinor, 7000);
    assert.equal(counted.movement?.quantityChange, -4);
    const remaining = counted.batches.reduce(
      (sum: number, batch: { remainingQty: number }) => sum + batch.remainingQty,
      0,
    );
    assert.equal(remaining, 12);
    const value = counted.batches.reduce(
      (sum: number, batch: { remainingQty: number; unitCostMinor: number }) =>
        sum + batch.remainingQty * batch.unitCostMinor,
      0,
    );
    assert.equal(value, 84000);

    const negative = await send(app, storeId, 'item.adjust_stock', {
      id: itemId,
      baseRevision: 3,
      countedQty: -1,
      effectiveDate: '2026-11-14',
      reason: 'Count correction',
      movementId: randomUUID(),
    });
    assert.equal(negative.code, 'validation_error');

    const service = await send(app, storeId, 'item.create', {
      id: randomUUID(),
      itemType: 'SERVICE',
      name: 'Delivery',
      salePriceMinor: 2000,
    });
    assert.equal(service.item.stockQty, null);
    assert.equal(service.item.fifoCostMinor, null);

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
            type: 'unit.create',
            payload: { id: randomUUID(), name: 'tray' },
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
    item: { stockQty: number | null; fifoCostMinor: number | null };
    movement: { quantityChange: number } | null;
    batches: Array<{ remainingQty: number; unitCostMinor: number }>;
  };
}

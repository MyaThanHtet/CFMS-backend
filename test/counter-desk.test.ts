import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { CheckHealth } from '../src/modules/health/application/check-health.js';
import { CatalogService } from '../src/modules/catalog/application/catalog-service.js';
import { collectionRows, reorderRows } from '../src/modules/catalog/domain/held-sale.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/infrastructure/memory-catalog-repository.js';
import { createApp } from '../src/infrastructure/http/create-app.js';

describe('counter desk', () => {
  it('parks a sale without moving stock and restores the same lines', async () => {
    const app = createApp(
      {
        checkHealth: new CheckHealth({ ping: async () => true }),
        cloudAccess: { requireCloud: async () => {} },
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
    const categoryId = createdShop
      .json()
      .categories.find((category: { kind: string; name: string }) => category.kind === 'ITEM' && category.name === 'Grocery')
      .id as string;
    const itemId = randomUUID();
    const created = await send(app, storeId, 'item.create', {
      id: itemId,
      itemType: 'PRODUCT',
      name: 'Rice',
      categoryId,
      salePriceMinor: 8000,
      purchaseCostMinor: 7000,
      stockQty: 6,
      lowStockLevel: 2,
      openingMovementId: randomUUID(),
      openingBatchId: randomUUID(),
      effectiveDate: '2026-11-01',
    });
    assert.equal(created.item.stockQty, 6);

    const heldId = randomUUID();
    const held = await send(app, storeId, 'heldSale.upsert', {
      id: heldId,
      name: 'Aye',
      contactName: 'Aye',
      wholesale: true,
      discountMode: 'AMOUNT',
      discountValue: 500,
      taxMode: 'AMOUNT',
      taxValue: 0,
      deliveryMinor: 0,
      note: '',
      lines: [{ itemId, qty: 2, unitPriceMinor: 7500 }],
    });
    assert.equal(held.status, 'accepted');
    assert.equal(held.heldSale.wholesale, true);
    assert.equal(held.heldSale.lines[0]?.unitPriceMinor, 7500);
    const snapshot = await app.inject({
      method: 'GET',
      url: `/v1/stores/${storeId}/snapshot`,
      headers: { authorization: 'Bearer owner' },
    });
    const body = snapshot.json();
    assert.equal(body.heldSales.length, 1);
    assert.equal(body.items.find((item: { id: string }) => item.id === itemId).stockQty, 6);
    const discarded = await send(app, storeId, 'heldSale.discard', { id: heldId });
    assert.equal(discarded.heldSale.removed, true);
  });

  it('pins at most 12 quick-sale items', async () => {
    const app = createApp(
      {
        checkHealth: new CheckHealth({ ping: async () => true }),
        cloudAccess: { requireCloud: async () => {} },
        catalog: new CatalogService(new MemoryCatalogRepository()),
        accessTokens: { verify: async (token: string) => token },
        disconnect: async () => {},
      },
      { logger: false },
    );
    const storeId = randomUUID();
    await app.inject({
      method: 'POST',
      url: '/v1/stores',
      headers: { authorization: 'Bearer owner' },
      payload: { id: storeId, name: 'Morning Star', deviceId: 'device-1' },
    });
    const ids: string[] = [];
    for (let index = 0; index < 13; index += 1) {
      const id = randomUUID();
      ids.push(id);
      const created = await send(app, storeId, 'item.create', {
        id,
        itemType: 'SERVICE',
        name: `Service ${index}`,
        salePriceMinor: 1000,
      });
      assert.equal(created.status, 'accepted');
      const pinned = await send(app, storeId, 'item.pin', {
        id,
        baseRevision: created.item.revision,
        pinned: true,
      });
      if (index < 12) {
        assert.equal(pinned.status, 'accepted');
        assert.equal(pinned.item.quickSaleRank, index + 1);
      } else {
        assert.equal(pinned.code, 'validation_error');
      }
    }
  });

  it('lists each open due and each low item without inventing a quantity', () => {
    const dues = collectionRows(
      [
        { id: 'a', active: true, contactName: 'Aye', dueMinor: 1500, effectiveDate: '2026-11-20' },
        { id: 'b', active: true, contactName: 'Ko', dueMinor: 0, effectiveDate: '2026-10-01' },
        { id: 'c', active: false, contactName: 'Hla', dueMinor: 900, effectiveDate: '2026-10-01' },
      ],
      '2026-11-26',
    );
    assert.deepEqual(dues, [{ id: 'a', name: 'Aye', dueMinor: 1500, ageDays: 6 }]);
    const rows = reorderRows([
      {
        id: 'rice',
        name: 'Rice',
        active: true,
        itemType: 'PRODUCT',
        stockQty: 2,
        lowStockLevel: 5,
        purchaseCostMinor: 1500,
      },
      {
        id: 'oil',
        name: 'Oil',
        active: true,
        itemType: 'PRODUCT',
        stockQty: 8,
        lowStockLevel: 3,
        purchaseCostMinor: 2000,
      },
    ]);
    assert.deepEqual(rows, [{ id: 'rice', name: 'Rice', onHand: 2, lastCostMinor: 1500 }]);
  });
});

async function send(
  app: { inject: (options: { method: string; url: string; headers: Record<string, string>; payload: unknown }) => Promise<{ json: () => { results: Array<never> } }> },
  storeId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/commands',
    headers: { authorization: 'Bearer owner' },
    payload: { commands: [{ id: randomUUID(), storeId, deviceId: 'device-1', type, payload }] },
  });
  return response.json().results[0] as unknown as {
    status: string;
    code: string | null;
    item: { stockQty: number | null; revision: number; quickSaleRank: number | null };
    heldSale: { wholesale: boolean; removed: boolean; lines: Array<{ unitPriceMinor: number }> };
  };
}

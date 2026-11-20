import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { CheckHealth } from '../src/modules/health/application/check-health.js';
import { CatalogService } from '../src/modules/catalog/application/catalog-service.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/infrastructure/memory-catalog-repository.js';
import { createApp } from '../src/infrastructure/http/create-app.js';

describe('sales', () => {
  it('sells stock, rejects an overpayment, and returns one unit', async () => {
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
      .categories.find(
        (category: { kind: string; name: string }) => category.kind === 'ITEM' && category.name === 'Grocery',
      ).id as string;
    const unitId = randomUUID();
    await send(app, storeId, 'unit.create', { id: unitId, name: 'kg' });
    const itemId = randomUUID();
    await send(app, storeId, 'item.create', {
      id: itemId,
      itemType: 'PRODUCT',
      name: 'Rice 5 kg',
      unitId,
      categoryId,
      salePriceMinor: 8000,
      purchaseCostMinor: 7000,
      stockQty: 6,
      lowStockLevel: 1,
      openingMovementId: randomUUID(),
      openingBatchId: randomUUID(),
      effectiveDate: '2026-11-01',
    });
    const saleId = randomUUID();
    const sold = await send(app, storeId, 'sale.create', {
      id: saleId,
      number: 'INV-014',
      contactName: 'Ma Hla',
      effectiveDate: '2026-11-14',
      discountMode: 'AMOUNT',
      discountValue: 0,
      taxMode: 'AMOUNT',
      taxValue: 0,
      deliveryMinor: 0,
      receivedMinor: 16000,
      paymentMethodName: 'Cash',
      accountName: 'Cash drawer',
      paymentId: randomUUID(),
      cashMovementId: randomUUID(),
      note: 'Deliver before noon.',
      lines: [
        {
          id: randomUUID(),
          itemId,
          qty: 2,
          unitPriceMinor: 8000,
          movementId: randomUUID(),
        },
      ],
    });
    const sale = sold.sale;
    if (!sale) {
      throw new Error('sale missing');
    }
    assert.equal(sale.netMinor, 16000);
    assert.equal(sale.costMinor, 14000);
    assert.equal(sale.dueMinor, 0);
    assert.equal(sale.lines[0]?.itemName, 'Rice 5 kg');

    const tooMuch = await send(app, storeId, 'sale.create', {
      id: randomUUID(),
      number: 'INV-015',
      contactName: 'Ko Aung',
      effectiveDate: '2026-11-14',
      discountMode: 'AMOUNT',
      discountValue: 0,
      taxMode: 'AMOUNT',
      taxValue: 0,
      deliveryMinor: 0,
      receivedMinor: 9000,
      paymentMethodName: 'Cash',
      accountName: 'Cash drawer',
      paymentId: randomUUID(),
      cashMovementId: randomUUID(),
      lines: [
        {
          id: randomUUID(),
          itemId,
          qty: 1,
          unitPriceMinor: 8000,
          movementId: randomUUID(),
        },
      ],
    });
    assert.equal(tooMuch.code, 'validation_error');

    const snapshot = await app.inject({
      method: 'GET',
      url: `/v1/stores/${storeId}/snapshot`,
      headers: { authorization: 'Bearer owner' },
    });
    assert.equal(snapshot.json().sales.length, 1);
    assert.equal(snapshot.json().items.find((item: { id: string }) => item.id === itemId).stockQty, 4);

    const report = await app.inject({
      method: 'GET',
      url: `/v1/stores/${storeId}/reports?from=2026-11-14&to=2026-11-14`,
      headers: { authorization: 'Bearer owner' },
    });
    assert.equal(report.json().sales.count, 1);
    assert.equal(report.json().sales.grossMinor, 16000);
    assert.equal(report.json().sales.profitMinor, 2000);

    const returned = await send(app, storeId, 'sale.return', {
      id: randomUUID(),
      saleId,
      effectiveDate: '2026-11-14',
      accountName: 'Cash drawer',
      paymentMethodName: 'Cash',
      cashMovementId: randomUUID(),
      note: 'Customer changed their mind.',
      lines: [
        {
          lineId: sale.lines[0]?.id,
          qty: 1,
          movementId: randomUUID(),
          batchId: randomUUID(),
        },
      ],
    });
    const credit = returned.sale;
    const refund = returned.cashMovements;
    if (!credit || !refund) {
      throw new Error('return missing');
    }
    assert.equal(credit.returns[0]?.refundMinor, 8000);
    assert.equal(refund[0]?.source, 'REFUND');

    const again = await send(app, storeId, 'sale.return', {
      id: randomUUID(),
      saleId,
      baseRevision: credit.revision,
      effectiveDate: '2026-11-14',
      accountName: 'Cash drawer',
      paymentMethodName: 'Cash',
      cashMovementId: randomUUID(),
      lines: [
        {
          lineId: sale.lines[0]?.id,
          qty: 2,
          movementId: randomUUID(),
          batchId: randomUUID(),
        },
      ],
    });
    assert.equal(again.code, 'validation_error');

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
            type: 'sale.create',
            payload: { id: randomUUID() },
          },
        ],
      },
    });
    assert.equal(stranger.statusCode, 403);
  });

  it('marks the original sale movement reversed when the sale is removed', async () => {
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
      .categories.find(
        (category: { kind: string; name: string }) => category.kind === 'ITEM' && category.name === 'Grocery',
      ).id as string;
    const unitId = randomUUID();
    await send(app, storeId, 'unit.create', { id: unitId, name: 'kg' });
    const itemId = randomUUID();
    await send(app, storeId, 'item.create', {
      id: itemId,
      itemType: 'PRODUCT',
      name: 'Rice 5 kg',
      unitId,
      categoryId,
      salePriceMinor: 8000,
      purchaseCostMinor: 7000,
      stockQty: 6,
      lowStockLevel: 1,
      openingMovementId: randomUUID(),
      openingBatchId: randomUUID(),
      effectiveDate: '2026-11-01',
    });
    const saleId = randomUUID();
    const sold = await send(app, storeId, 'sale.create', {
      id: saleId,
      number: 'INV-014',
      contactName: 'Ma Hla',
      effectiveDate: '2026-11-14',
      discountMode: 'AMOUNT',
      discountValue: 0,
      taxMode: 'AMOUNT',
      taxValue: 0,
      deliveryMinor: 0,
      receivedMinor: 0,
      paymentMethodName: 'Cash',
      accountName: 'Cash drawer',
      note: '',
      lines: [
        {
          id: randomUUID(),
          itemId,
          qty: 2,
          unitPriceMinor: 8000,
          movementId: randomUUID(),
        },
      ],
    });
    const removed = await send(app, storeId, 'sale.deactivate', {
      id: saleId,
      baseRevision: sold.sale?.revision,
    });
    assert.equal(removed.code, null);

    const snapshot = await app.inject({
      method: 'GET',
      url: `/v1/stores/${storeId}/snapshot`,
      headers: { authorization: 'Bearer owner' },
    });
    const movements = snapshot
      .json()
      .movements.filter(
        (row: { itemId: string; reference: string }) => row.itemId === itemId && row.reference === 'INV-014',
      );
    assert.equal(movements.length, 1);
    assert.equal(movements[0].movementType, 'SALE');
    assert.equal(movements[0].status, 'REVERSED');
    assert.equal(snapshot.json().items.find((item: { id: string }) => item.id === itemId).stockQty, 6);
  });
});

async function send(
  app: ReturnType<typeof createApp>,
  storeId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<{
  code?: string;
  sale?: {
    revision: number;
    netMinor: number;
    costMinor: number;
    dueMinor: number;
    lines: Array<{ id: string; itemName: string }>;
    returns: Array<{ refundMinor: number }>;
  };
  cashMovements?: Array<{ source: string }>;
}> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/commands',
    headers: { authorization: 'Bearer owner' },
    payload: {
      commands: [{ id: randomUUID(), storeId, deviceId: 'device-1', type, payload }],
    },
  });
  return response.json().results[0] as {
    code?: string;
    sale?: {
      revision: number;
      netMinor: number;
      costMinor: number;
      dueMinor: number;
      lines: Array<{ id: string; itemName: string }>;
      returns: Array<{ refundMinor: number }>;
    };
    cashMovements?: Array<{ source: string }>;
  };
}

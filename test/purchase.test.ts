import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { CheckHealth } from '../src/modules/health/application/check-health.js';
import { CatalogService } from '../src/modules/catalog/application/catalog-service.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/infrastructure/memory-catalog-repository.js';
import { createApp } from '../src/infrastructure/http/create-app.js';

describe('purchases', () => {
  it('receives stock, rejects an overpayment, and returns one unit for a refund', async () => {
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
    await send(app, storeId, 'unit.create', { id: unitId, name: 'kg' });
    const itemId = randomUUID();
    await send(app, storeId, 'item.create', {
      id: itemId,
      itemType: 'PRODUCT',
      name: 'Rice 50 kg',
      unitId,
      categoryId,
      salePriceMinor: 8000,
      purchaseCostMinor: 7000,
      stockQty: 0,
      lowStockLevel: 1,
    });
    const purchaseId = randomUUID();
    const bought = await send(app, storeId, 'purchase.create', {
      id: purchaseId,
      number: 'BILL-022',
      supplierName: 'Daw Khin Wholesale',
      effectiveDate: '2026-11-14',
      discountMode: 'AMOUNT',
      discountValue: 0,
      taxMode: 'AMOUNT',
      taxValue: 0,
      shippingMinor: 5000,
      paidMinor: 70000,
      paymentMethodName: 'Bank transfer',
      accountName: 'Cash drawer',
      paymentId: randomUUID(),
      cashMovementId: randomUUID(),
      lines: [{ id: randomUUID(), itemId, qty: 10, unitCostMinor: 7000, movementId: randomUUID(), batchId: randomUUID() }],
    });
    const bill = bought.purchase;
    if (!bill) {
      throw new Error('purchase missing');
    }
    assert.equal(bill.netMinor, 75000);
    assert.equal(bill.dueMinor, 5000);
    assert.equal(bill.lines[0]?.itemName, 'Rice 50 kg');

    const tooMuch = await send(app, storeId, 'purchase.create', {
      id: randomUUID(),
      number: 'BILL-023',
      supplierName: 'U Myat Supply',
      effectiveDate: '2026-11-14',
      discountMode: 'AMOUNT',
      discountValue: 0,
      taxMode: 'AMOUNT',
      taxValue: 0,
      shippingMinor: 0,
      paidMinor: 8000,
      paymentMethodName: 'Cash',
      accountName: 'Cash drawer',
      paymentId: randomUUID(),
      cashMovementId: randomUUID(),
      lines: [{ id: randomUUID(), itemId, qty: 1, unitCostMinor: 7000, movementId: randomUUID(), batchId: randomUUID() }],
    });
    assert.equal(tooMuch.code, 'validation_error');

    const snapshot = await app.inject({
      method: 'GET',
      url: `/v1/stores/${storeId}/snapshot`,
      headers: { authorization: 'Bearer owner' },
    });
    assert.equal(snapshot.json().purchases.length, 1);
    assert.equal(snapshot.json().items.find((item: { id: string }) => item.id === itemId).stockQty, 10);

    const report = await app.inject({
      method: 'GET',
      url: `/v1/stores/${storeId}/reports?from=2026-11-14&to=2026-11-14`,
      headers: { authorization: 'Bearer owner' },
    });
    assert.equal(report.json().purchases.count, 1);
    assert.equal(report.json().purchases.netMinor, 75000);
    assert.equal(report.json().purchases.paidMinor, 70000);
    assert.equal(report.json().purchases.dueMinor, 5000);

    const returned = await send(app, storeId, 'purchase.return', {
      id: randomUUID(),
      purchaseId,
      settlement: 'REFUND',
      effectiveDate: '2026-11-14',
      accountName: 'Cash drawer',
      paymentMethodName: 'Cash',
      cashMovementId: randomUUID(),
      lines: [{ lineId: bill.lines[0]?.id, qty: 2, movementId: randomUUID() }],
    });
    const credit = returned.purchase;
    const refund = returned.cashMovements;
    if (!credit || !refund?.[0]) {
      throw new Error('return missing');
    }
    assert.equal(credit.returns[0]?.amountMinor, 14000);
    assert.equal(refund[0].direction, 'IN');
    assert.equal(refund[0].source, 'REFUND');

    const stranger = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer stranger' },
      payload: {
        commands: [{ id: randomUUID(), storeId, deviceId: 'device-2', type: 'purchase.create', payload: { id: randomUUID() } }],
      },
    });
    assert.equal(stranger.statusCode, 403);
  });
});

async function send(
  app: ReturnType<typeof createApp>,
  storeId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<{
  code?: string;
  purchase?: {
    netMinor: number;
    dueMinor: number;
    lines: Array<{ id: string; itemName: string }>;
    returns: Array<{ amountMinor: number }>;
  };
  cashMovements?: Array<{ direction: string; source: string }>;
}> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/commands',
    headers: { authorization: 'Bearer owner' },
    payload: { commands: [{ id: randomUUID(), storeId, deviceId: 'device-1', type, payload }] },
  });
  return response.json().results[0] as {
    code?: string;
    purchase?: {
      netMinor: number;
      dueMinor: number;
      lines: Array<{ id: string; itemName: string }>;
      returns: Array<{ amountMinor: number }>;
    };
    cashMovements?: Array<{ direction: string; source: string }>;
  };
}

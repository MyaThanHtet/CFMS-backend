import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { CheckHealth } from '../src/modules/health/application/check-health.js';
import { CatalogService } from '../src/modules/catalog/application/catalog-service.js';
import { itemReport, profitAndLoss, saleReport, type SaleDocument } from '../src/modules/catalog/domain/report.js';
import type { PublicCashMovement } from '../src/modules/catalog/domain/cash.js';
import type { PublicExpense } from '../src/modules/catalog/domain/expense.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/infrastructure/memory-catalog-repository.js';
import { createApp } from '../src/infrastructure/http/create-app.js';

describe('reports', () => {
  it('sums active sales in the period and leaves a new shop at zero', async () => {
    const today: SaleDocument = {
      id: 'sale-1',
      number: 'INV-014',
      contactName: 'Ma Hla',
      effectiveDate: '2026-11-14',
      grossMinor: 50_000,
      discountMinor: 5_000,
      netMinor: 45_000,
      costMinor: 28_000,
      receivedMinor: 45_000,
      dueMinor: 0,
      status: 'ACTIVE',
      lines: [
        {
          itemName: 'Rice 5 kg',
          qty: 2,
          amountMinor: 16_000,
          costMinor: 14_000,
          occurredAt: '2026-11-14T04:00:00.000Z',
          contactName: 'Ma Hla',
          reference: 'INV-014',
        },
      ],
    };
    const voided: SaleDocument = { ...today, id: 'sale-void', number: 'INV-001', status: 'VOID' };
    const older: SaleDocument = { ...today, id: 'sale-old', number: 'INV-002', effectiveDate: '2026-11-01' };
    const reported = saleReport([today, voided, older], '2026-11-14', '2026-11-14', 'hla');
    assert.equal(reported.count, 1);
    assert.equal(reported.grossMinor, 50_000);
    assert.equal(reported.discountMinor, 5_000);
    assert.equal(reported.netMinor, 45_000);
    assert.equal(reported.profitMinor, 17_000);
    assert.equal(reported.dueMinor, 0);

    const items = itemReport([today], '2026-11-14', '2026-11-14');
    assert.equal(items.qty, 2);
    assert.equal(items.revenueMinor, 16_000);
    assert.equal(items.profitMinor, 2_000);

    const rent: PublicExpense = {
      id: 'rent',
      storeId: 'store',
      title: 'Shop rent',
      categoryId: 'rent-cat',
      categoryName: 'Rent',
      amountMinor: 50_000,
      accountName: 'Cash drawer',
      paymentMethodName: 'Cash',
      effectiveDate: '2026-11-14',
      note: '',
      status: 'PAID',
      actorName: 'Aung Min',
      isActive: true,
      revision: 1,
    };
    const scrap: PublicCashMovement = {
      id: 'scrap',
      storeId: 'store',
      accountId: 'drawer',
      direction: 'IN',
      amountMinor: 15_000,
      source: 'INCOME',
      description: 'Scrap sale',
      sourceReference: 'Other income',
      occurredAt: '2026-11-14T02:00:00.000Z',
      effectiveDate: '2026-11-14',
      categoryId: null,
      categoryName: 'Other income',
      paymentMethodName: 'Cash',
      note: '',
      linkedExpenseId: null,
      transferGroupId: null,
      status: 'ACTIVE',
      revision: 1,
    };
    const statement = profitAndLoss([today, voided], [rent], '2026-11-14', '2026-11-14', [scrap]);
    assert.equal(statement.salesNetMinor, 45_000);
    assert.equal(statement.costMinor, 28_000);
    assert.equal(statement.grossProfitMinor, 17_000);
    assert.equal(statement.otherIncomeMinor, 15_000);
    assert.equal(statement.expenseMinor, 50_000);
    assert.equal(statement.netProfitMinor, 17_000 + 15_000 - 50_000);
    assert.deepEqual(statement.expensesByCategory, [{ name: 'Rent', amountMinor: 50_000 }]);

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
    await app.inject({
      method: 'POST',
      url: '/v1/stores',
      headers: { authorization: 'Bearer owner' },
      payload: { id: storeId, name: 'Morning Star', deviceId: 'device-1' },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/stores/${storeId}/reports?from=2026-11-14&to=2026-11-14`,
      headers: { authorization: 'Bearer owner' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.sales.count, 0);
    assert.equal(body.purchases.count, 0);
    assert.equal(body.items.count, 0);
    assert.equal(body.stock.valueMinor, 0);
    assert.equal(body.profit.netProfitMinor, 0);
    assert.equal(body.cash.netMinor, 0);

    const stranger = await app.inject({
      method: 'GET',
      url: `/v1/stores/${storeId}/reports?from=2026-11-14&to=2026-11-14`,
      headers: { authorization: 'Bearer stranger' },
    });
    assert.equal(stranger.statusCode, 403);
    await app.close();
  });
});

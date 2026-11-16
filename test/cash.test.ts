import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { CheckHealth } from '../src/modules/health/application/check-health.js';
import { CatalogService } from '../src/modules/catalog/application/catalog-service.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/infrastructure/memory-catalog-repository.js';
import { createApp } from '../src/infrastructure/http/create-app.js';

describe('cash', () => {
  it('keeps a ledger of accounts, transfers, and counts', async () => {
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
    const shop = createdShop.json();
    const drawer = shop.accounts[0] as { id: string; name: string };
    assert.equal(drawer.name, 'Cash drawer');
    const incomeId = shop.categories.find(
      (category: { kind: string; name: string }) => category.kind === 'INCOME' && category.name === 'Other income',
    ).id as string;

    const bankId = randomUUID();
    const bank = await send(app, storeId, 'account.create', {
      id: bankId,
      name: 'KBZ Bank',
      accountType: 'BANK',
      openingMinor: 1_000_000,
      openingMovementId: randomUUID(),
      effectiveDate: '2026-11-01',
    });
    assert.equal(bank.status, 'accepted');
    assert.equal(bank.account?.openingMinor, 1_000_000);

    const received = await send(app, storeId, 'cash.in', {
      id: randomUUID(),
      movementId: randomUUID(),
      accountId: drawer.id,
      title: 'Owner top up',
      categoryId: incomeId,
      amountMinor: 45_000,
      paymentMethodName: 'Cash',
      effectiveDate: '2026-11-14',
      note: '',
    });
    assert.equal(received.status, 'accepted');
    assert.equal(received.cashMovements?.[0]?.direction, 'IN');

    const zero = await send(app, storeId, 'cash.in', {
      id: randomUUID(),
      movementId: randomUUID(),
      accountId: drawer.id,
      title: 'Nothing',
      amountMinor: 0,
      paymentMethodName: 'Cash',
      effectiveDate: '2026-11-14',
    });
    assert.equal(zero.code, 'validation_error');

    const same = await send(app, storeId, 'cash.transfer', {
      id: randomUUID(),
      fromAccountId: drawer.id,
      toAccountId: drawer.id,
      amountMinor: 1000,
      feeMinor: 0,
      effectiveDate: '2026-11-14',
      outMovementId: randomUUID(),
      inMovementId: randomUUID(),
    });
    assert.equal(same.code, 'validation_error');

    const moved = await send(app, storeId, 'cash.transfer', {
      id: randomUUID(),
      fromAccountId: drawer.id,
      toAccountId: bankId,
      amountMinor: 40_000,
      feeMinor: 500,
      effectiveDate: '2026-11-14',
      outMovementId: randomUUID(),
      inMovementId: randomUUID(),
      feeExpenseId: randomUUID(),
    });
    assert.equal(moved.status, 'accepted');
    assert.equal(moved.cashMovements?.length, 2);
    assert.equal(moved.expense?.title, 'Transfer fee');
    assert.equal(moved.expense?.amountMinor, 500);

    const expenseId = randomUUID();
    await send(app, storeId, 'expense.create', {
      id: expenseId,
      title: 'Shop rent',
      amountMinor: 50_000,
      accountName: 'Cash drawer',
      paymentMethodName: 'Cash',
      effectiveDate: '2026-11-14',
    });
    const linked = await send(app, storeId, 'cash.out', {
      id: randomUUID(),
      movementId: randomUUID(),
      accountId: drawer.id,
      outflowType: 'EXPENSE',
      expenseId,
      amountMinor: 50_000,
      paymentMethodName: 'Cash',
      effectiveDate: '2026-11-14',
    });
    assert.equal(linked.status, 'accepted');
    const twice = await send(app, storeId, 'cash.out', {
      id: randomUUID(),
      movementId: randomUUID(),
      accountId: drawer.id,
      outflowType: 'EXPENSE',
      expenseId,
      amountMinor: 50_000,
      paymentMethodName: 'Cash',
      effectiveDate: '2026-11-14',
    });
    assert.equal(twice.code, 'already_linked');

    const snapshot = await app.inject({
      method: 'GET',
      url: `/v1/stores/${storeId}/snapshot`,
      headers: { authorization: 'Bearer owner' },
    });
    const body = snapshot.json();
    const before = balance(body, 'Cash drawer');
    const counted = await send(app, storeId, 'cash.reconcile', {
      id: randomUUID(),
      accountId: drawer.id,
      cutoffAt: '2026-11-14T18:00:00.000Z',
      countedMinor: 0,
      note: 'Counted',
    });
    assert.equal(counted.status, 'accepted');
    assert.equal(counted.reconciliation?.systemBalanceMinor, before);
    assert.equal(counted.cashMovements?.length ?? 0, 0);

    const after = await app.inject({
      method: 'GET',
      url: `/v1/stores/${storeId}/snapshot`,
      headers: { authorization: 'Bearer owner' },
    });
    assert.equal(balance(after.json(), 'Cash drawer'), before);
    assert.equal(balance(after.json(), 'KBZ Bank'), 1_040_000);

    const outsider = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: 'Bearer stranger' },
      payload: {
        commands: [{
          id: randomUUID(),
          storeId,
          deviceId: 'device-2',
          type: 'cash.in',
          payload: {
            id: randomUUID(),
            movementId: randomUUID(),
            accountId: drawer.id,
            title: 'Nope',
            amountMinor: 1,
            paymentMethodName: 'Cash',
            effectiveDate: '2026-11-14',
          },
        }],
      },
    });
    assert.equal(outsider.statusCode, 403);
    await app.close();
  });
});

function balance(snapshot: {
  accounts: Array<{ id: string; name: string }>;
  cashMovements: Array<{ accountId: string; direction: string; amountMinor: number; status: string; linkedExpenseId: string | null }>;
  expenses: Array<{ id: string; accountName: string; amountMinor: number; status: string; isActive: boolean }>;
}, name: string): number {
  const account = snapshot.accounts.find((row) => row.name === name);
  if (!account) {
    return 0;
  }
  const linked = new Set(
    snapshot.cashMovements.filter((row) => row.status === 'ACTIVE' && row.linkedExpenseId).map((row) => row.linkedExpenseId),
  );
  let total = 0;
  for (const row of snapshot.cashMovements) {
    if (row.accountId !== account.id || row.status !== 'ACTIVE') {
      continue;
    }
    total += row.direction === 'IN' ? row.amountMinor : -row.amountMinor;
  }
  for (const expense of snapshot.expenses) {
    if (!expense.isActive || expense.status !== 'PAID' || expense.accountName !== name || linked.has(expense.id)) {
      continue;
    }
    total -= expense.amountMinor;
  }
  return total;
}

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
    account: { openingMinor: number } | null;
    cashMovements: Array<{ direction: string }> | null;
    reconciliation: { systemBalanceMinor: number } | null;
    expense: { title: string; amountMinor: number } | null;
  };
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parseImportedShop } from '../src/modules/catalog/domain/import-backup.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('imported shop backup', () => {
  it('keeps Mya Electronic records and gives the shop a server id', () => {
    const raw = JSON.parse(
      readFileSync(resolve('..', 'cfms-mobile/demo/mya-electronic-backup.json'), 'utf8'),
    ) as { tables: unknown };
    let sequence = 0;
    const shop = parseImportedShop(raw.tables, {
      actorUserId: 'owner',
      deviceId: 'phone',
      now: new Date('2026-11-27T00:00:00.000Z'),
      nextId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    });
    assert.equal(shop.store.name, 'Mya Electronic');
    assert.match(shop.store.id, uuid);
    assert.equal(shop.store.id, shop.ids['store-mya-electronic']);
    assert.equal(shop.items.length, 23);
    assert.equal(shop.sales.length, 9);
    assert.equal(shop.purchases.length, 3);
    const panel = shop.items.find((item) => item.name === 'Longi 550W Solar Panel');
    const invoice = shop.sales.find((sale) => sale.number === 'INV-1043');
    assert.equal(invoice?.dueMinor, 600000);
    assert.equal(invoice?.lines[0]?.itemId, panel?.id);
    assert.equal(shop.cashMovements.some((row) => row.source === 'SALE'), true);
    assert.equal(shop.accounts.length, 3);
  });
});

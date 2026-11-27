import { randomUUID } from 'node:crypto';
import { CatalogError } from './catalog-error.js';
import type { CategoryRecord } from './category.js';
import type { ContactRecord } from './contact.js';
import type { CashAccountRecord, CashMovementRecord, ReconciliationRecord } from './cash.js';
import type { ExpenseRecord } from './expense.js';
import type { BatchRecord, ItemRecord, MovementRecord, UnitRecord } from './item.js';
import type { PurchaseRecord } from './purchase.js';
import type { SaleRecord } from './sale.js';
import type { PaymentMethodRecord } from './shop-settings.js';
import type { StoreRecord } from '../application/ports.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tableNames = [
  'stores',
  'payment_methods',
  'categories',
  'contacts',
  'units',
  'items',
  'stock_movements',
  'cost_batches',
  'expenses',
  'cash_accounts',
  'cash_movements',
  'cash_reconciliations',
  'sale_documents',
  'purchase_documents',
] as const;

export type ParsedBackup = {
  store: StoreRecord;
  ids: Record<string, string>;
  categories: CategoryRecord[];
  contacts: ContactRecord[];
  units: UnitRecord[];
  items: ItemRecord[];
  movements: MovementRecord[];
  batches: BatchRecord[];
  expenses: ExpenseRecord[];
  accounts: CashAccountRecord[];
  cashMovements: CashMovementRecord[];
  reconciliations: ReconciliationRecord[];
  sales: SaleRecord[];
  purchases: PurchaseRecord[];
  paymentMethods: PaymentMethodRecord[];
};

export function parseImportedShop(
  tables: unknown,
  input: { actorUserId: string; deviceId: string; now: Date; nextId?: () => string },
): ParsedBackup {
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
    throw new CatalogError('validation_error', 'This backup file cannot be read.', 400);
  }
  const source = tables as Record<string, unknown>;
  const nextId = input.nextId ?? randomUUID;
  const ids = new Map<string, string>();
  for (const name of tableNames) {
    for (const row of list(source[name])) {
      const id = text(row.id);
      if (!id || ids.has(id)) {
        continue;
      }
      ids.set(id, uuidPattern.test(id) ? id : nextId());
    }
  }
  const rewritten = rewrite(source, ids) as Record<string, unknown>;
  const stores = list(rewritten.stores);
  const shop = stores[0];
  if (!shop) {
    throw new CatalogError('validation_error', 'This backup has no shop.', 400);
  }
  const storeId = text(shop.id);
  const name = clean(shop.name, 120);
  if (!storeId || !name) {
    throw new CatalogError('validation_error', 'This backup has no shop.', 400);
  }
  const actor = input.actorUserId;
  const deviceId = input.deviceId;
  const now = input.now;
  const stamp = { createdBy: actor, updatedBy: actor, deviceId, createdAt: now, updatedAt: now };
  return {
    store: {
      id: storeId,
      name,
      address: optional(shop.address, 240),
      phone: optional(shop.phone, 40),
      email: optional(shop.email, 120),
      currencyCode: text(shop.currencyCode) || 'MMK',
      currencySymbol: text(shop.currencySymbol) || 'Ks',
      taxName: text(shop.taxName) || 'Commercial tax',
      taxRatePercent: whole(shop.taxRatePercent) ?? 0,
      timezone: text(shop.timezone) || 'Asia/Yangon',
      revision: whole(shop.revision) ?? 1,
      ownerId: actor,
    },
    ids: Object.fromEntries(ids),
    categories: list(rewritten.categories).map((row) => ({
      id: required(row.id, 'category'),
      storeId,
      kind: kind(row.kind),
      name: requiredText(row.name, 80, 'category'),
      normalizedName: normalize(requiredText(row.name, 80, 'category')),
      description: text(row.description) ?? '',
      isActive: flag(row.isActive, true),
      sortOrder: whole(row.sortOrder) ?? 0,
      revision: whole(row.revision) ?? 1,
      ...stamp,
    })),
    contacts: list(rewritten.contacts).map((row) => ({
      id: required(row.id, 'contact'),
      storeId,
      contactType: row.contactType === 'SUPPLIER' ? 'SUPPLIER' : 'CUSTOMER',
      name: requiredText(row.name, 80, 'contact'),
      normalizedName: normalize(requiredText(row.name, 80, 'contact')),
      categoryId: optional(row.categoryId, 80),
      categoryName: optional(row.categoryName, 80),
      phone: text(row.phone) ?? '',
      email: text(row.email) ?? '',
      address: text(row.address) ?? '',
      creditLimitMinor: whole(row.creditLimitMinor) ?? 0,
      openingReceivableMinor: whole(row.openingReceivableMinor) ?? 0,
      openingPayableMinor: whole(row.openingPayableMinor) ?? 0,
      collectedMinor: whole(row.collectedMinor) ?? 0,
      paidMinor: whole(row.paidMinor) ?? 0,
      receivableMinor: whole(row.receivableMinor) ?? 0,
      payableMinor: whole(row.payableMinor) ?? 0,
      receivableAsOf: optional(row.receivableAsOf, 40),
      receivableNote: text(row.receivableNote) ?? '',
      payableAsOf: optional(row.payableAsOf, 40),
      payableNote: text(row.payableNote) ?? '',
      settlements: array(row.settlements ?? jsonValue(row.settlementsJson)) as ContactRecord['settlements'],
      isActive: flag(row.isActive, true),
      revision: whole(row.revision) ?? 1,
      ...stamp,
    })),
    units: list(rewritten.units).map((row) => ({
      id: required(row.id, 'unit'),
      storeId,
      name: requiredText(row.name, 40, 'unit'),
      normalizedName: normalize(requiredText(row.name, 40, 'unit')),
      isActive: flag(row.isActive, true),
      revision: whole(row.revision) ?? 1,
      ...stamp,
    })),
    items: list(rewritten.items).map((row) => ({
      id: required(row.id, 'item'),
      storeId,
      itemType: row.itemType === 'SERVICE' ? 'SERVICE' : 'PRODUCT',
      name: requiredText(row.name, 120, 'item'),
      normalizedName: normalize(requiredText(row.name, 120, 'item')),
      sku: text(row.sku) ?? '',
      normalizedSku: normalize(text(row.sku) ?? ''),
      unitId: optional(row.unitId, 80),
      unitName: optional(row.unitName, 40),
      categoryId: optional(row.categoryId, 80),
      categoryName: optional(row.categoryName, 80),
      salePriceMinor: whole(row.salePriceMinor) ?? 0,
      wholesalePriceMinor: whole(row.wholesalePriceMinor),
      purchaseCostMinor: whole(row.purchaseCostMinor),
      stockQty: whole(row.stockQty),
      lowStockLevel: whole(row.lowStockLevel),
      quickSaleRank: whole(row.quickSaleRank),
      isActive: flag(row.isActive, true),
      revision: whole(row.revision) ?? 1,
      ...stamp,
    })),
    movements: list(rewritten.stock_movements).map((row) => ({
      id: required(row.id, 'stock movement'),
      storeId,
      itemId: required(row.itemId, 'stock movement'),
      movementType: movementType(row.movementType),
      quantityChange: whole(row.quantityChange) ?? 0,
      onHandAfter: whole(row.onHandAfter) ?? 0,
      reference: text(row.reference) ?? '',
      occurredAt: text(row.occurredAt) ?? now.toISOString(),
      actorName: text(row.actorName) ?? '',
      status: row.status === 'REVERSED' ? 'REVERSED' : 'ACTIVE',
      revision: whole(row.revision) ?? 1,
      createdAt: now,
    })),
    batches: list(rewritten.cost_batches).map((row) => ({
      id: required(row.id, 'cost batch'),
      storeId,
      itemId: required(row.itemId, 'cost batch'),
      receivedOn: text(row.receivedOn) ?? '',
      source: batchSource(row.source),
      sourceReference: text(row.sourceReference) ?? '',
      unitCostMinor: whole(row.unitCostMinor) ?? 0,
      receivedQty: whole(row.receivedQty) ?? 0,
      remainingQty: whole(row.remainingQty) ?? 0,
      revision: whole(row.revision) ?? 1,
      createdAt: now,
    })),
    expenses: list(rewritten.expenses).map((row) => ({
      id: required(row.id, 'expense'),
      storeId,
      title: requiredText(row.title, 120, 'expense'),
      categoryId: optional(row.categoryId, 80),
      categoryName: optional(row.categoryName, 80),
      amountMinor: whole(row.amountMinor) ?? 0,
      accountName: text(row.accountName) ?? '',
      paymentMethodName: text(row.paymentMethodName) ?? '',
      effectiveDate: text(row.effectiveDate) ?? '',
      note: text(row.note) ?? '',
      receiptImage: text(row.receiptImage) ?? '',
      status: row.status === 'VOID' ? 'VOID' : 'PAID',
      actorName: text(row.actorName) ?? '',
      isActive: flag(row.isActive, true),
      revision: whole(row.revision) ?? 1,
      ...stamp,
    })),
    accounts: list(rewritten.cash_accounts).map((row) => ({
      id: required(row.id, 'cash account'),
      storeId,
      name: requiredText(row.name, 80, 'cash account'),
      normalizedName: normalize(requiredText(row.name, 80, 'cash account')),
      accountType: accountType(row.accountType),
      openingMinor: whole(row.openingMinor) ?? 0,
      isActive: flag(row.isActive, true),
      revision: whole(row.revision) ?? 1,
      ...stamp,
    })),
    cashMovements: list(rewritten.cash_movements).map((row) => ({
      id: required(row.id, 'cash movement'),
      storeId,
      accountId: required(row.accountId, 'cash movement'),
      direction: row.direction === 'OUT' ? 'OUT' : 'IN',
      amountMinor: whole(row.amountMinor) ?? 0,
      source: cashSource(row.source),
      description: text(row.description) ?? '',
      sourceReference: text(row.sourceReference) ?? '',
      occurredAt: text(row.occurredAt) ?? now.toISOString(),
      effectiveDate: text(row.effectiveDate) ?? '',
      categoryId: optional(row.categoryId, 80),
      categoryName: optional(row.categoryName, 80),
      paymentMethodName: text(row.paymentMethodName) ?? '',
      note: text(row.note) ?? '',
      linkedExpenseId: optional(row.linkedExpenseId, 80),
      transferGroupId: optional(row.transferGroupId, 80),
      status: row.status === 'REVERSED' ? 'REVERSED' : 'ACTIVE',
      revision: whole(row.revision) ?? 1,
      createdAt: now,
    })),
    reconciliations: list(rewritten.cash_reconciliations).map((row) => ({
      id: required(row.id, 'reconciliation'),
      storeId,
      accountId: required(row.accountId, 'reconciliation'),
      cutoffAt: text(row.cutoffAt) ?? now.toISOString(),
      systemBalanceMinor: whole(row.systemBalanceMinor) ?? 0,
      countedMinor: whole(row.countedMinor) ?? 0,
      note: text(row.note) ?? '',
      revision: whole(row.revision) ?? 1,
      createdBy: actor,
      deviceId,
      createdAt: now,
    })),
    sales: list(rewritten.sale_documents).map((row) => sale(row, storeId, now)),
    purchases: list(rewritten.purchase_documents).map((row) => purchase(row, storeId, now)),
    paymentMethods: list(rewritten.payment_methods).map((row) => ({
      id: required(row.id, 'payment method'),
      storeId,
      name: requiredText(row.name, 40, 'payment method'),
      normalizedName: normalize(requiredText(row.name, 40, 'payment method')),
      accountId: required(row.accountId, 'payment method'),
      accountName: text(row.accountName) ?? '',
      isDefault: flag(row.isDefault, false),
      isActive: flag(row.isActive, true),
      revision: whole(row.revision) ?? 1,
      createdAt: now,
      updatedAt: now,
    })),
  };
}

function sale(row: Record<string, unknown>, storeId: string, now: Date): SaleRecord {
  const document = documentOf(row.linesJson);
  const number = requiredText(row.number, 40, 'sale');
  return {
    id: required(row.id, 'sale'),
    storeId,
    number,
    normalizedNumber: number.toLowerCase(),
    contactName: requiredText(row.contactName, 80, 'sale'),
    effectiveDate: text(row.effectiveDate) ?? '',
    occurredAt: text(document.occurredAt) ?? `${text(row.effectiveDate) ?? ''}T00:00:00.000Z`,
    grossMinor: whole(row.grossMinor) ?? 0,
    discountMinor: whole(row.discountMinor) ?? 0,
    taxMinor: whole(document.taxMinor) ?? whole(row.taxMinor) ?? 0,
    deliveryMinor: whole(document.deliveryMinor) ?? whole(row.deliveryMinor) ?? 0,
    netMinor: whole(row.netMinor) ?? 0,
    costMinor: whole(row.costMinor) ?? 0,
    receivedMinor: whole(row.receivedMinor) ?? 0,
    dueMinor: whole(row.dueMinor) ?? 0,
    note: text(document.note) ?? text(row.note) ?? '',
    isActive: flag(row.isActive, text(row.status) !== 'VOID'),
    revision: whole(row.revision) ?? 1,
    lines: array(document.lines) as SaleRecord['lines'],
    payments: array(document.payments) as SaleRecord['payments'],
    returns: array(document.returns) as SaleRecord['returns'],
    createdAt: now,
    updatedAt: now,
  };
}

function purchase(row: Record<string, unknown>, storeId: string, now: Date): PurchaseRecord {
  const document = documentOf(row.linesJson);
  const number = requiredText(row.number, 40, 'purchase');
  return {
    id: required(row.id, 'purchase'),
    storeId,
    number,
    normalizedNumber: number.toLowerCase(),
    supplierName: requiredText(row.supplierName, 80, 'purchase'),
    effectiveDate: text(row.effectiveDate) ?? '',
    occurredAt: text(document.occurredAt) ?? `${text(row.effectiveDate) ?? ''}T00:00:00.000Z`,
    grossMinor: whole(row.grossMinor) ?? 0,
    discountMinor: whole(row.discountMinor) ?? 0,
    taxMinor: whole(document.taxMinor) ?? 0,
    shippingMinor: whole(document.shippingMinor) ?? 0,
    netMinor: whole(row.netMinor) ?? 0,
    paidMinor: whole(row.paidMinor) ?? 0,
    dueMinor: whole(row.dueMinor) ?? 0,
    note: text(document.note) ?? '',
    isActive: flag(row.isActive, text(row.status) !== 'VOID'),
    revision: whole(row.revision) ?? 1,
    lines: array(document.lines) as PurchaseRecord['lines'],
    payments: array(document.payments) as PurchaseRecord['payments'],
    returns: array(document.returns) as PurchaseRecord['returns'],
    createdAt: now,
    updatedAt: now,
  };
}

function documentOf(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  if (value.length > 2000) {
    throw new CatalogError('validation_error', 'This backup file cannot be read.', 400);
  }
  return value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row));
}

function rewrite(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === 'string') {
    if (ids.has(value)) {
      return ids.get(value);
    }
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 1) {
      const parsed = jsonValue(trimmed);
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify(rewrite(parsed, ids));
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewrite(item, ids));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, ids)]));
  }
  return value;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value ?? null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optional(value: unknown, max: number): string | null {
  const raw = text(value)?.trim() ?? '';
  return raw.length === 0 ? null : raw.slice(0, max);
}

function clean(value: unknown, max: number): string | null {
  const raw = text(value)?.trim().replace(/\s+/g, ' ') ?? '';
  return raw.length === 0 || raw.length > max ? null : raw;
}

function requiredText(value: unknown, max: number, label: string): string {
  const raw = clean(value, max);
  if (!raw) {
    throw new CatalogError('validation_error', `This backup has an invalid ${label}.`, 400);
  }
  return raw;
}

function required(value: unknown, label: string): string {
  const raw = text(value)?.trim() ?? '';
  if (!raw) {
    throw new CatalogError('validation_error', `This backup has an invalid ${label}.`, 400);
  }
  return raw;
}

function whole(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return null;
  }
  return value;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function kind(value: unknown): CategoryRecord['kind'] {
  if (value === 'EXPENSE' || value === 'CONTACT' || value === 'INCOME' || value === 'ITEM') {
    return value;
  }
  return 'ITEM';
}

function movementType(value: unknown): MovementRecord['movementType'] {
  if (value === 'OPENING' || value === 'SALE' || value === 'RETURN' || value === 'PURCHASE') {
    return value;
  }
  return 'ADJUSTMENT';
}

function batchSource(value: unknown): BatchRecord['source'] {
  if (value === 'OPENING' || value === 'RETURN' || value === 'PURCHASE') {
    return value;
  }
  return 'ADJUSTMENT';
}

function accountType(value: unknown): CashAccountRecord['accountType'] {
  if (value === 'BANK' || value === 'WALLET' || value === 'CASH') {
    return value;
  }
  return 'CASH';
}

function cashSource(value: unknown): CashMovementRecord['source'] {
  if (
    value === 'INCOME' ||
    value === 'EXPENSE' ||
    value === 'TRANSFER' ||
    value === 'WITHDRAWAL' ||
    value === 'REFUND' ||
    value === 'SALE' ||
    value === 'PURCHASE'
  ) {
    return value;
  }
  return 'OPENING';
}

import { newId } from '../../auth/application/token.js';
import type { CashAccountRecord, CashMovementRecord } from './cash.js';
import type { IncomingCommand } from './category.js';
import type { BatchRecord, ItemRecord, MovementRecord } from './item.js';

export type PurchaseLine = {
  id: string;
  itemId: string;
  itemName: string;
  unitName: string;
  qty: number;
  unitCostMinor: number;
  amountMinor: number;
};

export type PurchasePayment = {
  id: string;
  amountMinor: number;
  accountName: string;
  paymentMethodName: string;
  note: string;
  occurredAt: string;
};

export type PurchaseReturnLine = { lineId: string; qty: number; amountMinor: number };

export type PurchaseReturn = {
  id: string;
  settlement: 'REFUND' | 'CREDIT';
  amountMinor: number;
  accountName: string;
  paymentMethodName: string;
  note: string;
  occurredAt: string;
  lines: PurchaseReturnLine[];
};

export type PublicPurchase = {
  id: string;
  storeId: string;
  number: string;
  supplierName: string;
  effectiveDate: string;
  occurredAt: string;
  grossMinor: number;
  discountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  netMinor: number;
  paidMinor: number;
  dueMinor: number;
  note: string;
  isActive: boolean;
  revision: number;
  lines: PurchaseLine[];
  payments: PurchasePayment[];
  returns: PurchaseReturn[];
};

export type PurchaseRecord = PublicPurchase & {
  normalizedNumber: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PurchaseEffects = {
  purchase: PurchaseRecord;
  items: ItemRecord[];
  movements: MovementRecord[];
  batches: BatchRecord[];
  cashMovements: CashMovementRecord[];
};

export type PurchaseDecision =
  | { type: 'accept'; changeType: string; effects: PurchaseEffects }
  | { type: 'reject'; code: string; message: string };

const invalid = Symbol('invalid');

export function toPublicPurchase(purchase: PurchaseRecord): PublicPurchase {
  return {
    id: purchase.id,
    storeId: purchase.storeId,
    number: purchase.number,
    supplierName: purchase.supplierName,
    effectiveDate: purchase.effectiveDate,
    occurredAt: purchase.occurredAt,
    grossMinor: purchase.grossMinor,
    discountMinor: purchase.discountMinor,
    taxMinor: purchase.taxMinor,
    shippingMinor: purchase.shippingMinor,
    netMinor: purchase.netMinor,
    paidMinor: purchase.paidMinor,
    dueMinor: purchase.dueMinor,
    note: purchase.note,
    isActive: purchase.isActive,
    revision: purchase.revision,
    lines: purchase.lines,
    payments: purchase.payments,
    returns: purchase.returns,
  };
}

export function toReportPurchase(purchase: PublicPurchase): {
  id: string;
  number: string;
  supplierName: string;
  effectiveDate: string;
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
  paidMinor: number;
  dueMinor: number;
  lineCount: number;
  status: string;
  lines: Array<{ itemName: string; qty: number; amountMinor: number; costMinor: number; occurredAt: string; contactName: string; reference: string }>;
} {
  const lines = purchase.lines
    .map((line) => {
      const qty = line.qty - returnedQty(purchase, line.id);
      return {
        itemName: line.itemName,
        qty,
        amountMinor: line.unitCostMinor * qty,
        costMinor: line.unitCostMinor * qty,
        occurredAt: purchase.occurredAt,
        contactName: purchase.supplierName,
        reference: purchase.number,
      };
    })
    .filter((line) => line.qty > 0);
  return {
    id: purchase.id,
    number: purchase.number,
    supplierName: purchase.supplierName,
    effectiveDate: purchase.effectiveDate,
    grossMinor: purchase.grossMinor,
    discountMinor: purchase.discountMinor,
    netMinor: purchase.netMinor,
    paidMinor: purchase.paidMinor,
    dueMinor: purchase.dueMinor,
    lineCount: lines.length,
    status: purchase.isActive ? 'ACTIVE' : 'VOID',
    lines,
  };
}

export function decidePurchaseCommand(input: {
  purchases: PurchaseRecord[];
  items: ItemRecord[];
  batches: BatchRecord[];
  movements: MovementRecord[];
  accounts: CashAccountRecord[];
  cashMovements: CashMovementRecord[];
  command: IncomingCommand;
  actorName: string;
  now: Date;
}): PurchaseDecision {
  const payload = asRecord(input.command.payload);
  if (!payload) {
    return reject('validation_error', 'Check the purchase.');
  }
  if (input.command.type === 'purchase.create') {
    return createPurchase(input, payload);
  }
  if (input.command.type === 'purchase.pay') {
    return payPurchase(input, payload);
  }
  if (input.command.type === 'purchase.return') {
    return returnPurchase(input, payload);
  }
  if (input.command.type === 'purchase.deactivate') {
    return deactivatePurchase(input, payload);
  }
  return reject('validation_error', 'This purchase change is not supported.');
}

function createPurchase(input: Parameters<typeof decidePurchaseCommand>[0], payload: Record<string, unknown>): PurchaseDecision {
  const id = uuid(payload.id);
  const number = clean(text(payload.number), 20);
  const supplierName = clean(text(payload.supplierName), 80);
  const effectiveDate = dateOnly(payload.effectiveDate);
  const note = noteOf(payload.note);
  const requests = readLines(payload.lines);
  if (!id || !number || !supplierName || effectiveDate === invalid || effectiveDate === null || note === invalid || !requests) {
    return reject('validation_error', 'Check the purchase.');
  }
  if (input.purchases.some((row) => row.isActive && row.normalizedNumber === number.toLowerCase())) {
    return reject('validation_error', 'This bill number is already used.');
  }
  const priced = pricePurchase(payload, requests);
  const received = minor(payload.paidMinor, true);
  if (!priced || received === null || received > priced.netMinor) {
    return reject('validation_error', 'The amount paid cannot pass the total.');
  }
  const stock = receiveStock(input, requests, number, effectiveDate);
  if (!stock) {
    return reject('validation_error', 'Check the items on this bill.');
  }
  const payment = received === 0 ? null : paymentOf(payload, received, effectiveDate, input.now);
  if (received > 0 && (!payment || !openAccount(input, payment.accountName))) {
    return reject('validation_error', 'Choose an open cash account.');
  }
  const cash = payment ? cashOut(input, payload, payment, number, id) : [];
  if (payment && cash.length === 0) {
    return reject('validation_error', 'Check the payment.');
  }
  const purchase = record(input, {
    id,
    number,
    supplierName,
    effectiveDate,
    occurredAt: atTime(effectiveDate, input.now),
    ...priced,
    paidMinor: received,
    dueMinor: priced.netMinor - received,
    note: note ?? '',
    revision: 1,
    lines: stock.lines,
    payments: payment ? [payment] : [],
    returns: [],
  });
  return accept('purchase.created', { purchase, items: stock.items, movements: stock.movements, batches: stock.batches, cashMovements: cash });
}

function payPurchase(input: Parameters<typeof decidePurchaseCommand>[0], payload: Record<string, unknown>): PurchaseDecision {
  const purchase = findPurchase(input, text(payload.id));
  const amount = minor(payload.amountMinor, false);
  const effectiveDate = dateOnly(payload.effectiveDate);
  if (!purchase || purchase.revision !== payload.baseRevision || amount === null || effectiveDate === invalid || effectiveDate === null) {
    return reject('validation_error', 'Check the payment.');
  }
  if (amount > purchase.dueMinor) {
    return reject('validation_error', 'The payment is larger than the balance due.');
  }
  const payment = paymentOf(payload, amount, effectiveDate, input.now);
  if (!payment || !openAccount(input, payment.accountName)) {
    return reject('validation_error', 'Choose an open cash account.');
  }
  const cash = cashOut(input, payload, payment, purchase.number, purchase.id);
  if (cash.length === 0) {
    return reject('validation_error', 'Check the payment.');
  }
  return accept('purchase.paid', {
    purchase: {
      ...purchase,
      paidMinor: purchase.paidMinor + amount,
      dueMinor: purchase.dueMinor - amount,
      revision: purchase.revision + 1,
      payments: [...purchase.payments, payment],
      updatedAt: input.now,
    },
    items: [],
    movements: [],
    batches: [],
    cashMovements: cash,
  });
}

function returnPurchase(input: Parameters<typeof decidePurchaseCommand>[0], payload: Record<string, unknown>): PurchaseDecision {
  const purchase = findPurchase(input, text(payload.purchaseId));
  const returnId = uuid(payload.id);
  const effectiveDate = dateOnly(payload.effectiveDate);
  const note = noteOf(payload.note);
  const settlement = payload.settlement === 'CREDIT' ? 'CREDIT' : payload.settlement === 'REFUND' ? 'REFUND' : null;
  const requested = readReturnLines(payload.lines);
  if (!purchase || !returnId || !settlement || effectiveDate === invalid || effectiveDate === null || note === invalid || !requested) {
    return reject('validation_error', 'Check the return.');
  }
  const lines: PurchaseReturnLine[] = [];
  const items = input.items.map((item) => ({ ...item }));
  const batches = input.batches.map((batch) => ({ ...batch }));
  const movements: MovementRecord[] = [];
  for (const request of requested) {
    const line = purchase.lines.find((row) => row.id === request.lineId);
    if (!line || request.qty > remainingQty(purchase, line)) {
      return reject('validation_error', 'Return quantity cannot exceed the quantity purchased.');
    }
    const item = items.find((row) => row.id === line.itemId && row.isActive);
    if (item?.itemType === 'PRODUCT') {
      if (item.stockQty === null || item.stockQty < request.qty) {
        return reject('insufficient_stock', 'There is not enough stock to return.');
      }
      const owned = batches.filter((batch) => batch.itemId === item.id);
      const consumed = consume(owned, request.qty);
      if (!consumed) {
        return reject('insufficient_stock', 'There is not enough stock to return.');
      }
      for (const batch of consumed) {
        const index = batches.findIndex((row) => row.id === batch.id);
        if (index >= 0) {
          batches[index] = batch;
        }
      }
      item.stockQty -= request.qty;
      item.revision += 1;
      item.updatedAt = input.now;
      const movementId = uuid(request.movementId);
      if (!movementId) {
        return reject('validation_error', 'Check the return.');
      }
      movements.push(movement(input, movementId, item.id, -request.qty, item.stockQty, purchase.number, 'RETURN', atTime(effectiveDate, input.now)));
    }
    lines.push({ lineId: line.id, qty: request.qty, amountMinor: line.unitCostMinor * request.qty });
  }
  const amountMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const refunded = purchase.returns.filter((row) => row.settlement === 'REFUND').reduce((sum, row) => sum + row.amountMinor, 0);
  if (settlement === 'REFUND' && amountMinor > purchase.paidMinor - refunded) {
    return reject('validation_error', 'The refund is larger than the amount paid.');
  }
  if (settlement === 'CREDIT' && amountMinor > purchase.dueMinor) {
    return reject('validation_error', 'The credit is larger than the balance due.');
  }
  const accountName = clean(text(payload.accountName), 80) ?? '';
  const method = clean(text(payload.paymentMethodName), 40) ?? '';
  const cash: CashMovementRecord[] = [];
  if (settlement === 'REFUND') {
    if (!accountName || !method || !openAccount(input, accountName)) {
      return reject('validation_error', 'Choose an open cash account.');
    }
    const cashMovementId = uuid(payload.cashMovementId);
    const account = input.accounts.find((row) => row.isActive && row.name === accountName);
    if (!cashMovementId || !account) {
      return reject('validation_error', 'Check the refund.');
    }
    cash.push({
      id: cashMovementId,
      storeId: input.command.storeId,
      accountId: account.id,
      direction: 'IN',
      amountMinor,
      source: 'REFUND',
      description: `Return ${purchase.number}`,
      sourceReference: purchase.id,
      occurredAt: atTime(effectiveDate, input.now),
      effectiveDate,
      categoryId: null,
      categoryName: null,
      paymentMethodName: method,
      note: note ?? '',
      linkedExpenseId: null,
      transferGroupId: null,
      status: 'ACTIVE',
      revision: 1,
      createdAt: input.now,
    });
  }
  return accept('purchase.returned', {
    purchase: {
      ...purchase,
      dueMinor: settlement === 'CREDIT' ? purchase.dueMinor - amountMinor : purchase.dueMinor,
      revision: purchase.revision + 1,
      updatedAt: input.now,
      returns: [
        ...purchase.returns,
        { id: returnId, settlement, amountMinor, accountName, paymentMethodName: method, note: note ?? '', occurredAt: atTime(effectiveDate, input.now), lines },
      ],
    },
    items,
    movements,
    batches,
    cashMovements: cash,
  });
}

function deactivatePurchase(input: Parameters<typeof decidePurchaseCommand>[0], payload: Record<string, unknown>): PurchaseDecision {
  const purchase = findPurchase(input, text(payload.id));
  if (!purchase || purchase.revision !== payload.baseRevision) {
    return reject('validation_error', 'This purchase changed on another device.');
  }
  const items = input.items.map((item) => ({ ...item }));
  const batches = input.batches.map((batch) => ({ ...batch }));
  const movements: MovementRecord[] = [];
  for (const line of purchase.lines) {
    const qty = remainingQty(purchase, line);
    const item = items.find((row) => row.id === line.itemId);
    if (!item || item.itemType !== 'PRODUCT' || qty === 0) {
      continue;
    }
    if (item.stockQty === null || item.stockQty < qty) {
      return reject('insufficient_stock', 'Stock from this bill has already been sold.');
    }
    const owned = batches.filter((batch) => batch.itemId === item.id);
    const consumed = consume(owned, qty);
    if (!consumed) {
      return reject('insufficient_stock', 'Stock from this bill has already been sold.');
    }
    for (const batch of consumed) {
      const index = batches.findIndex((row) => row.id === batch.id);
      if (index >= 0) {
        batches[index] = batch;
      }
    }
    item.stockQty -= qty;
    item.revision += 1;
    item.updatedAt = input.now;
    movements.push(movement(input, newId(), item.id, -qty, item.stockQty, purchase.number, 'RETURN', purchase.occurredAt));
  }
  const cash = input.cashMovements
    .filter((row) => row.sourceReference === purchase.id && row.status === 'ACTIVE')
    .map((row) => ({ ...row, status: 'REVERSED' as const, revision: row.revision + 1 }));
  return accept('purchase.deactivated', {
    purchase: { ...purchase, isActive: false, revision: purchase.revision + 1, updatedAt: input.now },
    items,
    movements,
    batches,
    cashMovements: cash,
  });
}

function receiveStock(
  input: Parameters<typeof decidePurchaseCommand>[0],
  requests: Array<{ id: string; itemId: string; qty: number; unitCostMinor: number; movementId: string; batchId: string }>,
  number: string,
  date: string,
): { lines: PurchaseLine[]; items: ItemRecord[]; movements: MovementRecord[]; batches: BatchRecord[] } | null {
  const items = input.items.map((item) => ({ ...item }));
  const batches = [...input.batches];
  const movements: MovementRecord[] = [];
  const lines: PurchaseLine[] = [];
  for (const request of requests) {
    const item = items.find((row) => row.id === request.itemId && row.isActive);
    if (!item) {
      return null;
    }
    if (item.itemType === 'PRODUCT') {
      if (item.stockQty === null || !uuid(request.movementId) || !uuid(request.batchId)) {
        return null;
      }
      item.stockQty += request.qty;
      item.revision += 1;
      item.updatedAt = input.now;
      batches.push({
        id: request.batchId,
        storeId: input.command.storeId,
        itemId: item.id,
        receivedOn: date,
        source: 'PURCHASE',
        sourceReference: number,
        unitCostMinor: request.unitCostMinor,
        receivedQty: request.qty,
        remainingQty: request.qty,
        revision: 1,
        createdAt: input.now,
      });
      movements.push(movement(input, request.movementId, item.id, request.qty, item.stockQty, number, 'PURCHASE', atTime(date, input.now)));
    }
    lines.push({
      id: request.id,
      itemId: item.id,
      itemName: item.name,
      unitName: item.unitName ?? '',
      qty: request.qty,
      unitCostMinor: request.unitCostMinor,
      amountMinor: request.qty * request.unitCostMinor,
    });
  }
  return { lines, items, movements, batches };
}

function consume(batches: BatchRecord[], qty: number): BatchRecord[] | null {
  let left = qty;
  const next = [...batches]
    .sort((leftBatch, rightBatch) => leftBatch.receivedOn.localeCompare(rightBatch.receivedOn) || leftBatch.id.localeCompare(rightBatch.id))
    .map((batch) => {
      if (left <= 0 || batch.remainingQty <= 0) {
        return batch;
      }
      const take = Math.min(batch.remainingQty, left);
      left -= take;
      return { ...batch, remainingQty: batch.remainingQty - take, revision: batch.revision + 1 };
    });
  return left === 0 ? next : null;
}

function pricePurchase(
  payload: Record<string, unknown>,
  lines: Array<{ qty: number; unitCostMinor: number }>,
): { grossMinor: number; discountMinor: number; taxMinor: number; shippingMinor: number; netMinor: number } | null {
  const grossMinor = lines.reduce((sum, line) => sum + line.qty * line.unitCostMinor, 0);
  const discountMinor = portion(payload.discountMode, payload.discountValue, grossMinor);
  const shippingMinor = minor(payload.shippingMinor, true);
  if (discountMinor === null || shippingMinor === null || discountMinor > grossMinor) {
    return null;
  }
  const taxMinor = portion(payload.taxMode, payload.taxValue, grossMinor - discountMinor);
  if (taxMinor === null) {
    return null;
  }
  return { grossMinor, discountMinor, taxMinor, shippingMinor, netMinor: grossMinor - discountMinor + taxMinor + shippingMinor };
}

function paymentOf(payload: Record<string, unknown>, amount: number, date: string, now: Date): PurchasePayment | null {
  const id = uuid(payload.paymentId);
  const accountName = clean(text(payload.accountName), 80);
  const method = clean(text(payload.paymentMethodName), 40);
  if (!id || !accountName || !method) {
    return null;
  }
  return { id, amountMinor: amount, accountName, paymentMethodName: method, note: '', occurredAt: atTime(date, now) };
}

function cashOut(
  input: Parameters<typeof decidePurchaseCommand>[0],
  payload: Record<string, unknown>,
  payment: PurchasePayment,
  number: string,
  purchaseId: string,
): CashMovementRecord[] {
  const id = uuid(payload.cashMovementId);
  const account = input.accounts.find((row) => row.isActive && row.name === payment.accountName);
  if (!id || !account || input.cashMovements.some((row) => row.id === id)) {
    return [];
  }
  return [
    {
      id,
      storeId: input.command.storeId,
      accountId: account.id,
      direction: 'OUT',
      amountMinor: payment.amountMinor,
      source: 'EXPENSE',
      description: `Purchase ${number}`,
      sourceReference: purchaseId,
      occurredAt: payment.occurredAt,
      effectiveDate: payment.occurredAt.slice(0, 10),
      categoryId: null,
      categoryName: null,
      paymentMethodName: payment.paymentMethodName,
      note: '',
      linkedExpenseId: null,
      transferGroupId: null,
      status: 'ACTIVE',
      revision: 1,
      createdAt: input.now,
    },
  ];
}

function movement(
  input: Parameters<typeof decidePurchaseCommand>[0],
  id: string,
  itemId: string,
  quantityChange: number,
  onHandAfter: number,
  reference: string,
  movementType: MovementRecord['movementType'],
  occurredAt: string,
): MovementRecord {
  return {
    id,
    storeId: input.command.storeId,
    itemId,
    movementType,
    quantityChange,
    onHandAfter,
    reference,
    occurredAt,
    actorName: input.actorName,
    status: 'ACTIVE',
    revision: 1,
    createdAt: input.now,
  };
}

function record(
  input: Parameters<typeof decidePurchaseCommand>[0],
  fields: Omit<PurchaseRecord, 'storeId' | 'normalizedNumber' | 'isActive' | 'createdAt' | 'updatedAt'>,
): PurchaseRecord {
  return {
    ...fields,
    storeId: input.command.storeId,
    normalizedNumber: fields.number.toLowerCase(),
    isActive: true,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function remainingQty(purchase: PurchaseRecord, line: PurchaseLine): number {
  return line.qty - returnedQty(purchase, line.id);
}

function returnedQty(purchase: PublicPurchase, lineId: string): number {
  return purchase.returns.reduce(
    (sum, row) => sum + row.lines.filter((line) => line.lineId === lineId).reduce((inner, line) => inner + line.qty, 0),
    0,
  );
}

function findPurchase(input: Parameters<typeof decidePurchaseCommand>[0], id: string | null): PurchaseRecord | null {
  return input.purchases.find((row) => row.id === id && row.isActive) ?? null;
}

function openAccount(input: Parameters<typeof decidePurchaseCommand>[0], name: string): boolean {
  return input.accounts.some((account) => account.isActive && account.name === name);
}

function readLines(value: unknown): Array<{ id: string; itemId: string; qty: number; unitCostMinor: number; movementId: string; batchId: string }> | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const lines = [];
  for (const item of value) {
    const record = asRecord(item);
    const id = record ? uuid(record.id) : null;
    const itemId = record ? uuid(record.itemId) : null;
    const qty = record ? minor(record.qty, false) : null;
    const unitCostMinor = record ? minor(record.unitCostMinor, true) : null;
    const movementId = record && typeof record.movementId === 'string' ? record.movementId : '';
    const batchId = record && typeof record.batchId === 'string' ? record.batchId : '';
    if (!id || !itemId || qty === null || qty > 1_000_000 || unitCostMinor === null) {
      return null;
    }
    lines.push({ id, itemId, qty, unitCostMinor, movementId, batchId });
  }
  return lines;
}

function readReturnLines(value: unknown): Array<{ lineId: string; qty: number; movementId: unknown }> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const lines = [];
  for (const item of value) {
    const record = asRecord(item);
    const lineId = record ? uuid(record.lineId) : null;
    const qty = record ? minor(record.qty, true) : null;
    if (!lineId || qty === null) {
      return null;
    }
    if (qty > 0 && record) {
      lines.push({ lineId, qty, movementId: record.movementId });
    }
  }
  return lines.length === 0 ? null : lines;
}

function accept(changeType: string, effects: PurchaseEffects): PurchaseDecision {
  return { type: 'accept', changeType, effects };
}

function reject(code: string, message: string): PurchaseDecision {
  return { type: 'reject', code, message };
}

function portion(mode: unknown, value: unknown, base: number): number | null {
  const amount = minor(value, true);
  if (amount === null || (mode !== 'AMOUNT' && mode !== 'PERCENT')) {
    return null;
  }
  if (mode === 'AMOUNT') {
    return amount;
  }
  return amount > 100 ? null : Math.round((base * amount) / 100);
}

function atTime(date: string, now: Date): string {
  return `${date}T${now.getUTCHours().toString().padStart(2, '0')}:${now.getUTCMinutes().toString().padStart(2, '0')}:00.000Z`;
}

function dateOnly(value: unknown): string | null | typeof invalid {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return invalid;
  }
  const parts = value.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return invalid;
  }
  return value;
}

function minor(value: unknown, allowZero: boolean): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value > 1_000_000_000 || value < (allowZero ? 0 : 1)) {
    return null;
  }
  return value;
}

function noteOf(value: unknown): string | null | typeof invalid {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    return invalid;
  }
  const note = value.trim().replace(/\s+/g, ' ');
  return note.length > 240 ? invalid : note;
}

function clean(value: string | null, max: number): string | null {
  if (!value) {
    return null;
  }
  const name = value.trim().replace(/\s+/g, ' ');
  return name.length === 0 || name.length > max ? null : name;
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

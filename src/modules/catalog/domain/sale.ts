import { newId } from '../../auth/application/token.js';
import type { CashAccountRecord, CashMovementRecord } from './cash.js';
import type { IncomingCommand } from './category.js';
import type { BatchRecord, ItemRecord, MovementRecord } from './item.js';

export type SaleLine = {
  id: string;
  itemId: string;
  itemName: string;
  unitName: string;
  qty: number;
  unitPriceMinor: number;
  amountMinor: number;
  costMinor: number;
};

export type SalePayment = {
  id: string;
  amountMinor: number;
  accountName: string;
  paymentMethodName: string;
  occurredAt: string;
};

export type SaleReturnLine = { lineId: string; qty: number; amountMinor: number };

export type SaleReturn = {
  id: string;
  refundMinor: number;
  accountName: string;
  paymentMethodName: string;
  note: string;
  occurredAt: string;
  lines: SaleReturnLine[];
};

export type PublicSale = {
  id: string;
  storeId: string;
  number: string;
  contactName: string;
  effectiveDate: string;
  occurredAt: string;
  grossMinor: number;
  discountMinor: number;
  taxMinor: number;
  deliveryMinor: number;
  netMinor: number;
  costMinor: number;
  receivedMinor: number;
  dueMinor: number;
  note: string;
  isActive: boolean;
  revision: number;
  lines: SaleLine[];
  payments: SalePayment[];
  returns: SaleReturn[];
};

export type SaleRecord = PublicSale & {
  normalizedNumber: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SaleEffects = {
  sale: SaleRecord;
  items: ItemRecord[];
  movements: MovementRecord[];
  batches: BatchRecord[];
  cashMovements: CashMovementRecord[];
};

export type SaleDecision =
  | { type: 'accept'; changeType: string; effects: SaleEffects }
  | { type: 'reject'; code: string; message: string };

const invalid = Symbol('invalid');

export function toPublicSale(sale: SaleRecord): PublicSale {
  return {
    id: sale.id,
    storeId: sale.storeId,
    number: sale.number,
    contactName: sale.contactName,
    effectiveDate: sale.effectiveDate,
    occurredAt: sale.occurredAt,
    grossMinor: sale.grossMinor,
    discountMinor: sale.discountMinor,
    taxMinor: sale.taxMinor,
    deliveryMinor: sale.deliveryMinor,
    netMinor: sale.netMinor,
    costMinor: sale.costMinor,
    receivedMinor: sale.receivedMinor,
    dueMinor: sale.dueMinor,
    note: sale.note,
    isActive: sale.isActive,
    revision: sale.revision,
    lines: sale.lines,
    payments: sale.payments,
    returns: sale.returns,
  };
}

export function toReportSale(sale: PublicSale): {
  id: string;
  number: string;
  contactName: string;
  effectiveDate: string;
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
  costMinor: number;
  receivedMinor: number;
  dueMinor: number;
  status: string;
  lines: Array<{ itemName: string; qty: number; amountMinor: number; costMinor: number; occurredAt: string; contactName: string; reference: string }>;
} {
  const lines = sale.lines
    .map((line) => {
      const qty = line.qty - returnedQty(sale, line.id);
      const unitCost = line.qty === 0 ? 0 : Math.round(line.costMinor / line.qty);
      return {
        itemName: line.itemName,
        qty,
        amountMinor: line.unitPriceMinor * qty,
        costMinor: unitCost * qty,
        occurredAt: sale.occurredAt,
        contactName: sale.contactName,
        reference: sale.number,
      };
    })
    .filter((line) => line.qty > 0);
  return {
    id: sale.id,
    number: sale.number,
    contactName: sale.contactName,
    effectiveDate: sale.effectiveDate,
    grossMinor: sale.grossMinor,
    discountMinor: sale.discountMinor,
    netMinor: sale.netMinor,
    costMinor: lines.reduce((sum, line) => sum + line.costMinor, 0),
    receivedMinor: sale.receivedMinor,
    dueMinor: sale.dueMinor,
    status: sale.isActive ? 'ACTIVE' : 'VOID',
    lines,
  };
}

function returnedQty(sale: PublicSale, lineId: string): number {
  return sale.returns.reduce(
    (sum, row) => sum + row.lines.filter((line) => line.lineId === lineId).reduce((inner, line) => inner + line.qty, 0),
    0,
  );
}

export function decideSaleCommand(input: {
  sales: SaleRecord[];
  items: ItemRecord[];
  batches: BatchRecord[];
  movements: MovementRecord[];
  accounts: CashAccountRecord[];
  cashMovements: CashMovementRecord[];
  command: IncomingCommand;
  actorName: string;
  now: Date;
}): SaleDecision {
  const payload = asRecord(input.command.payload);
  if (!payload) {
    return reject('validation_error', 'Check the sale.');
  }
  if (input.command.type === 'sale.create') {
    return createSale(input, payload);
  }
  if (input.command.type === 'sale.collect') {
    return collectSale(input, payload);
  }
  if (input.command.type === 'sale.return') {
    return returnSale(input, payload);
  }
  if (input.command.type === 'sale.deactivate') {
    return deactivateSale(input, payload);
  }
  if (input.command.type === 'sale.restore') {
    return restoreSale(input, payload);
  }
  if (input.command.type === 'sale.purge') {
    return purgeSale(input, payload);
  }
  return reject('validation_error', 'This sale change is not supported.');
}

function createSale(input: Parameters<typeof decideSaleCommand>[0], payload: Record<string, unknown>): SaleDecision {
  const id = uuid(payload.id);
  const number = clean(text(payload.number), 20);
  const contactName = clean(text(payload.contactName), 80);
  const effectiveDate = dateOnly(payload.effectiveDate);
  const note = noteOf(payload.note);
  const lines = readLines(payload.lines);
  if (!id || !number || !contactName || effectiveDate === invalid || effectiveDate === null || note === invalid || lines === null) {
    return reject('validation_error', 'Check the sale.');
  }
  if (input.sales.some((sale) => sale.isActive && sale.normalizedNumber === number.toLowerCase())) {
    return reject('validation_error', 'This invoice number is already used.');
  }
  const built = priceSale(payload, lines);
  if (built === null) {
    return reject('validation_error', 'Check the sale totals.');
  }
  const stock = applySaleStock(input, lines, number, `${effectiveDate}T00:00:00.000Z`, 1);
  if (stock === null) {
    return reject('insufficient_stock', 'There is not enough stock for this sale.');
  }
  const received = minor(payload.receivedMinor, true);
  if (received === null || received > built.netMinor) {
    return reject('validation_error', 'The amount received cannot pass the total.');
  }
  const payment = received === 0 ? null : paymentOf(payload, received, effectiveDate, input.now);
  if (received > 0 && payment === null) {
    return reject('validation_error', 'Choose the account and payment method.');
  }
  if (payment && !input.accounts.some((account) => account.isActive && account.name === payment.accountName)) {
    return reject('validation_error', 'Choose an open cash account.');
  }
  const cash = payment ? cashIn(input, payload, payment, number, id) : [];
  if (payment && cash.length === 0) {
    return reject('validation_error', 'Check the payment.');
  }
  const sale = saleRecord(input, {
    id,
    number,
    contactName,
    effectiveDate,
    occurredAt: atTime(effectiveDate, input.now),
    ...built,
    costMinor: stock.costMinor,
    receivedMinor: received,
    dueMinor: built.netMinor - received,
    note: note ?? '',
    revision: 1,
    lines: stock.lines,
    payments: payment ? [payment] : [],
    returns: [],
  });
  return accept('sale.created', { sale, items: stock.items, movements: stock.movements, batches: stock.batches, cashMovements: cash });
}

function collectSale(input: Parameters<typeof decideSaleCommand>[0], payload: Record<string, unknown>): SaleDecision {
  const sale = findSale(input, text(payload.id));
  const amount = minor(payload.amountMinor, false);
  const effectiveDate = dateOnly(payload.effectiveDate);
  if (!sale || sale.revision !== payload.baseRevision || amount === null || effectiveDate === invalid || effectiveDate === null) {
    return reject('validation_error', 'Check the payment.');
  }
  if (amount > sale.dueMinor) {
    return reject('validation_error', 'The payment is larger than the balance due.');
  }
  const payment = paymentOf(payload, amount, effectiveDate, input.now);
  if (!payment || !input.accounts.some((account) => account.isActive && account.name === payment.accountName)) {
    return reject('validation_error', 'Choose an open cash account.');
  }
  const cash = cashIn(input, payload, payment, sale.number, sale.id);
  if (cash.length === 0) {
    return reject('validation_error', 'Check the payment.');
  }
  const next = {
    ...sale,
    receivedMinor: sale.receivedMinor + amount,
    dueMinor: sale.dueMinor - amount,
    revision: sale.revision + 1,
    payments: [...sale.payments, payment],
    updatedAt: input.now,
  };
  return accept('sale.collected', { sale: next, items: [], movements: [], batches: [], cashMovements: cash });
}

function returnSale(input: Parameters<typeof decideSaleCommand>[0], payload: Record<string, unknown>): SaleDecision {
  const sale = findSale(input, text(payload.saleId));
  const returnId = uuid(payload.id);
  const effectiveDate = dateOnly(payload.effectiveDate);
  const note = noteOf(payload.note);
  const requested = readReturnLines(payload.lines);
  if (!sale || !returnId || effectiveDate === invalid || effectiveDate === null || note === invalid || !requested) {
    return reject('validation_error', 'Check the return.');
  }
  if (sale.returns.some((row) => row.id === returnId)) {
    return reject('validation_error', 'This return was already saved.');
  }
  const lines: SaleReturnLine[] = [];
  const items = input.items.map((item) => ({ ...item }));
  const batches = input.batches.map((batch) => ({ ...batch }));
  const movements: MovementRecord[] = [];
  for (const request of requested) {
    const line = sale.lines.find((row) => row.id === request.lineId);
    if (!line || request.qty < 1 || request.qty > remainingQty(sale, line)) {
      return reject('validation_error', 'Return quantity cannot exceed the quantity sold.');
    }
    const amount = line.unitPriceMinor * request.qty;
    lines.push({ lineId: line.id, qty: request.qty, amountMinor: amount });
    const item = items.find((row) => row.id === line.itemId && row.isActive);
    if (item && item.itemType === 'PRODUCT' && item.stockQty !== null) {
      const movementId = uuid(request.movementId);
      const batchId = uuid(request.batchId);
      if (!movementId || !batchId) {
        return reject('validation_error', 'Check the return.');
      }
      const unitCost = line.qty === 0 ? 0 : Math.round(line.costMinor / line.qty);
      item.stockQty += request.qty;
      item.revision += 1;
      item.updatedAt = input.now;
      batches.push({
        id: batchId,
        storeId: input.command.storeId,
        itemId: item.id,
        receivedOn: effectiveDate,
        source: 'RETURN',
        sourceReference: sale.number,
        unitCostMinor: unitCost,
        receivedQty: request.qty,
        remainingQty: request.qty,
        revision: 1,
        createdAt: input.now,
      });
      movements.push(stockMovement(input, movementId, item.id, request.qty, item.stockQty, sale.number));
    }
  }
  const refundMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
  const refundedAlready = sale.returns.reduce((sum, row) => sum + row.refundMinor, 0);
  if (refundMinor > sale.receivedMinor - refundedAlready) {
    return reject('validation_error', 'The refund is larger than the amount received.');
  }
  const accountName = clean(text(payload.accountName), 80);
  const method = clean(text(payload.paymentMethodName), 40);
  if (refundMinor > 0 && (!accountName || !method || !input.accounts.some((account) => account.isActive && account.name === accountName))) {
    return reject('validation_error', 'Choose an open cash account.');
  }
  const cashMovementId = uuid(payload.cashMovementId);
  const cash: CashMovementRecord[] = [];
  if (refundMinor > 0) {
    if (!cashMovementId || input.cashMovements.some((row) => row.id === cashMovementId)) {
      return reject('validation_error', 'Check the refund.');
    }
    const account = input.accounts.find((row) => row.isActive && row.name === accountName);
    cash.push({
      id: cashMovementId,
      storeId: input.command.storeId,
      accountId: account?.id ?? '',
      direction: 'OUT',
      amountMinor: refundMinor,
      source: 'REFUND',
      description: `Return ${sale.number}`,
      sourceReference: sale.id,
      occurredAt: atTime(effectiveDate, input.now),
      effectiveDate,
      categoryId: null,
      categoryName: null,
      paymentMethodName: method ?? '',
      note: note ?? '',
      linkedExpenseId: null,
      transferGroupId: null,
      status: 'ACTIVE',
      revision: 1,
      createdAt: input.now,
    });
  }
  const next: SaleRecord = {
    ...sale,
    revision: sale.revision + 1,
    updatedAt: input.now,
    returns: [
      ...sale.returns,
      {
        id: returnId,
        refundMinor,
        accountName: accountName ?? '',
        paymentMethodName: method ?? '',
        note: note ?? '',
        occurredAt: atTime(effectiveDate, input.now),
        lines,
      },
    ],
  };
  return accept('sale.returned', { sale: next, items, movements, batches, cashMovements: cash });
}

function deactivateSale(input: Parameters<typeof decideSaleCommand>[0], payload: Record<string, unknown>): SaleDecision {
  const sale = findSale(input, text(payload.id));
  if (!sale || sale.revision !== payload.baseRevision) {
    return reject('validation_error', 'This sale changed on another device.');
  }
  const items = input.items.map((item) => ({ ...item }));
  const batches = [...input.batches];
  const movements: MovementRecord[] = [];
  for (const line of sale.lines) {
    const qty = remainingQty(sale, line);
    const item = items.find((row) => row.id === line.itemId);
    if (!item || item.itemType !== 'PRODUCT' || item.stockQty === null || qty === 0) {
      continue;
    }
    item.stockQty += qty;
    item.revision += 1;
    item.updatedAt = input.now;
    const unitCost = line.qty === 0 ? 0 : Math.round(line.costMinor / line.qty);
    batches.push({
      id: newId(),
      storeId: sale.storeId,
      itemId: item.id,
      receivedOn: sale.effectiveDate,
      source: 'RETURN',
      sourceReference: sale.number,
      unitCostMinor: unitCost,
      receivedQty: qty,
      remainingQty: qty,
      revision: 1,
      createdAt: input.now,
    });
    const originals = reversedOriginals(input.movements, item.id, sale.number, 'SALE');
    if (originals.length === 0) {
      movements.push(stockMovement(input, newId(), item.id, qty, item.stockQty, sale.number));
    } else {
      for (const row of originals) {
        if (!movements.some((existing) => existing.id === row.id)) {
          movements.push(row);
        }
      }
    }
  }
  const cash = input.cashMovements
    .filter((row) => row.sourceReference === sale.id && row.status === 'ACTIVE')
    .map((row) => ({ ...row, status: 'REVERSED' as const, revision: row.revision + 1 }));
  return accept('sale.deactivated', {
    sale: { ...sale, isActive: false, revision: sale.revision + 1, updatedAt: input.now },
    items,
    movements,
    batches,
    cashMovements: cash,
  });
}

function restoreSale(input: Parameters<typeof decideSaleCommand>[0], payload: Record<string, unknown>): SaleDecision {
  const sale = input.sales.find((row) => row.id === text(payload.id)) ?? null;
  if (!sale || sale.isActive) {
    return reject('validation_error', 'This sale is not in the trash.');
  }
  const items = input.items.map((item) => ({ ...item }));
  const batches = input.batches.map((batch) => ({ ...batch }));
  const movements: MovementRecord[] = [];
  for (const line of sale.lines) {
    const qty = remainingQty(sale, line);
    const item = items.find((row) => row.id === line.itemId);
    if (!item || item.itemType !== 'PRODUCT' || item.stockQty === null || qty === 0) {
      continue;
    }
    item.stockQty -= qty;
    item.revision += 1;
    item.updatedAt = input.now;
    let left = qty;
    for (const batch of batches) {
      if (left === 0) {
        break;
      }
      if (
        batch.itemId !== item.id ||
        batch.source !== 'RETURN' ||
        batch.sourceReference !== sale.number ||
        batch.remainingQty <= 0
      ) {
        continue;
      }
      const take = Math.min(left, batch.remainingQty);
      batch.remainingQty -= take;
      batch.revision += 1;
      left -= take;
    }
    for (const row of input.movements) {
      if (
        row.itemId === item.id &&
        row.reference === sale.number &&
        row.movementType === 'SALE' &&
        row.status === 'REVERSED' &&
        !movements.some((existing) => existing.id === row.id)
      ) {
        movements.push({ ...row, status: 'ACTIVE', revision: row.revision + 1 });
      }
    }
  }
  const cash = input.cashMovements
    .filter((row) => row.sourceReference === sale.id && row.status === 'REVERSED')
    .map((row) => ({ ...row, status: 'ACTIVE' as const, revision: row.revision + 1 }));
  return accept('sale.restored', {
    sale: { ...sale, isActive: true, revision: sale.revision + 1, updatedAt: input.now },
    items,
    movements,
    batches,
    cashMovements: cash,
  });
}

function purgeSale(input: Parameters<typeof decideSaleCommand>[0], payload: Record<string, unknown>): SaleDecision {
  const sale = input.sales.find((row) => row.id === text(payload.id)) ?? null;
  if (!sale || sale.isActive) {
    return reject('validation_error', 'This sale is not in the trash.');
  }
  return accept('sale.purged', {
    sale,
    items: [],
    movements: [],
    batches: [],
    cashMovements: [],
  });
}

function applySaleStock(
  input: Parameters<typeof decideSaleCommand>[0],
  requests: Array<{ id: string; itemId: string; qty: number; unitPriceMinor: number; movementId: string }>,
  number: string,
  occurredAt: string,
  sign: 1 | -1,
): { lines: SaleLine[]; items: ItemRecord[]; movements: MovementRecord[]; batches: BatchRecord[]; costMinor: number } | null {
  const items = input.items.map((item) => ({ ...item }));
  const batches = input.batches.map((batch) => ({ ...batch }));
  const movements: MovementRecord[] = [];
  const lines: SaleLine[] = [];
  let costMinor = 0;
  for (const request of requests) {
    const item = items.find((row) => row.id === request.itemId && row.isActive);
    if (!item) {
      return null;
    }
    let lineCost = 0;
    if (item.itemType === 'PRODUCT') {
      if (item.stockQty === null || item.stockQty < request.qty) {
        return null;
      }
      const owned = batches.filter((batch) => batch.itemId === item.id);
      const consumed = consume(owned, request.qty);
      if (!consumed) {
        return null;
      }
      lineCost = costOf(owned, consumed, request.qty);
      for (const batch of consumed) {
        const index = batches.findIndex((row) => row.id === batch.id);
        if (index >= 0) {
          batches[index] = batch;
        }
      }
      item.stockQty -= request.qty * sign;
      item.revision += 1;
      item.updatedAt = input.now;
      if (!uuid(request.movementId) || input.movements.some((row) => row.id === request.movementId)) {
        return null;
      }
      movements.push(stockMovement(input, request.movementId, item.id, -request.qty, item.stockQty, number, 'SALE', occurredAt));
    }
    lines.push({
      id: request.id,
      itemId: item.id,
      itemName: item.name,
      unitName: item.unitName ?? '',
      qty: request.qty,
      unitPriceMinor: request.unitPriceMinor,
      amountMinor: request.qty * request.unitPriceMinor,
      costMinor: lineCost,
    });
    costMinor += lineCost;
  }
  return { lines, items, movements, batches, costMinor };
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

function costOf(before: BatchRecord[], after: BatchRecord[], qty: number): number {
  let left = qty;
  let cost = 0;
  const ordered = [...before].sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || a.id.localeCompare(b.id));
  for (const batch of ordered) {
    if (left <= 0) {
      break;
    }
    const updated = after.find((row) => row.id === batch.id) ?? batch;
    const taken = batch.remainingQty - updated.remainingQty;
    if (taken > 0) {
      cost += taken * batch.unitCostMinor;
      left -= taken;
    }
  }
  return cost;
}

function priceSale(
  payload: Record<string, unknown>,
  lines: Array<{ id: string; itemId: string; qty: number; unitPriceMinor: number; movementId: string }>,
): { grossMinor: number; discountMinor: number; taxMinor: number; deliveryMinor: number; netMinor: number } | null {
  const grossMinor = lines.reduce((sum, line) => sum + line.qty * line.unitPriceMinor, 0);
  const discountMinor = portion(payload.discountMode, payload.discountValue, grossMinor);
  const deliveryMinor = minor(payload.deliveryMinor, true);
  if (discountMinor === null || deliveryMinor === null || discountMinor > grossMinor) {
    return null;
  }
  const taxMinor = portion(payload.taxMode, payload.taxValue, grossMinor - discountMinor);
  if (taxMinor === null) {
    return null;
  }
  return { grossMinor, discountMinor, taxMinor, deliveryMinor, netMinor: grossMinor - discountMinor + taxMinor + deliveryMinor };
}

function portion(mode: unknown, value: unknown, base: number): number | null {
  const amount = minor(value, true);
  if (amount === null || (mode !== 'AMOUNT' && mode !== 'PERCENT')) {
    return null;
  }
  if (mode === 'AMOUNT') {
    return amount;
  }
  if (amount > 100) {
    return null;
  }
  return Math.round((base * amount) / 100);
}

function paymentOf(payload: Record<string, unknown>, amount: number, date: string, now: Date): SalePayment | null {
  const id = uuid(payload.paymentId);
  const accountName = clean(text(payload.accountName), 80);
  const method = clean(text(payload.paymentMethodName), 40);
  if (!id || !accountName || !method) {
    return null;
  }
  return { id, amountMinor: amount, accountName, paymentMethodName: method, occurredAt: atTime(date, now) };
}

function cashIn(
  input: Parameters<typeof decideSaleCommand>[0],
  payload: Record<string, unknown>,
  payment: SalePayment,
  number: string,
  saleId: string,
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
      direction: 'IN',
      amountMinor: payment.amountMinor,
      source: 'INCOME',
      description: `Sale ${number}`,
      sourceReference: saleId,
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

function reversedOriginals(
  movements: MovementRecord[],
  itemId: string,
  reference: string,
  movementType: MovementRecord['movementType'],
): MovementRecord[] {
  return movements
    .filter(
      (row) =>
        row.itemId === itemId &&
        row.reference === reference &&
        row.movementType === movementType &&
        row.status === 'ACTIVE',
    )
    .map((row) => ({ ...row, status: 'REVERSED' as const, revision: row.revision + 1 }));
}

function stockMovement(
  input: Parameters<typeof decideSaleCommand>[0],
  id: string,
  itemId: string,
  quantityChange: number,
  onHandAfter: number,
  reference: string,
  movementType: MovementRecord['movementType'] = 'RETURN',
  occurredAt = atTime(new Date().toISOString().slice(0, 10), input.now),
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

function saleRecord(
  input: Parameters<typeof decideSaleCommand>[0],
  fields: Omit<SaleRecord, 'storeId' | 'normalizedNumber' | 'isActive' | 'createdAt' | 'updatedAt'>,
): SaleRecord {
  return {
    ...fields,
    storeId: input.command.storeId,
    normalizedNumber: fields.number.toLowerCase(),
    isActive: true,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function remainingQty(sale: SaleRecord, line: SaleLine): number {
  const returned = sale.returns.reduce(
    (sum, row) => sum + row.lines.filter((item) => item.lineId === line.id).reduce((inner, item) => inner + item.qty, 0),
    0,
  );
  return line.qty - returned;
}

function findSale(input: Parameters<typeof decideSaleCommand>[0], id: string | null): SaleRecord | null {
  return input.sales.find((sale) => sale.id === id && sale.isActive) ?? null;
}

function readLines(value: unknown): Array<{ id: string; itemId: string; qty: number; unitPriceMinor: number; movementId: string }> | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const lines = [];
  for (const item of value) {
    const record = asRecord(item);
    const id = record ? uuid(record.id) : null;
    const itemId = record ? uuid(record.itemId) : null;
    const qty = record ? minor(record.qty, false) : null;
    const unitPriceMinor = record ? minor(record.unitPriceMinor, true) : null;
    const movementId = record && typeof record.movementId === 'string' ? record.movementId : '';
    if (!record || !id || !itemId || qty === null || qty > 1_000_000 || unitPriceMinor === null) {
      return null;
    }
    lines.push({ id, itemId, qty, unitPriceMinor, movementId });
  }
  return lines;
}

function readReturnLines(value: unknown): Array<{ lineId: string; qty: number; movementId: unknown; batchId: unknown }> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const lines = [];
  for (const item of value) {
    const record = asRecord(item);
    const lineId = record ? uuid(record.lineId) : null;
    const qty = record ? minor(record.qty, true) : null;
    if (!record || !lineId || qty === null) {
      return null;
    }
    if (qty > 0) {
      lines.push({ lineId, qty, movementId: record.movementId, batchId: record.batchId });
    }
  }
  return lines.length === 0 ? null : lines;
}

function accept(changeType: string, effects: SaleEffects): SaleDecision {
  return { type: 'accept', changeType, effects };
}

function reject(code: string, message: string): SaleDecision {
  return { type: 'reject', code, message };
}

function atTime(date: string, now: Date): string {
  const hours = now.getUTCHours().toString().padStart(2, '0');
  const minutes = now.getUTCMinutes().toString().padStart(2, '0');
  return `${date}T${hours}:${minutes}:00.000Z`;
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
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
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

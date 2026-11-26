import type { IncomingCommand } from './category.js';

export type HeldLine = {
  itemId: string;
  qty: number;
  unitPriceMinor: number;
};

export type PublicHeldSale = {
  id: string;
  storeId: string;
  name: string;
  contactName: string;
  wholesale: boolean;
  discountMode: 'AMOUNT' | 'PERCENT';
  discountValue: number;
  taxMode: 'AMOUNT' | 'PERCENT';
  taxValue: number;
  deliveryMinor: number;
  note: string;
  lines: HeldLine[];
  revision: number;
  removed: boolean;
};

export type HeldDecision =
  | { type: 'accept'; changeType: string; held: PublicHeldSale }
  | { type: 'reject'; code: string; message: string };

const modes = new Set(['AMOUNT', 'PERCENT']);

export function decideHeldSale(input: {
  held: PublicHeldSale[];
  command: IncomingCommand;
}): HeldDecision {
  const payload = asRecord(input.command.payload);
  if (!payload) {
    return reject('validation_error', 'Check the held sale.');
  }
  const id = uuid(payload.id);
  if (!id) {
    return reject('validation_error', 'Check the held sale.');
  }
  const current = input.held.find((row) => row.id === id && row.storeId === input.command.storeId && !row.removed);
  if (input.command.type === 'heldSale.discard') {
    if (!current) {
      return reject('not_found', 'This held sale was not found.');
    }
    return {
      type: 'accept',
      changeType: 'heldSale.discarded',
      held: { ...current, removed: true, revision: current.revision + 1 },
    };
  }
  if (input.command.type !== 'heldSale.upsert') {
    return reject('validation_error', 'This held sale change is not supported.');
  }
  const name = clean(payload.name, 80);
  const contactName = clean(payload.contactName, 80);
  const note = noteOf(payload.note ?? '', 240);
  const lines = readLines(payload.lines);
  const discountMode = text(payload.discountMode);
  const taxMode = text(payload.taxMode);
  const discountValue = minor(payload.discountValue);
  const taxValue = minor(payload.taxValue);
  const delivery = minor(payload.deliveryMinor);
  if (
    !name ||
    !contactName ||
    note === null ||
    !lines ||
    !modes.has(discountMode) ||
    !modes.has(taxMode) ||
    discountValue === null ||
    taxValue === null ||
    delivery === null
  ) {
    return reject('validation_error', 'Check the held sale.');
  }
  if (!current && input.held.filter((row) => row.storeId === input.command.storeId && !row.removed).length >= 30) {
    return reject('validation_error', 'Hold fewer sales before parking another one.');
  }
  return {
    type: 'accept',
    changeType: current ? 'heldSale.updated' : 'heldSale.saved',
    held: {
      id,
      storeId: input.command.storeId,
      name,
      contactName,
      wholesale: payload.wholesale === true,
      discountMode: discountMode as 'AMOUNT' | 'PERCENT',
      discountValue,
      taxMode: taxMode as 'AMOUNT' | 'PERCENT',
      taxValue,
      deliveryMinor: delivery,
      note,
      lines,
      revision: (current?.revision ?? 0) + 1,
      removed: false,
    },
  };
}

export function collectionRows(
  sales: Array<{ id: string; active: boolean; contactName: string; dueMinor: number; effectiveDate: string }>,
  today: string,
) {
  return sales
    .filter((sale) => sale.active && sale.dueMinor > 0)
    .map((sale) => ({
      id: sale.id,
      name: sale.contactName,
      dueMinor: sale.dueMinor,
      ageDays: ageDays(sale.effectiveDate, today),
    }))
    .sort((left, right) => right.ageDays - left.ageDays || left.name.localeCompare(right.name));
}

export function reorderRows(
  items: Array<{
    id: string;
    name: string;
    active: boolean;
    itemType: string;
    stockQty: number | null;
    lowStockLevel: number | null;
    purchaseCostMinor: number | null;
  }>,
) {
  return items
    .filter(
      (item) =>
        item.active &&
        item.itemType === 'PRODUCT' &&
        item.stockQty !== null &&
        item.lowStockLevel !== null &&
        item.stockQty <= item.lowStockLevel,
    )
    .map((item) => ({
      id: item.id,
      name: item.name,
      onHand: item.stockQty ?? 0,
      lastCostMinor: item.purchaseCostMinor,
    }))
    .sort((left, right) => left.onHand - right.onHand || left.name.localeCompare(right.name));
}

function ageDays(effectiveDate: string, today: string): number {
  const start = Date.parse(`${effectiveDate}T00:00:00.000Z`);
  const end = Date.parse(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

function readLines(value: unknown): HeldLine[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    return null;
  }
  const lines: HeldLine[] = [];
  for (const row of value) {
    const record = asRecord(row);
    const itemId = record ? uuid(record.itemId) : null;
    const qty = record ? whole(record.qty) : null;
    const price = record ? minor(record.unitPriceMinor) : null;
    if (!record || !itemId || qty === null || price === null) {
      return null;
    }
    lines.push({ itemId, qty, unitPriceMinor: price });
  }
  return lines;
}

function reject(code: string, message: string): HeldDecision {
  return { type: 'reject', code, message };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function noteOf(value: unknown, max: number): string | null {
  const cleaned = text(value).trim().replace(/\s+/g, ' ');
  if (cleaned.length > max) {
    return null;
  }
  return cleaned;
}

function clean(value: unknown, max: number): string | null {
  const cleaned = text(value).trim().replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > max) {
    return null;
  }
  return cleaned;
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function minor(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
    return null;
  }
  return value;
}

function whole(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_000_000) {
    return null;
  }
  return value;
}

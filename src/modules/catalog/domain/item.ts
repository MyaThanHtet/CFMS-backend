import type { IncomingCommand } from './category.js';
import type { ContactCategoryRef } from './contact.js';

export const itemTypes = ['PRODUCT', 'SERVICE'] as const;
export type ItemType = (typeof itemTypes)[number];

export type PublicUnit = {
  id: string;
  storeId: string;
  name: string;
  isActive: boolean;
  revision: number;
};

export type UnitRecord = PublicUnit & {
  normalizedName: string;
  createdBy: string;
  updatedBy: string;
  deviceId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicMovement = {
  id: string;
  storeId: string;
  itemId: string;
  movementType: 'OPENING' | 'ADJUSTMENT' | 'SALE' | 'RETURN' | 'PURCHASE';
  quantityChange: number;
  onHandAfter: number;
  reference: string;
  occurredAt: string;
  actorName: string;
  status: 'ACTIVE' | 'REVERSED';
  revision: number;
};

export type MovementRecord = PublicMovement & {
  createdAt: Date;
};

export type PublicBatch = {
  id: string;
  storeId: string;
  itemId: string;
  receivedOn: string;
  source: 'OPENING' | 'ADJUSTMENT' | 'RETURN' | 'PURCHASE';
  sourceReference: string;
  unitCostMinor: number;
  receivedQty: number;
  remainingQty: number;
  revision: number;
};

export type BatchRecord = PublicBatch & {
  createdAt: Date;
};

export type PublicItem = {
  id: string;
  storeId: string;
  itemType: ItemType;
  name: string;
  sku: string | null;
  unitId: string | null;
  unitName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  salePriceMinor: number;
  purchaseCostMinor: number | null;
  stockQty: number | null;
  lowStockLevel: number | null;
  fifoCostMinor: number | null;
  isActive: boolean;
  revision: number;
};

export type ItemRecord = Omit<PublicItem, 'fifoCostMinor'> & {
  normalizedName: string;
  normalizedSku: string;
  createdBy: string;
  updatedBy: string;
  deviceId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ItemDecision =
  | {
      type: 'accept';
      changeType: string;
      item?: ItemRecord;
      unit?: UnitRecord;
      movement?: MovementRecord | null;
      batches?: BatchRecord[];
    }
  | { type: 'reject'; code: string; message: string };

const itemCommands = ['unit.create', 'item.create', 'item.update', 'item.deactivate', 'item.adjust_stock'] as const;

export function toPublicUnit(unit: UnitRecord): PublicUnit {
  return {
    id: unit.id,
    storeId: unit.storeId,
    name: unit.name,
    isActive: unit.isActive,
    revision: unit.revision,
  };
}

export function toPublicItem(item: ItemRecord, batches: BatchRecord[]): PublicItem {
  return {
    id: item.id,
    storeId: item.storeId,
    itemType: item.itemType,
    name: item.name,
    sku: item.sku,
    unitId: item.unitId,
    unitName: item.unitName,
    categoryId: item.categoryId,
    categoryName: item.categoryName,
    salePriceMinor: item.salePriceMinor,
    purchaseCostMinor: item.purchaseCostMinor,
    stockQty: item.stockQty,
    lowStockLevel: item.lowStockLevel,
    fifoCostMinor: fifoCost(batches.filter((batch) => batch.itemId === item.id)),
    isActive: item.isActive,
    revision: item.revision,
  };
}

export function toPublicMovement(movement: MovementRecord): PublicMovement {
  return {
    id: movement.id,
    storeId: movement.storeId,
    itemId: movement.itemId,
    movementType: movement.movementType,
    quantityChange: movement.quantityChange,
    onHandAfter: movement.onHandAfter,
    reference: movement.reference,
    occurredAt: movement.occurredAt,
    actorName: movement.actorName,
    status: movement.status,
    revision: movement.revision,
  };
}

export function toPublicBatch(batch: BatchRecord): PublicBatch {
  return {
    id: batch.id,
    storeId: batch.storeId,
    itemId: batch.itemId,
    receivedOn: batch.receivedOn,
    source: batch.source,
    sourceReference: batch.sourceReference,
    unitCostMinor: batch.unitCostMinor,
    receivedQty: batch.receivedQty,
    remainingQty: batch.remainingQty,
    revision: batch.revision,
  };
}

export function decideItemCommand(input: {
  items: ItemRecord[];
  units: UnitRecord[];
  batches: BatchRecord[];
  movements: MovementRecord[];
  categories: ContactCategoryRef[];
  command: IncomingCommand;
  actorUserId: string;
  actorName: string;
  now: Date;
}): ItemDecision {
  const rejected = (code: string, message: string): ItemDecision => ({ type: 'reject', code, message });
  if (!itemCommands.some((type) => type === input.command.type)) {
    return rejected('validation_error', 'This item change is not supported.');
  }
  const payload = asRecord(input.command.payload);
  if (!payload) {
    return rejected('validation_error', 'Check the item details.');
  }
  if (input.command.type === 'unit.create') {
    return decideUnit(input, payload, rejected);
  }
  if (input.command.type === 'item.create') {
    return decideCreate(input, payload, rejected);
  }
  const id = text(payload.id);
  const baseRevision = payload.baseRevision;
  if (!id || typeof baseRevision !== 'number' || !Number.isInteger(baseRevision)) {
    return rejected('validation_error', 'Check the item details.');
  }
  const current = input.items.find((item) => item.id === id && item.isActive);
  if (!current || current.revision !== baseRevision) {
    return current
      ? rejected('revision_conflict', 'This item changed on another device. Review it and try again.')
      : rejected('not_found', 'This item was not found.');
  }
  if (input.command.type === 'item.deactivate') {
    return {
      type: 'accept',
      changeType: 'item.deactivated',
      item: touchItem(current, input, { isActive: false }),
      movement: null,
      batches: input.batches.filter((batch) => batch.itemId === current.id),
    };
  }
  if (input.command.type === 'item.update') {
    return decideUpdate(input, current, payload, rejected);
  }
  return decideAdjust(input, current, payload, rejected);
}

function decideUnit(
  input: { command: IncomingCommand; units: UnitRecord[]; actorUserId: string; now: Date },
  payload: Record<string, unknown>,
  rejected: (code: string, message: string) => ItemDecision,
): ItemDecision {
  const id = text(payload.id);
  const name = clean(text(payload.name), 40);
  if (!id || !isUuid(id) || !name) {
    return rejected('validation_error', 'Enter the unit name.');
  }
  if (input.units.some((unit) => unit.id === id)) {
    return rejected('conflict', 'This unit already exists.');
  }
  const normalizedName = name.toLowerCase();
  if (input.units.some((unit) => unit.storeId === input.command.storeId && unit.normalizedName === normalizedName)) {
    return rejected('name_taken', 'That unit already exists.');
  }
  const now = input.now;
  return {
    type: 'accept',
    changeType: 'unit.created',
    unit: {
      id,
      storeId: input.command.storeId,
      name,
      normalizedName,
      isActive: true,
      revision: 1,
      createdBy: input.actorUserId,
      updatedBy: input.actorUserId,
      deviceId: input.command.deviceId,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function decideCreate(
  input: {
    command: IncomingCommand;
    items: ItemRecord[];
    units: UnitRecord[];
    batches: BatchRecord[];
    movements: MovementRecord[];
    categories: ContactCategoryRef[];
    actorUserId: string;
    actorName: string;
    now: Date;
  },
  payload: Record<string, unknown>,
  rejected: (code: string, message: string) => ItemDecision,
): ItemDecision {
  const id = text(payload.id);
  const itemType = text(payload.itemType);
  const name = clean(text(payload.name), 120);
  if (!id || !isUuid(id) || !isItemType(itemType) || !name) {
    return rejected('validation_error', 'Enter the item name.');
  }
  if (input.items.some((item) => item.id === id)) {
    return rejected('conflict', 'This item already exists.');
  }
  const sku = optionalSku(payload.sku);
  if (sku === invalid) {
    return rejected('validation_error', 'Check the SKU.');
  }
  if (sku && takenSku(input.items, input.command.storeId, sku, null)) {
    return rejected('sku_taken', 'That SKU is already used.');
  }
  const unit = resolveUnit(input.units, payload.unitId, rejected);
  const category = resolveItemCategory(input.categories, payload.categoryId, rejected);
  if (unit instanceof Rejected) {
    return unit.decision;
  }
  if (category instanceof Rejected) {
    return category.decision;
  }
  const salePrice = minor(payload.salePriceMinor);
  if (salePrice === null) {
    return rejected('validation_error', 'Enter the sale price in MMK.');
  }
  const now = input.now;
  const base: ItemRecord = {
    id,
    storeId: input.command.storeId,
    itemType,
    name,
    normalizedName: name.toLowerCase(),
    sku,
    normalizedSku: sku?.toLowerCase() ?? '',
    unitId: unit?.id ?? null,
    unitName: unit?.name ?? null,
    categoryId: category?.id ?? null,
    categoryName: category?.name ?? null,
    salePriceMinor: salePrice,
    purchaseCostMinor: null,
    stockQty: null,
    lowStockLevel: null,
    isActive: true,
    revision: 1,
    createdBy: input.actorUserId,
    updatedBy: input.actorUserId,
    deviceId: input.command.deviceId,
    createdAt: now,
    updatedAt: now,
  };
  if (itemType === 'SERVICE') {
    return { type: 'accept', changeType: 'item.created', item: base, movement: null, batches: [] };
  }
  const cost = minor(payload.purchaseCostMinor);
  const stock = quantity(payload.stockQty);
  const low = quantity(payload.lowStockLevel ?? 0);
  if (cost === null || stock === null || low === null) {
    return rejected('validation_error', 'Check the cost, stock, and low-stock level.');
  }
  const item: ItemRecord = { ...base, purchaseCostMinor: cost, stockQty: stock, lowStockLevel: low };
  if (stock === 0) {
    return { type: 'accept', changeType: 'item.created', item, movement: null, batches: [] };
  }
  const movementId = text(payload.openingMovementId);
  const batchId = text(payload.openingBatchId);
  const receivedOn = dateOnly(payload.effectiveDate) ?? isoDate(input.now);
  if (!movementId || !isUuid(movementId) || !batchId || !isUuid(batchId) || receivedOn === invalid) {
    return rejected('validation_error', 'Check the opening stock.');
  }
  if (input.movements.some((movement) => movement.id === movementId) || input.batches.some((batch) => batch.id === batchId)) {
    return rejected('conflict', 'This opening stock was already saved.');
  }
  const movement = movementRow(input, {
    id: movementId,
    itemId: id,
    movementType: 'OPENING',
    quantityChange: stock,
    onHandAfter: stock,
    reference: 'Opening',
    occurredAt: `${receivedOn}T09:00:00.000Z`,
  });
  const batch = batchRow(input, {
    id: batchId,
    itemId: id,
    receivedOn,
    source: 'OPENING',
    sourceReference: 'Opening',
    unitCostMinor: cost,
    receivedQty: stock,
    remainingQty: stock,
  });
  return { type: 'accept', changeType: 'item.created', item, movement, batches: [batch] };
}

function decideUpdate(
  input: {
    command: IncomingCommand;
    units: UnitRecord[];
    batches: BatchRecord[];
    categories: ContactCategoryRef[];
    items: ItemRecord[];
    actorUserId: string;
    now: Date;
  },
  current: ItemRecord,
  payload: Record<string, unknown>,
  rejected: (code: string, message: string) => ItemDecision,
): ItemDecision {
  const itemType = text(payload.itemType);
  const name = clean(text(payload.name), 120);
  if (!isItemType(itemType) || !name || itemType !== current.itemType) {
    return rejected('validation_error', 'Enter the item name.');
  }
  const sku = optionalSku(payload.sku);
  if (sku === invalid) {
    return rejected('validation_error', 'Check the SKU.');
  }
  if (sku && takenSku(input.items, current.storeId, sku, current.id)) {
    return rejected('sku_taken', 'That SKU is already used.');
  }
  const unit = resolveUnit(input.units, payload.unitId, rejected);
  const category = resolveItemCategory(input.categories, payload.categoryId, rejected);
  if (unit instanceof Rejected) {
    return unit.decision;
  }
  if (category instanceof Rejected) {
    return category.decision;
  }
  const salePrice = minor(payload.salePriceMinor);
  if (salePrice === null) {
    return rejected('validation_error', 'Enter the sale price in MMK.');
  }
  if (current.itemType === 'SERVICE') {
    return {
      type: 'accept',
      changeType: 'item.updated',
      item: touchItem(current, input, {
        name,
        normalizedName: name.toLowerCase(),
        sku,
        normalizedSku: sku?.toLowerCase() ?? '',
        unitId: unit?.id ?? null,
        unitName: unit?.name ?? null,
        categoryId: category?.id ?? null,
        categoryName: category?.name ?? null,
        salePriceMinor: salePrice,
      }),
      movement: null,
      batches: [],
    };
  }
  const cost = minor(payload.purchaseCostMinor);
  const low = quantity(payload.lowStockLevel ?? current.lowStockLevel ?? 0);
  if (cost === null || low === null) {
    return rejected('validation_error', 'Check the cost and low-stock level.');
  }
  return {
    type: 'accept',
    changeType: 'item.updated',
    item: touchItem(current, input, {
      name,
      normalizedName: name.toLowerCase(),
      sku,
      normalizedSku: sku?.toLowerCase() ?? '',
      unitId: unit?.id ?? null,
      unitName: unit?.name ?? null,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      salePriceMinor: salePrice,
      purchaseCostMinor: cost,
      lowStockLevel: low,
    }),
    movement: null,
    batches: input.batches.filter((batch) => batch.itemId === current.id),
  };
}

function decideAdjust(
  input: {
    command: IncomingCommand;
    batches: BatchRecord[];
    movements: MovementRecord[];
    actorUserId: string;
    actorName: string;
    now: Date;
  },
  current: ItemRecord,
  payload: Record<string, unknown>,
  rejected: (code: string, message: string) => ItemDecision,
): ItemDecision {
  if (current.itemType !== 'PRODUCT' || current.stockQty === null || current.purchaseCostMinor === null) {
    return rejected('validation_error', 'A service does not track stock.');
  }
  const counted = quantity(payload.countedQty);
  const reason = clean(text(payload.reason), 120);
  const receivedOn = dateOnly(payload.effectiveDate);
  const movementId = text(payload.movementId);
  if (counted === null || !reason || typeof receivedOn !== 'string' || !movementId || !isUuid(movementId)) {
    return rejected('validation_error', 'Enter the counted quantity, date, and reason.');
  }
  if (input.movements.some((movement) => movement.id === movementId)) {
    return rejected('conflict', 'This stock adjustment was already saved.');
  }
  const change = counted - current.stockQty;
  if (change === 0) {
    return rejected('validation_error', 'The counted quantity matches the stock on hand.');
  }
  const owned = input.batches.filter((batch) => batch.itemId === current.id);
  if (change < 0) {
    const consumed = consume(owned, -change);
    if (consumed === null) {
      return rejected('insufficient_stock', 'The open cost batches do not cover this count.');
    }
    return {
      type: 'accept',
      changeType: 'item.stock_adjusted',
      item: touchItem(current, input, { stockQty: counted }),
      movement: movementRow(input, {
        id: movementId,
        itemId: current.id,
        movementType: 'ADJUSTMENT',
        quantityChange: change,
        onHandAfter: counted,
        reference: reason,
        occurredAt: atTime(receivedOn, input.now),
      }),
      batches: consumed,
    };
  }
  const batchId = text(payload.batchId);
  if (!batchId || !isUuid(batchId) || owned.some((batch) => batch.id === batchId)) {
    return rejected('validation_error', 'Check the stock receipt.');
  }
  const batch = batchRow(input, {
    id: batchId,
    itemId: current.id,
    receivedOn,
    source: 'ADJUSTMENT',
    sourceReference: reason,
    unitCostMinor: current.purchaseCostMinor,
    receivedQty: change,
    remainingQty: change,
  });
  return {
    type: 'accept',
    changeType: 'item.stock_adjusted',
    item: touchItem(current, input, { stockQty: counted }),
    movement: movementRow(input, {
      id: movementId,
      itemId: current.id,
      movementType: 'ADJUSTMENT',
      quantityChange: change,
      onHandAfter: counted,
      reference: reason,
      occurredAt: atTime(receivedOn, input.now),
    }),
    batches: [...owned, batch],
  };
}

function consume(batches: BatchRecord[], qty: number): BatchRecord[] | null {
  let left = qty;
  const next = orderBatches(batches).map((batch) => {
    if (left <= 0 || batch.remainingQty <= 0) {
      return batch;
    }
    const take = Math.min(batch.remainingQty, left);
    left -= take;
    return { ...batch, remainingQty: batch.remainingQty - take, revision: batch.revision + 1 };
  });
  return left === 0 ? next : null;
}

export function fifoCost(batches: BatchRecord[] | PublicBatch[]): number | null {
  const open = orderBatches(batches).find((batch) => batch.remainingQty > 0);
  return open?.unitCostMinor ?? null;
}

function orderBatches<T extends { receivedOn: string; id: string; remainingQty: number }>(batches: T[]): T[] {
  return [...batches].sort((left, right) => left.receivedOn.localeCompare(right.receivedOn) || left.id.localeCompare(right.id));
}

function movementRow(
  input: { command: IncomingCommand; actorName: string; now: Date },
  row: Omit<PublicMovement, 'storeId' | 'actorName' | 'status' | 'revision'>,
): MovementRecord {
  return {
    ...row,
    storeId: input.command.storeId,
    actorName: input.actorName,
    status: 'ACTIVE',
    revision: 1,
    createdAt: input.now,
  };
}

function batchRow(
  input: { command: IncomingCommand; now: Date },
  row: Omit<PublicBatch, 'storeId' | 'revision'>,
): BatchRecord {
  return { ...row, storeId: input.command.storeId, revision: 1, createdAt: input.now };
}

function touchItem(
  current: ItemRecord,
  input: { actorUserId: string; command: IncomingCommand; now: Date },
  patch: Partial<ItemRecord>,
): ItemRecord {
  return {
    ...current,
    ...patch,
    revision: current.revision + 1,
    updatedBy: input.actorUserId,
    deviceId: input.command.deviceId,
    updatedAt: input.now,
  };
}

class Rejected {
  constructor(readonly decision: ItemDecision) {}
}

const invalid = Symbol('invalid');

function resolveUnit(
  units: UnitRecord[],
  unitId: unknown,
  rejected: (code: string, message: string) => ItemDecision,
): UnitRecord | null | Rejected {
  if (unitId === undefined || unitId === null || unitId === '') {
    return null;
  }
  if (typeof unitId !== 'string') {
    return new Rejected(rejected('validation_error', 'Choose a unit.'));
  }
  const unit = units.find((item) => item.id === unitId && item.isActive);
  if (!unit) {
    return new Rejected(rejected('validation_error', 'Choose a unit.'));
  }
  return unit;
}

function resolveItemCategory(
  categories: ContactCategoryRef[],
  categoryId: unknown,
  rejected: (code: string, message: string) => ItemDecision,
): ContactCategoryRef | null | Rejected {
  if (categoryId === undefined || categoryId === null || categoryId === '') {
    return null;
  }
  if (typeof categoryId !== 'string') {
    return new Rejected(rejected('validation_error', 'Choose an item category.'));
  }
  const category = categories.find((item) => item.id === categoryId);
  if (!category || category.kind !== 'ITEM' || !category.isActive) {
    return new Rejected(rejected('validation_error', 'Choose an item category.'));
  }
  return category;
}

function takenSku(items: ItemRecord[], storeId: string, sku: string, exceptId: string | null): boolean {
  const normalized = sku.toLowerCase();
  return items.some(
    (item) => item.storeId === storeId && item.id !== exceptId && item.isActive && item.normalizedSku === normalized,
  );
}

function optionalSku(value: unknown): string | null | typeof invalid {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return clean(text(value), 40) ?? invalid;
}

function clean(value: string | null, max: number): string | null {
  if (!value) {
    return null;
  }
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length === 0 || name.length > max) {
    return null;
  }
  return name;
}

function minor(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000_000) {
    return null;
  }
  return value;
}

function quantity(value: unknown): number | null {
  return minor(value);
}

function dateOnly(value: unknown): string | null | typeof invalid {
  if (value === undefined || value === null || value === '') {
    return null;
  }
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

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function atTime(date: string, now: Date): string {
  const hours = now.getUTCHours().toString().padStart(2, '0');
  const minutes = now.getUTCMinutes().toString().padStart(2, '0');
  return `${date}T${hours}:${minutes}:00.000Z`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isItemType(value: string | null): value is ItemType {
  return itemTypes.some((type) => type === value);
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

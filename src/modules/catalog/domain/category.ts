import { newId } from '../../auth/application/token.js';
import type { PublicContact } from './contact.js';
import type { PublicHeldSale } from './held-sale.js';
import type { PublicSale } from './sale.js';
import type { PublicPurchase } from './purchase.js';
import type { PublicPaymentMethod, PublicStore } from './shop-settings.js';
import type { PublicCashAccount, PublicCashMovement, PublicReconciliation } from './cash.js';
import type { PublicExpense } from './expense.js';
import type { PublicBatch, PublicItem, PublicMovement, PublicUnit } from './item.js';

export const categoryKinds = ['ITEM', 'EXPENSE', 'CONTACT', 'INCOME'] as const;
export type CategoryKind = (typeof categoryKinds)[number];

export const commandTypes = [
  'category.create',
  'category.rename',
  'category.update_description',
  'category.set_active',
] as const;
export type CommandType = (typeof commandTypes)[number];

export type PublicCategory = {
  id: string;
  storeId: string;
  kind: CategoryKind;
  name: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
  revision: number;
};

export type CategoryRecord = PublicCategory & {
  normalizedName: string;
  createdBy: string;
  updatedBy: string;
  deviceId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredCommand = {
  id: string;
  storeId: string;
  deviceId: string;
  actorUserId: string;
  type: string;
  status: 'accepted' | 'rejected';
  code: string | null;
  message: string | null;
  changeSequence: number | null;
  category: PublicCategory | null;
  contact?: PublicContact | null;
  unit?: PublicUnit | null;
  item?: PublicItem | null;
  movement?: PublicMovement | null;
  batches?: PublicBatch[] | null;
  expense?: PublicExpense | null;
  account?: PublicCashAccount | null;
  cashMovements?: PublicCashMovement[] | null;
  reconciliation?: PublicReconciliation | null;
  sale?: PublicSale | null;
  heldSale?: PublicHeldSale | null;
  purchase?: PublicPurchase | null;
  store?: PublicStore | null;
  paymentMethods?: PublicPaymentMethod[] | null;
};

export type IncomingCommand = {
  id: string;
  storeId: string;
  deviceId: string;
  type: string;
  payload: unknown;
};

export type CatalogDecision =
  | { type: 'replay'; command: StoredCommand }
  | {
      type: 'accept';
      command: StoredCommand;
      category: CategoryRecord;
      changeType: string;
      sequence: number;
    }
  | { type: 'reject'; command: StoredCommand };

const nameLimit = 80;
const descriptionLimit = 240;

export function normalizeCategoryName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function toPublicCategory(category: CategoryRecord): PublicCategory {
  return {
    id: category.id,
    storeId: category.storeId,
    kind: category.kind,
    name: category.name,
    description: category.description,
    isActive: category.isActive,
    sortOrder: category.sortOrder,
    revision: category.revision,
  };
}

export function seedCategories(input: {
  storeId: string;
  actorUserId: string;
  deviceId: string;
  now: Date;
}): CategoryRecord[] {
  const counts = new Map<CategoryKind, number>();
  return seedDefinitions.map((definition) => {
    const sortOrder = counts.get(definition.kind) ?? 0;
    counts.set(definition.kind, sortOrder + 1);
    return {
    id: newId(),
    storeId: input.storeId,
    kind: definition.kind,
    name: definition.name,
    normalizedName: normalizeCategoryName(definition.name),
    description: definition.description,
    isActive: definition.isActive,
    sortOrder,
    revision: 1,
    createdBy: input.actorUserId,
    updatedBy: input.actorUserId,
    deviceId: input.deviceId,
    createdAt: input.now,
    updatedAt: input.now,
  };
  });
}

export function decideCategoryCommand(input: {
  categories: CategoryRecord[];
  lastSequence: number;
  existingCommand: StoredCommand | null;
  command: IncomingCommand;
  actorUserId: string;
  now: Date;
}): CatalogDecision {
  if (input.existingCommand) {
    return { type: 'replay', command: input.existingCommand };
  }
  const rejected = (
    code: string,
    message: string,
  ): CatalogDecision => ({
    type: 'reject',
    command: {
      id: input.command.id,
      storeId: input.command.storeId,
      deviceId: input.command.deviceId,
      actorUserId: input.actorUserId,
      type: input.command.type,
      status: 'rejected',
      code,
      message,
      changeSequence: null,
      category: null,
    },
  });

  if (!isCommandType(input.command.type)) {
    return rejected('validation_error', 'This category change is not supported.');
  }
  const payload = asRecord(input.command.payload);
  if (!payload) {
    return rejected('validation_error', 'Check the category details.');
  }

  if (input.command.type === 'category.create') {
    return decideCreate(input, payload, rejected);
  }
  return decideUpdate(input, payload, rejected);
}

function decideCreate(
  input: {
    categories: CategoryRecord[];
    lastSequence: number;
    command: IncomingCommand;
    actorUserId: string;
    now: Date;
  },
  payload: Record<string, unknown>,
  rejected: (code: string, message: string) => CatalogDecision,
): CatalogDecision {
  const id = text(payload.id);
  const kind = text(payload.kind);
  const name = text(payload.name);
  const description = text(payload.description) ?? '';
  if (!id || !isCategoryKind(kind) || !name || name.trim().length > nameLimit) {
    return rejected('validation_error', 'Enter a category name.');
  }
  if (description.trim().length > descriptionLimit) {
    return rejected('validation_error', 'Use a shorter description.');
  }
  const trimmedName = name.trim().replace(/\s+/g, ' ');
  if (trimmedName.length === 0) {
    return rejected('validation_error', 'Enter a category name.');
  }
  if (input.categories.some((category) => category.id === id)) {
    return rejected('conflict', 'This category already exists.');
  }
  const normalizedName = normalizeCategoryName(trimmedName);
  if (
    input.categories.some(
      (category) => category.kind === kind && category.normalizedName === normalizedName,
    )
  ) {
    return rejected('name_taken', 'A category with this name already exists.');
  }
  const sortOrder =
    input.categories
      .filter((category) => category.kind === kind)
      .reduce((max, category) => Math.max(max, category.sortOrder), -1) + 1;
  const category: CategoryRecord = {
    id,
    storeId: input.command.storeId,
    kind,
    name: trimmedName,
    normalizedName,
    description: description.trim(),
    isActive: true,
    sortOrder,
    revision: 1,
    createdBy: input.actorUserId,
    updatedBy: input.actorUserId,
    deviceId: input.command.deviceId,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return accept(input, category, 'category.created');
}

function decideUpdate(
  input: {
    categories: CategoryRecord[];
    lastSequence: number;
    command: IncomingCommand;
    actorUserId: string;
    now: Date;
  },
  payload: Record<string, unknown>,
  rejected: (code: string, message: string) => CatalogDecision,
): CatalogDecision {
  const id = text(payload.id);
  const baseRevision = payload.baseRevision;
  if (!id || typeof baseRevision !== 'number' || !Number.isInteger(baseRevision)) {
    return rejected('validation_error', 'Check the category details.');
  }
  const current = input.categories.find((category) => category.id === id);
  if (!current) {
    return rejected('not_found', 'This category was not found.');
  }
  if (current.revision !== baseRevision) {
    return rejected('revision_conflict', 'This category changed on another device. Review it and try again.');
  }

  if (input.command.type === 'category.rename') {
    const name = text(payload.name);
    if (!name || name.trim().length > nameLimit) {
      return rejected('validation_error', 'Enter a category name.');
    }
    const trimmedName = name.trim().replace(/\s+/g, ' ');
    const normalizedName = normalizeCategoryName(trimmedName);
    if (
      input.categories.some(
        (category) =>
          category.id !== id &&
          category.kind === current.kind &&
          category.normalizedName === normalizedName,
      )
    ) {
      return rejected('name_taken', 'A category with this name already exists.');
    }
    return accept(
      input,
      {
        ...current,
        name: trimmedName,
        normalizedName,
        revision: current.revision + 1,
        updatedBy: input.actorUserId,
        deviceId: input.command.deviceId,
        updatedAt: input.now,
      },
      'category.renamed',
    );
  }

  if (input.command.type === 'category.update_description') {
    const description = text(payload.description) ?? '';
    if (description.trim().length > descriptionLimit) {
      return rejected('validation_error', 'Use a shorter description.');
    }
    return accept(
      input,
      {
        ...current,
        description: description.trim(),
        revision: current.revision + 1,
        updatedBy: input.actorUserId,
        deviceId: input.command.deviceId,
        updatedAt: input.now,
      },
      'category.description_updated',
    );
  }

  if (typeof payload.isActive !== 'boolean') {
    return rejected('validation_error', 'Check the category details.');
  }
  return accept(
    input,
    {
      ...current,
      isActive: payload.isActive,
      revision: current.revision + 1,
      updatedBy: input.actorUserId,
      deviceId: input.command.deviceId,
      updatedAt: input.now,
    },
    'category.activation_changed',
  );
}

function accept(
  input: { command: IncomingCommand; actorUserId: string; lastSequence: number },
  category: CategoryRecord,
  changeType: string,
): CatalogDecision {
  const sequence = input.lastSequence + 1;
  const publicCategory = toPublicCategory(category);
  return {
    type: 'accept',
    category,
    changeType,
    sequence,
    command: {
      id: input.command.id,
      storeId: input.command.storeId,
      deviceId: input.command.deviceId,
      actorUserId: input.actorUserId,
      type: input.command.type,
      status: 'accepted',
      code: null,
      message: null,
      changeSequence: sequence,
      category: publicCategory,
    },
  };
}

function isCategoryKind(value: string | null): value is CategoryKind {
  return categoryKinds.some((kind) => kind === value);
}

function isCommandType(value: string): value is CommandType {
  return commandTypes.some((type) => type === value);
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

const seedDefinitions: Array<{
  kind: CategoryKind;
  name: string;
  description: string;
  isActive: boolean;
}> = [
  { kind: 'ITEM', name: 'Grocery', description: 'Dry food and rice', isActive: true },
  { kind: 'ITEM', name: 'Drinks', description: 'Bottles and cans', isActive: true },
  { kind: 'ITEM', name: 'Household', description: 'Cleaning supplies', isActive: true },
  { kind: 'ITEM', name: 'Personal care', description: 'Soap and shampoo', isActive: true },
  { kind: 'ITEM', name: 'Snacks', description: 'Biscuits and sweets', isActive: true },
  { kind: 'ITEM', name: 'Old season', description: 'Kept for past invoices', isActive: false },
  { kind: 'EXPENSE', name: 'Rent', description: 'Shop rent', isActive: true },
  { kind: 'EXPENSE', name: 'Utilities', description: 'Electricity and water', isActive: true },
  { kind: 'EXPENSE', name: 'Transport', description: 'Delivery', isActive: true },
  { kind: 'EXPENSE', name: 'Wages', description: 'Staff pay', isActive: true },
  { kind: 'EXPENSE', name: 'Supplies', description: 'Bags and stationery', isActive: true },
  { kind: 'CONTACT', name: 'Customer', description: 'People who buy', isActive: true },
  { kind: 'CONTACT', name: 'Supplier', description: 'People who sell to the shop', isActive: true },
  { kind: 'CONTACT', name: 'Staff', description: 'Shop workers', isActive: true },
  { kind: 'CONTACT', name: 'Other', description: 'Everyone else', isActive: true },
  { kind: 'INCOME', name: 'Sales', description: 'Money from sales', isActive: true },
  { kind: 'INCOME', name: 'Other income', description: 'Money that is not a sale', isActive: true },
];

import type { CategoryRecord, IncomingCommand } from './category.js';

export const expenseStatuses = ['PAID', 'VOID'] as const;
export type ExpenseStatus = (typeof expenseStatuses)[number];

export type PublicExpense = {
  id: string;
  storeId: string;
  title: string;
  categoryId: string | null;
  categoryName: string | null;
  amountMinor: number;
  accountName: string;
  paymentMethodName: string;
  effectiveDate: string;
  note: string;
  status: ExpenseStatus;
  actorName: string;
  isActive: boolean;
  revision: number;
};

export type ExpenseRecord = PublicExpense & {
  createdBy: string;
  updatedBy: string;
  deviceId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ExpenseDecision =
  | { type: 'accept'; changeType: string; expense: ExpenseRecord }
  | { type: 'reject'; code: string; message: string };

const invalid = Symbol('invalid');

export function toPublicExpense(expense: ExpenseRecord): PublicExpense {
  return {
    id: expense.id,
    storeId: expense.storeId,
    title: expense.title,
    categoryId: expense.categoryId,
    categoryName: expense.categoryName,
    amountMinor: expense.amountMinor,
    accountName: expense.accountName,
    paymentMethodName: expense.paymentMethodName,
    effectiveDate: expense.effectiveDate,
    note: expense.note,
    status: expense.status,
    actorName: expense.actorName,
    isActive: expense.isActive,
    revision: expense.revision,
  };
}

export function decideExpenseCommand(input: {
  expenses: ExpenseRecord[];
  categories: CategoryRecord[];
  command: IncomingCommand;
  actorUserId: string;
  actorName: string;
  now: Date;
}): ExpenseDecision {
  const payload = asRecord(input.command.payload);
  if (!payload) {
    return reject('validation_error', 'Check the expense details.');
  }
  if (input.command.type === 'expense.create') {
    return createExpense(input, payload);
  }
  const current = input.expenses.find((expense) => expense.id === text(payload.id));
  if (!current || !current.isActive) {
    return reject('not_found', 'This expense was not found.');
  }
  if (current.revision !== baseRevision(payload.baseRevision)) {
    return reject('revision_conflict', 'This expense changed on another device. Review it and try again.');
  }
  if (input.command.type === 'expense.void') {
    return voidExpense(input, current);
  }
  if (input.command.type === 'expense.deactivate') {
    return deactivate(input, current);
  }
  if (input.command.type === 'expense.update') {
    return updateExpense(input, current, payload);
  }
  return reject('validation_error', 'This expense change is not supported.');
}

function createExpense(
  input: {
    expenses: ExpenseRecord[];
    categories: CategoryRecord[];
    command: IncomingCommand;
    actorUserId: string;
    actorName: string;
    now: Date;
  },
  payload: Record<string, unknown>,
): ExpenseDecision {
  const id = text(payload.id);
  if (!id || !isUuid(id) || input.expenses.some((expense) => expense.id === id)) {
    return reject('validation_error', 'Check the expense details.');
  }
  const fields = readFields(input.categories, payload);
  if (fields === invalid) {
    return reject('validation_error', 'Check the expense details.');
  }
  return {
    type: 'accept',
    changeType: 'expense.created',
    expense: {
      id,
      storeId: input.command.storeId,
      ...fields,
      status: 'PAID',
      actorName: input.actorName,
      isActive: true,
      revision: 1,
      createdBy: input.actorUserId,
      updatedBy: input.actorUserId,
      deviceId: input.command.deviceId,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

function updateExpense(
  input: {
    categories: CategoryRecord[];
    actorUserId: string;
    command: IncomingCommand;
    now: Date;
  },
  current: ExpenseRecord,
  payload: Record<string, unknown>,
): ExpenseDecision {
  if (current.status !== 'PAID') {
    return reject('validation_error', 'A void expense cannot be edited.');
  }
  const fields = readFields(input.categories, payload);
  if (fields === invalid) {
    return reject('validation_error', 'Check the expense details.');
  }
  return {
    type: 'accept',
    changeType: 'expense.updated',
    expense: {
      ...current,
      ...fields,
      revision: current.revision + 1,
      updatedBy: input.actorUserId,
      deviceId: input.command.deviceId,
      updatedAt: input.now,
    },
  };
}

function voidExpense(
  input: { actorUserId: string; command: IncomingCommand; now: Date },
  current: ExpenseRecord,
): ExpenseDecision {
  if (current.status !== 'PAID') {
    return reject('validation_error', 'This expense is already void.');
  }
  return {
    type: 'accept',
    changeType: 'expense.voided',
    expense: {
      ...current,
      status: 'VOID',
      revision: current.revision + 1,
      updatedBy: input.actorUserId,
      deviceId: input.command.deviceId,
      updatedAt: input.now,
    },
  };
}

function deactivate(
  input: { actorUserId: string; command: IncomingCommand; now: Date },
  current: ExpenseRecord,
): ExpenseDecision {
  return {
    type: 'accept',
    changeType: 'expense.deactivated',
    expense: {
      ...current,
      isActive: false,
      revision: current.revision + 1,
      updatedBy: input.actorUserId,
      deviceId: input.command.deviceId,
      updatedAt: input.now,
    },
  };
}

function readFields(
  categories: CategoryRecord[],
  payload: Record<string, unknown>,
):
  | {
      title: string;
      categoryId: string | null;
      categoryName: string | null;
      amountMinor: number;
      accountName: string;
      paymentMethodName: string;
      effectiveDate: string;
      note: string;
    }
  | typeof invalid {
  const title = clean(text(payload.title), 120);
  const amount = amountMinor(payload.amountMinor);
  const accountName = clean(text(payload.accountName), 80);
  const paymentMethodName = clean(text(payload.paymentMethodName), 40);
  const effectiveDate = dateOnly(payload.effectiveDate);
  const note = noteOf(payload.note);
  const category = resolveCategory(categories, payload.categoryId);
  if (
    !title ||
    amount === null ||
    !accountName ||
    !paymentMethodName ||
    effectiveDate === invalid ||
    effectiveDate === null ||
    note === invalid ||
    category === invalid
  ) {
    return invalid;
  }
  return {
    title,
    categoryId: category?.id ?? null,
    categoryName: category?.name ?? null,
    amountMinor: amount,
    accountName,
    paymentMethodName,
    effectiveDate,
    note: note ?? '',
  };
}

function resolveCategory(
  categories: CategoryRecord[],
  value: unknown,
): { id: string; name: string } | null | typeof invalid {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    return invalid;
  }
  const category = categories.find((row) => row.id === value);
  if (!category || !category.isActive || category.kind !== 'EXPENSE') {
    return invalid;
  }
  return { id: category.id, name: category.name };
}

function reject(code: string, message: string): ExpenseDecision {
  return { type: 'reject', code, message };
}

function baseRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function amountMinor(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 1_000_000_000) {
    return null;
  }
  return value;
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
  if (name.length === 0 || name.length > max) {
    return null;
  }
  return name;
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

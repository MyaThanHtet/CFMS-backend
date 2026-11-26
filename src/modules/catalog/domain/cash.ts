import { newId } from '../../auth/application/token.js';
import type { CategoryRecord, IncomingCommand } from './category.js';
import type { ContactRecord } from './contact.js';
import type { ExpenseRecord } from './expense.js';

export const accountTypes = ['CASH', 'BANK', 'WALLET'] as const;
export type AccountType = (typeof accountTypes)[number];
export const cashSources = ['OPENING', 'INCOME', 'EXPENSE', 'TRANSFER', 'WITHDRAWAL', 'REFUND'] as const;
export type CashSource = (typeof cashSources)[number];

export type PublicCashAccount = {
  id: string;
  storeId: string;
  name: string;
  accountType: AccountType;
  openingMinor: number;
  isActive: boolean;
  revision: number;
};

export type PublicCashMovement = {
  id: string;
  storeId: string;
  accountId: string;
  direction: 'IN' | 'OUT';
  amountMinor: number;
  source: CashSource;
  description: string;
  sourceReference: string;
  occurredAt: string;
  effectiveDate: string;
  categoryId: string | null;
  categoryName: string | null;
  paymentMethodName: string;
  note: string;
  linkedExpenseId: string | null;
  transferGroupId: string | null;
  status: 'ACTIVE' | 'REVERSED';
  revision: number;
};

export type PublicReconciliation = {
  id: string;
  storeId: string;
  accountId: string;
  cutoffAt: string;
  systemBalanceMinor: number;
  countedMinor: number;
  note: string;
  revision: number;
};

export type CashAccountRecord = PublicCashAccount & {
  normalizedName: string;
  createdBy: string;
  updatedBy: string;
  deviceId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type CashMovementRecord = PublicCashMovement & { createdAt: Date };
export type ReconciliationRecord = PublicReconciliation & {
  createdBy: string;
  deviceId: string;
  createdAt: Date;
};

export type CashDecision =
  | {
      type: 'accept';
      changeType: string;
      account: CashAccountRecord | null;
      movements: CashMovementRecord[];
      reconciliation: ReconciliationRecord | null;
      expense: ExpenseRecord | null;
    }
  | { type: 'reject'; code: string; message: string };

const invalid = Symbol('invalid');

export function seedCashDrawer(input: {
  storeId: string;
  actorUserId: string;
  deviceId: string;
  now: Date;
}): { account: CashAccountRecord; movement: CashMovementRecord } {
  const accountId = newId();
  const date = input.now.toISOString().slice(0, 10);
  const account: CashAccountRecord = {
    id: accountId,
    storeId: input.storeId,
    name: 'Cash drawer',
    normalizedName: 'cash drawer',
    accountType: 'CASH',
    openingMinor: 0,
    isActive: true,
    revision: 1,
    createdBy: input.actorUserId,
    updatedBy: input.actorUserId,
    deviceId: input.deviceId,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return {
    account,
    movement: movement({
      id: newId(),
      storeId: input.storeId,
      accountId,
      direction: 'IN',
      amountMinor: 0,
      source: 'OPENING',
      description: 'Opening balance',
      sourceReference: 'Opening',
      occurredAt: `${date}T00:00:00.000Z`,
      effectiveDate: date,
      now: input.now,
    }),
  };
}

export function toPublicCashAccount(account: CashAccountRecord): PublicCashAccount {
  return {
    id: account.id,
    storeId: account.storeId,
    name: account.name,
    accountType: account.accountType,
    openingMinor: account.openingMinor,
    isActive: account.isActive,
    revision: account.revision,
  };
}

export function toPublicCashMovement(row: CashMovementRecord): PublicCashMovement {
  return {
    id: row.id,
    storeId: row.storeId,
    accountId: row.accountId,
    direction: row.direction,
    amountMinor: row.amountMinor,
    source: row.source,
    description: row.description,
    sourceReference: row.sourceReference,
    occurredAt: row.occurredAt,
    effectiveDate: row.effectiveDate,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    paymentMethodName: row.paymentMethodName,
    note: row.note,
    linkedExpenseId: row.linkedExpenseId,
    transferGroupId: row.transferGroupId,
    status: row.status,
    revision: row.revision,
  };
}

export function toPublicReconciliation(row: ReconciliationRecord): PublicReconciliation {
  return {
    id: row.id,
    storeId: row.storeId,
    accountId: row.accountId,
    cutoffAt: row.cutoffAt,
    systemBalanceMinor: row.systemBalanceMinor,
    countedMinor: row.countedMinor,
    note: row.note,
    revision: row.revision,
  };
}

export function syncLinkedExpense(
  rows: CashMovementRecord[],
  expense: ExpenseRecord,
  accounts: CashAccountRecord[],
  now: Date,
): CashMovementRecord[] {
  if (expense.status !== 'PAID' || !expense.isActive) {
    return reverseLinkedMovements(rows, expense.id, now);
  }
  const account = accounts.find((row) => row.isActive && row.name === expense.accountName);
  return rows
    .filter((row) => row.linkedExpenseId === expense.id && row.status === 'ACTIVE')
    .map((row) => ({
      ...row,
      amountMinor: expense.amountMinor,
      description: expense.title,
      accountId: account?.id ?? row.accountId,
      revision: row.revision + 1,
      createdAt: now,
    }));
}

export function reverseLinkedMovements(rows: CashMovementRecord[], expenseId: string, now: Date): CashMovementRecord[] {
  return rows
    .filter((row) => row.linkedExpenseId === expenseId && row.status === 'ACTIVE')
    .map((row) => ({ ...row, status: 'REVERSED', revision: row.revision + 1, createdAt: now }));
}

export function decideCashCommand(input: {
  accounts: CashAccountRecord[];
  movements: CashMovementRecord[];
  reconciliations: ReconciliationRecord[];
  expenses: ExpenseRecord[];
  contacts: ContactRecord[];
  categories: CategoryRecord[];
  command: IncomingCommand;
  actorUserId: string;
  actorName: string;
  now: Date;
}): CashDecision {
  const payload = asRecord(input.command.payload);
  if (!payload) {
    return reject('validation_error', 'Check the cash details.');
  }
  if (input.command.type === 'account.create') {
    return createAccount(input, payload);
  }
  if (input.command.type === 'cash.in') {
    return cashIn(input, payload);
  }
  if (input.command.type === 'cash.out') {
    return cashOut(input, payload);
  }
  if (input.command.type === 'cash.transfer') {
    return transfer(input, payload);
  }
  if (input.command.type === 'cash.reconcile') {
    return reconcile(input, payload);
  }
  return reject('validation_error', 'This cash change is not supported.');
}

function createAccount(
  input: Parameters<typeof decideCashCommand>[0],
  payload: Record<string, unknown>,
): CashDecision {
  const id = uuid(payload.id);
  const movementId = uuid(payload.openingMovementId);
  const name = clean(text(payload.name), 80);
  const accountType = accountTypeOf(text(payload.accountType));
  const opening = minor(payload.openingMinor, true);
  const effectiveDate = dateOnly(payload.effectiveDate);
  if (!id || !movementId || !name || !accountType || opening === null || effectiveDate === invalid || effectiveDate === null) {
    return reject('validation_error', 'Check the account details.');
  }
  if (input.accounts.some((account) => account.id === id || (account.isActive && account.normalizedName === name.toLowerCase()))) {
    return reject('validation_error', 'This account already exists.');
  }
  const account: CashAccountRecord = {
    id,
    storeId: input.command.storeId,
    name,
    normalizedName: name.toLowerCase(),
    accountType,
    openingMinor: opening,
    isActive: true,
    revision: 1,
    createdBy: input.actorUserId,
    updatedBy: input.actorUserId,
    deviceId: input.command.deviceId,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return accept('account.created', account, [
    movement({
      id: movementId,
      storeId: input.command.storeId,
      accountId: id,
      direction: 'IN',
      amountMinor: opening,
      source: 'OPENING',
      description: 'Opening balance',
      sourceReference: 'Opening',
      occurredAt: `${effectiveDate}T00:00:00.000Z`,
      effectiveDate,
      now: input.now,
    }),
  ]);
}

function cashIn(input: Parameters<typeof decideCashCommand>[0], payload: Record<string, unknown>): CashDecision {
  const id = uuid(payload.id);
  const movementId = uuid(payload.movementId);
  const account = activeAccount(input.accounts, text(payload.accountId));
  const title = clean(text(payload.title), 120);
  const amount = minor(payload.amountMinor, false);
  const method = clean(text(payload.paymentMethodName), 40);
  const effectiveDate = dateOnly(payload.effectiveDate);
  const note = noteOf(payload.note);
  const category = resolveIncome(input.categories, payload.categoryId);
  if (!id || !movementId || !account || !title || amount === null || !method || effectiveDate === invalid || effectiveDate === null || note === invalid || category === invalid) {
    return reject('validation_error', 'Check the cash in details.');
  }
  if (takenMovement(input.movements, movementId)) {
    return reject('validation_error', 'Check the cash in details.');
  }
  return accept('cash.in_recorded', null, [
    movement({
      id: movementId,
      storeId: input.command.storeId,
      accountId: account.id,
      direction: 'IN',
      amountMinor: amount,
      source: 'INCOME',
      description: title,
      sourceReference: category?.name ?? 'Income',
      occurredAt: atTime(effectiveDate, input.now),
      effectiveDate,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      paymentMethodName: method,
      note: note ?? '',
      now: input.now,
    }),
  ]);
}

function cashOut(input: Parameters<typeof decideCashCommand>[0], payload: Record<string, unknown>): CashDecision {
  const movementId = uuid(payload.movementId);
  const account = activeAccount(input.accounts, text(payload.accountId));
  const outflow = text(payload.outflowType);
  const amount = minor(payload.amountMinor, false);
  const method = clean(text(payload.paymentMethodName), 40);
  const effectiveDate = dateOnly(payload.effectiveDate);
  if (!movementId || !account || amount === null || !method || effectiveDate === invalid || effectiveDate === null || takenMovement(input.movements, movementId)) {
    return reject('validation_error', 'Check the cash out details.');
  }
  if (outflow === 'EXPENSE') {
    const expense = input.expenses.find((row) => row.id === text(payload.expenseId) && row.isActive && row.status === 'PAID');
    if (!expense || expense.amountMinor !== amount) {
      return reject('validation_error', 'Choose the expense this payment closes.');
    }
    if (input.movements.some((row) => row.linkedExpenseId === expense.id && row.status === 'ACTIVE')) {
      return reject('already_linked', 'This expense is already on the cash ledger.');
    }
    return accept('cash.out_recorded', null, [
      movement({
        id: movementId,
        storeId: input.command.storeId,
        accountId: account.id,
        direction: 'OUT',
        amountMinor: amount,
        source: 'EXPENSE',
        description: expense.title,
        sourceReference: 'Expense',
        occurredAt: atTime(effectiveDate, input.now),
        effectiveDate,
        paymentMethodName: method,
        linkedExpenseId: expense.id,
        now: input.now,
      }),
    ]);
  }
  const title = clean(text(payload.title), 120);
  if ((outflow !== 'REFUND' && outflow !== 'WITHDRAWAL') || !title) {
    return reject('validation_error', 'Check the cash out details.');
  }
  return accept('cash.out_recorded', null, [
    movement({
      id: movementId,
      storeId: input.command.storeId,
      accountId: account.id,
      direction: 'OUT',
      amountMinor: amount,
      source: outflow === 'REFUND' ? 'REFUND' : 'WITHDRAWAL',
      description: title,
      sourceReference: outflow === 'REFUND' ? 'Refund' : 'Withdrawal',
      occurredAt: atTime(effectiveDate, input.now),
      effectiveDate,
      paymentMethodName: method,
      now: input.now,
    }),
  ]);
}

function transfer(input: Parameters<typeof decideCashCommand>[0], payload: Record<string, unknown>): CashDecision {
  const from = activeAccount(input.accounts, text(payload.fromAccountId));
  const to = activeAccount(input.accounts, text(payload.toAccountId));
  const outId = uuid(payload.outMovementId);
  const inId = uuid(payload.inMovementId);
  const amount = minor(payload.amountMinor, false);
  const fee = minor(payload.feeMinor, true);
  const effectiveDate = dateOnly(payload.effectiveDate);
  if (!from || !to || from.id === to.id || !outId || !inId || outId === inId || amount === null || fee === null || effectiveDate === invalid || effectiveDate === null) {
    return reject('validation_error', 'Check the transfer details.');
  }
  if (takenMovement(input.movements, outId) || takenMovement(input.movements, inId)) {
    return reject('validation_error', 'Check the transfer details.');
  }
  const group = input.command.id;
  const occurredAt = atTime(effectiveDate, input.now);
  const movements = [
    movement({
      id: outId,
      storeId: input.command.storeId,
      accountId: from.id,
      direction: 'OUT',
      amountMinor: amount,
      source: 'TRANSFER',
      description: `Transfer to ${to.name}`,
      sourceReference: to.name,
      occurredAt,
      effectiveDate,
      transferGroupId: group,
      now: input.now,
    }),
    movement({
      id: inId,
      storeId: input.command.storeId,
      accountId: to.id,
      direction: 'IN',
      amountMinor: amount,
      source: 'TRANSFER',
      description: `Transfer from ${from.name}`,
      sourceReference: from.name,
      occurredAt,
      effectiveDate,
      transferGroupId: group,
      now: input.now,
    }),
  ];
  const expense = feeExpense(input, payload, from.name, fee, effectiveDate);
  if (expense === invalid) {
    return reject('validation_error', 'Check the transfer fee.');
  }
  return {
    type: 'accept',
    changeType: 'cash.transferred',
    account: null,
    movements,
    reconciliation: null,
    expense,
  };
}

function reconcile(input: Parameters<typeof decideCashCommand>[0], payload: Record<string, unknown>): CashDecision {
  const id = uuid(payload.id);
  const account = activeAccount(input.accounts, text(payload.accountId));
  const cutoffAt = timestamp(payload.cutoffAt);
  const counted = minor(payload.countedMinor, true);
  const note = noteOf(payload.note);
  if (!id || !account || !cutoffAt || counted === null || note === invalid) {
    return reject('validation_error', 'Check the cash count.');
  }
  if (input.reconciliations.some((row) => row.id === id)) {
    return reject('validation_error', 'Check the cash count.');
  }
  const systemBalanceMinor = balanceAt(account, input.movements, input.expenses, input.contacts, cutoffAt);
  return {
    type: 'accept',
    changeType: 'cash.reconciled',
    account: null,
    movements: [],
    reconciliation: {
      id,
      storeId: input.command.storeId,
      accountId: account.id,
      cutoffAt,
      systemBalanceMinor,
      countedMinor: counted,
      note: note ?? '',
      revision: 1,
      createdBy: input.actorUserId,
      deviceId: input.command.deviceId,
      createdAt: input.now,
    },
    expense: null,
  };
}

export function balanceAt(
  account: CashAccountRecord,
  movements: CashMovementRecord[],
  expenses: ExpenseRecord[],
  contacts: ContactRecord[],
  cutoffAt: string | null,
): number {
  const linked = new Set(
    movements.filter((row) => row.status === 'ACTIVE' && row.linkedExpenseId).map((row) => row.linkedExpenseId),
  );
  let total = 0;
  for (const row of movements) {
    if (row.accountId !== account.id || row.status !== 'ACTIVE' || !within(row.occurredAt, cutoffAt)) {
      continue;
    }
    total += row.direction === 'IN' ? row.amountMinor : -row.amountMinor;
  }
  for (const expense of expenses) {
    if (!expense.isActive || expense.status !== 'PAID' || expense.accountName !== account.name || linked.has(expense.id)) {
      continue;
    }
    if (!within(`${expense.effectiveDate}T00:00:00.000Z`, cutoffAt)) {
      continue;
    }
    total -= expense.amountMinor;
  }
  for (const contact of contacts) {
    for (const settlement of contact.settlements) {
      if (settlement.accountName !== account.name || !within(`${settlement.effectiveDate}T00:00:00.000Z`, cutoffAt)) {
        continue;
      }
      total += settlement.side === 'RECEIVABLE' ? settlement.amountMinor : -settlement.amountMinor;
    }
  }
  return total;
}

function feeExpense(
  input: Parameters<typeof decideCashCommand>[0],
  payload: Record<string, unknown>,
  accountName: string,
  fee: number,
  effectiveDate: string,
): ExpenseRecord | null | typeof invalid {
  if (fee === 0) {
    return null;
  }
  const id = uuid(payload.feeExpenseId);
  if (!id || input.expenses.some((expense) => expense.id === id)) {
    return invalid;
  }
  const transport = input.categories.find((category) => category.kind === 'EXPENSE' && category.isActive && category.name === 'Transport');
  return {
    id,
    storeId: input.command.storeId,
    title: 'Transfer fee',
    categoryId: transport?.id ?? null,
    categoryName: transport?.name ?? null,
    amountMinor: fee,
    accountName,
    paymentMethodName: 'Cash',
    effectiveDate,
    note: '',
    receiptImage: '',
    status: 'PAID',
    actorName: input.actorName,
    isActive: true,
    revision: 1,
    createdBy: input.actorUserId,
    updatedBy: input.actorUserId,
    deviceId: input.command.deviceId,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function accept(
  changeType: string,
  account: CashAccountRecord | null,
  movements: CashMovementRecord[],
): CashDecision {
  return { type: 'accept', changeType, account, movements, reconciliation: null, expense: null };
}

function movement(input: {
  id: string;
  storeId: string;
  accountId: string;
  direction: 'IN' | 'OUT';
  amountMinor: number;
  source: CashSource;
  description: string;
  sourceReference: string;
  occurredAt: string;
  effectiveDate: string;
  categoryId?: string | null;
  categoryName?: string | null;
  paymentMethodName?: string;
  note?: string;
  linkedExpenseId?: string | null;
  transferGroupId?: string | null;
  now: Date;
}): CashMovementRecord {
  return {
    id: input.id,
    storeId: input.storeId,
    accountId: input.accountId,
    direction: input.direction,
    amountMinor: input.amountMinor,
    source: input.source,
    description: input.description,
    sourceReference: input.sourceReference,
    occurredAt: input.occurredAt,
    effectiveDate: input.effectiveDate,
    categoryId: input.categoryId ?? null,
    categoryName: input.categoryName ?? null,
    paymentMethodName: input.paymentMethodName ?? '',
    note: input.note ?? '',
    linkedExpenseId: input.linkedExpenseId ?? null,
    transferGroupId: input.transferGroupId ?? null,
    status: 'ACTIVE',
    revision: 1,
    createdAt: input.now,
  };
}

function within(occurredAt: string, cutoffAt: string | null): boolean {
  return cutoffAt === null || occurredAt <= cutoffAt;
}

function activeAccount(accounts: CashAccountRecord[], id: string | null): CashAccountRecord | null {
  return accounts.find((account) => account.id === id && account.isActive) ?? null;
}

function takenMovement(rows: CashMovementRecord[], id: string): boolean {
  return rows.some((row) => row.id === id);
}

function resolveIncome(
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
  if (!category || !category.isActive || category.kind !== 'INCOME') {
    return invalid;
  }
  return { id: category.id, name: category.name };
}

function reject(code: string, message: string): CashDecision {
  return { type: 'reject', code, message };
}

function accountTypeOf(value: string | null): AccountType | null {
  return accountTypes.find((type) => type === value) ?? null;
}

function minor(value: unknown, allowZero: boolean): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value > 1_000_000_000 || value < (allowZero ? 0 : 1)) {
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

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString();
}

function atTime(date: string, now: Date): string {
  const hours = now.getUTCHours().toString().padStart(2, '0');
  const minutes = now.getUTCMinutes().toString().padStart(2, '0');
  return `${date}T${hours}:${minutes}:00.000Z`;
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

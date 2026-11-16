import type { IncomingCommand } from './category.js';

export const contactTypes = ['CUSTOMER', 'SUPPLIER'] as const;
export type ContactType = (typeof contactTypes)[number];
export const balanceSides = ['RECEIVABLE', 'PAYABLE'] as const;
export type BalanceSide = (typeof balanceSides)[number];

export type PublicSettlement = {
  id: string;
  side: BalanceSide;
  amountMinor: number;
  effectiveDate: string;
  accountName: string;
  paymentMethodName: string;
  note: string;
};

export type PublicContact = {
  id: string;
  storeId: string;
  contactType: ContactType;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  phone: string;
  email: string;
  address: string;
  openingReceivableMinor: number;
  openingPayableMinor: number;
  collectedMinor: number;
  paidMinor: number;
  receivableMinor: number;
  payableMinor: number;
  receivableAsOf: string | null;
  receivableNote: string;
  payableAsOf: string | null;
  payableNote: string;
  settlements: PublicSettlement[];
  isActive: boolean;
  revision: number;
};

export type ContactRecord = PublicContact & {
  normalizedName: string;
  createdBy: string;
  updatedBy: string;
  deviceId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ContactCategoryRef = {
  id: string;
  kind: string;
  name: string;
  isActive: boolean;
};

export type ContactDecision =
  | { type: 'accept'; contact: ContactRecord; changeType: string }
  | { type: 'reject'; code: string; message: string };

const contactCommands = [
  'contact.create',
  'contact.update',
  'contact.deactivate',
  'contact.set_opening_balance',
  'contact.settle',
] as const;

export function toPublicContact(contact: ContactRecord): PublicContact {
  return {
    id: contact.id,
    storeId: contact.storeId,
    contactType: contact.contactType,
    name: contact.name,
    categoryId: contact.categoryId,
    categoryName: contact.categoryName,
    phone: contact.phone,
    email: contact.email,
    address: contact.address,
    openingReceivableMinor: contact.openingReceivableMinor,
    openingPayableMinor: contact.openingPayableMinor,
    collectedMinor: contact.collectedMinor,
    paidMinor: contact.paidMinor,
    receivableMinor: contact.receivableMinor,
    payableMinor: contact.payableMinor,
    receivableAsOf: contact.receivableAsOf,
    receivableNote: contact.receivableNote,
    payableAsOf: contact.payableAsOf,
    payableNote: contact.payableNote,
    settlements: contact.settlements,
    isActive: contact.isActive,
    revision: contact.revision,
  };
}

export function decideContactCommand(input: {
  contacts: ContactRecord[];
  categories: ContactCategoryRef[];
  command: IncomingCommand;
  actorUserId: string;
  now: Date;
}): ContactDecision {
  const rejected = (code: string, message: string): ContactDecision => ({
    type: 'reject',
    code,
    message,
  });
  if (!contactCommands.some((type) => type === input.command.type)) {
    return rejected('validation_error', 'This contact change is not supported.');
  }
  const payload = asRecord(input.command.payload);
  if (!payload) {
    return rejected('validation_error', 'Check the contact details.');
  }
  if (input.command.type === 'contact.create') {
    return decideCreate(input, payload, rejected);
  }
  const id = text(payload.id);
  const baseRevision = payload.baseRevision;
  if (!id || typeof baseRevision !== 'number' || !Number.isInteger(baseRevision)) {
    return rejected('validation_error', 'Check the contact details.');
  }
  const current = input.contacts.find((contact) => contact.id === id);
  if (!current || !current.isActive) {
    return rejected('not_found', 'This contact was not found.');
  }
  if (current.revision !== baseRevision) {
    return rejected('revision_conflict', 'This contact changed on another device. Review it and try again.');
  }
  if (input.command.type === 'contact.deactivate') {
    return {
      type: 'accept',
      changeType: 'contact.deactivated',
      contact: touch(current, input, { isActive: false }),
    };
  }
  if (input.command.type === 'contact.update') {
    return decideUpdate(input, current, payload, rejected);
  }
  if (input.command.type === 'contact.set_opening_balance') {
    return decideOpening(input, current, payload, rejected);
  }
  return decideSettle(input, current, payload, rejected);
}

function decideCreate(
  input: {
    command: IncomingCommand;
    categories: ContactCategoryRef[];
    contacts: ContactRecord[];
    actorUserId: string;
    now: Date;
  },
  payload: Record<string, unknown>,
  rejected: (code: string, message: string) => ContactDecision,
): ContactDecision {
  const id = text(payload.id);
  const contactType = text(payload.contactType);
  const name = cleanName(text(payload.name));
  if (!id || !isContactType(contactType) || !name) {
    return rejected('validation_error', 'Enter the contact name.');
  }
  if (input.contacts.some((contact) => contact.id === id)) {
    return rejected('conflict', 'This contact already exists.');
  }
  const category = resolveCategory(input.categories, payload.categoryId, rejected);
  if (category instanceof Rejected) {
    return category.decision;
  }
  const phone = optionalText(payload.phone, 40);
  const email = optionalEmail(payload.email);
  const address = optionalText(payload.address, 240);
  if (phone === invalid || email === invalid || address === invalid) {
    return rejected('validation_error', 'Check the phone, email, and address.');
  }
  const now = input.now;
  const contact: ContactRecord = {
    id,
    storeId: input.command.storeId,
    contactType,
    name,
    normalizedName: normalize(name),
    categoryId: category?.id ?? null,
    categoryName: category?.name ?? null,
    phone: phone ?? '',
    email: email ?? '',
    address: address ?? '',
    openingReceivableMinor: 0,
    openingPayableMinor: 0,
    collectedMinor: 0,
    paidMinor: 0,
    receivableMinor: 0,
    payableMinor: 0,
    receivableAsOf: null,
    receivableNote: '',
    payableAsOf: null,
    payableNote: '',
    settlements: [],
    isActive: true,
    revision: 1,
    createdBy: input.actorUserId,
    updatedBy: input.actorUserId,
    deviceId: input.command.deviceId,
    createdAt: now,
    updatedAt: now,
  };
  return { type: 'accept', contact, changeType: 'contact.created' };
}

function decideUpdate(
  input: { categories: ContactCategoryRef[]; actorUserId: string; command: IncomingCommand; now: Date },
  current: ContactRecord,
  payload: Record<string, unknown>,
  rejected: (code: string, message: string) => ContactDecision,
): ContactDecision {
  const contactType = text(payload.contactType);
  const name = cleanName(text(payload.name));
  if (!isContactType(contactType) || !name) {
    return rejected('validation_error', 'Enter the contact name.');
  }
  const category = resolveCategory(input.categories, payload.categoryId, rejected);
  if (category instanceof Rejected) {
    return category.decision;
  }
  const phone = optionalText(payload.phone, 40);
  const email = optionalEmail(payload.email);
  const address = optionalText(payload.address, 240);
  if (phone === invalid || email === invalid || address === invalid) {
    return rejected('validation_error', 'Check the phone, email, and address.');
  }
  return {
    type: 'accept',
    changeType: 'contact.updated',
    contact: touch(current, input, {
      contactType,
      name,
      normalizedName: normalize(name),
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      phone: phone ?? '',
      email: email ?? '',
      address: address ?? '',
    }),
  };
}

function decideOpening(
  input: { actorUserId: string; command: IncomingCommand; now: Date },
  current: ContactRecord,
  payload: Record<string, unknown>,
  rejected: (code: string, message: string) => ContactDecision,
): ContactDecision {
  const amount = minor(payload.amountMinor);
  const side = balanceSide(payload.side, current.contactType);
  const date = dateOnly(payload.effectiveDate);
  const note = payload.note === undefined ? undefined : optionalText(payload.note, 240);
  if (amount === null || side === invalid || date === invalid || note === invalid) {
    return rejected('validation_error', 'Check the opening balance.');
  }
  if (side === 'RECEIVABLE') {
    if (amount < current.collectedMinor) {
      return rejected('overpayment', 'The opening balance is smaller than money already received.');
    }
    return {
      type: 'accept',
      changeType: 'contact.opening_balance_set',
      contact: touch(current, input, {
        openingReceivableMinor: amount,
        receivableMinor: amount - current.collectedMinor,
        receivableAsOf: date ?? current.receivableAsOf,
        receivableNote: note ?? current.receivableNote,
      }),
    };
  }
  if (amount < current.paidMinor) {
    return rejected('overpayment', 'The opening balance is smaller than money already paid.');
  }
  return {
    type: 'accept',
    changeType: 'contact.opening_balance_set',
    contact: touch(current, input, {
      openingPayableMinor: amount,
      payableMinor: amount - current.paidMinor,
      payableAsOf: date ?? current.payableAsOf,
      payableNote: note ?? current.payableNote,
    }),
  };
}

function decideSettle(
  input: { actorUserId: string; command: IncomingCommand; now: Date },
  current: ContactRecord,
  payload: Record<string, unknown>,
  rejected: (code: string, message: string) => ContactDecision,
): ContactDecision {
  const amount = minor(payload.amountMinor);
  const side = balanceSide(payload.side, current.contactType);
  if (amount === null || amount === 0 || side === invalid) {
    return rejected('validation_error', 'Enter an amount in MMK.');
  }
  const settlement = settlementFrom(payload, current, rejected);
  if (settlement instanceof Rejected) {
    return settlement.decision;
  }
  if (side === 'RECEIVABLE') {
    if (amount > current.receivableMinor) {
      return rejected('overpayment', 'The amount is more than the receivable balance.');
    }
    return {
      type: 'accept',
      changeType: 'contact.settled',
      contact: touch(current, input, {
        collectedMinor: current.collectedMinor + amount,
        receivableMinor: current.receivableMinor - amount,
        settlements: settlement === null ? current.settlements : [...current.settlements, settlement],
      }),
    };
  }
  if (amount > current.payableMinor) {
    return rejected('overpayment', 'The amount is more than the payable balance.');
  }
  return {
    type: 'accept',
    changeType: 'contact.settled',
    contact: touch(current, input, {
      paidMinor: current.paidMinor + amount,
      payableMinor: current.payableMinor - amount,
      settlements: settlement === null ? current.settlements : [...current.settlements, settlement],
    }),
  };
}

function settlementFrom(
  payload: Record<string, unknown>,
  current: ContactRecord,
  rejected: (code: string, message: string) => ContactDecision,
): PublicSettlement | null | Rejected {
  if (payload.accountName === undefined && payload.settlementId === undefined) {
    return null;
  }
  const accountName = optionalText(payload.accountName, 80);
  const paymentMethodName = optionalText(payload.paymentMethodName, 80);
  const effectiveDate = dateOnly(payload.effectiveDate);
  const note = optionalText(payload.note, 240);
  const id = text(payload.settlementId);
  if (
    accountName !== 'Cash drawer' ||
    paymentMethodName !== 'Cash' ||
    typeof effectiveDate !== 'string' ||
    note === invalid ||
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  ) {
    return new Rejected(rejected('validation_error', 'Check the payment details.'));
  }
  if (current.settlements.some((item) => item.id === id)) {
    return new Rejected(rejected('conflict', 'This payment was already saved.'));
  }
  const amount = minor(payload.amountMinor);
  const side = balanceSide(payload.side, current.contactType);
  if (amount === null || amount === 0 || side === invalid) {
    return new Rejected(rejected('validation_error', 'Check the payment details.'));
  }
  return {
    id,
    side,
    amountMinor: amount,
    effectiveDate,
    accountName,
    paymentMethodName,
    note: note ?? '',
  };
}

function touch(
  current: ContactRecord,
  input: { actorUserId: string; command: IncomingCommand; now: Date },
  patch: Partial<ContactRecord>,
): ContactRecord {
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
  constructor(readonly decision: ContactDecision) {}
}

const invalid = Symbol('invalid');

function resolveCategory(
  categories: ContactCategoryRef[],
  categoryId: unknown,
  rejected: (code: string, message: string) => ContactDecision,
): ContactCategoryRef | null | Rejected {
  if (categoryId === undefined || categoryId === null || categoryId === '') {
    return null;
  }
  if (typeof categoryId !== 'string') {
    return new Rejected(rejected('validation_error', 'Choose a contact category.'));
  }
  const category = categories.find((item) => item.id === categoryId);
  if (!category || category.kind !== 'CONTACT' || !category.isActive) {
    return new Rejected(rejected('validation_error', 'Choose a contact category.'));
  }
  return category;
}

function optionalText(value: unknown, max: number): string | null | typeof invalid {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length > max) {
    return invalid;
  }
  return value.trim();
}

function optionalEmail(value: unknown): string | null | typeof invalid {
  const email = optionalText(value, 120);
  if (email === invalid || email === null || email.length === 0) {
    return email === invalid ? invalid : null;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return invalid;
  }
  return email.toLowerCase();
}

function balanceSide(value: unknown, contactType: ContactType): BalanceSide | typeof invalid {
  if (value === undefined || value === null || value === '') {
    return contactType === 'CUSTOMER' ? 'RECEIVABLE' : 'PAYABLE';
  }
  if (value === 'RECEIVABLE' || value === 'PAYABLE') {
    return value;
  }
  return invalid;
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

function minor(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function cleanName(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length === 0 || name.length > 120) {
    return null;
  }
  return name;
}

function normalize(name: string): string {
  return name.toLowerCase();
}

function isContactType(value: string | null): value is ContactType {
  return contactTypes.some((type) => type === value);
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

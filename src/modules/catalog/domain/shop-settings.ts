import { newId } from '../../auth/application/token.js';

export type PublicStore = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  currencyCode: string;
  currencySymbol: string;
  taxName: string;
  taxRatePercent: number;
  timezone: string;
  revision: number;
};

export type PublicPaymentMethod = {
  id: string;
  storeId: string;
  name: string;
  accountId: string;
  accountName: string;
  isDefault: boolean;
  isActive: boolean;
  revision: number;
};

export type PaymentMethodRecord = PublicPaymentMethod & {
  normalizedName: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ShopDecision =
  | { type: 'accept'; changeType: string; store: PublicStore | null; methods: PaymentMethodRecord[] | null }
  | { type: 'reject'; code: string; message: string };

const invalid = Symbol('invalid');

export function seedCashMethod(storeId: string, accountId: string, now: Date): PaymentMethodRecord {
  return {
    id: newId(),
    storeId,
    name: 'Cash',
    normalizedName: 'cash',
    accountId,
    accountName: 'Cash drawer',
    isDefault: true,
    isActive: true,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function toPublicPaymentMethod(method: PaymentMethodRecord): PublicPaymentMethod {
  return {
    id: method.id,
    storeId: method.storeId,
    name: method.name,
    accountId: method.accountId,
    accountName: method.accountName,
    isDefault: method.isDefault,
    isActive: method.isActive,
    revision: method.revision,
  };
}

export function decideShopCommand(input: {
  store: PublicStore;
  methods: PaymentMethodRecord[];
  accounts: Array<{ id: string; name: string; isActive: boolean }>;
  command: { type: string; payload: unknown };
  now: Date;
}): ShopDecision {
  const payload = asRecord(input.command.payload);
  if (!payload) {
    return reject('validation_error', 'Check the shop settings.');
  }
  if (input.command.type === 'store.profile') {
    return updateProfile(input, payload);
  }
  if (input.command.type === 'store.tax') {
    return updateTax(input, payload);
  }
  if (input.command.type === 'paymentMethod.create') {
    return createMethod(input, payload);
  }
  if (input.command.type === 'paymentMethod.update') {
    return updateMethod(input, payload);
  }
  return reject('validation_error', 'Check the shop settings.');
}

function updateProfile(
  input: Parameters<typeof decideShopCommand>[0],
  payload: Record<string, unknown>,
): ShopDecision {
  if (!matchesRevision(input.store, payload.baseRevision)) {
    return conflict();
  }
  const name = clean(payload.name, 120);
  const address = optional(payload.address, 240);
  const phone = optional(payload.phone, 40);
  const email = optionalEmail(payload.email);
  if (!name || address === invalid || phone === invalid || email === invalid) {
    return reject('validation_error', 'Check the shop profile.');
  }
  return accept('store.profile_updated', { ...input.store, name, address, phone, email, revision: input.store.revision + 1 }, null);
}

function updateTax(input: Parameters<typeof decideShopCommand>[0], payload: Record<string, unknown>): ShopDecision {
  if (!matchesRevision(input.store, payload.baseRevision)) {
    return conflict();
  }
  if (payload.currencyCode !== undefined && payload.currencyCode !== 'MMK') {
    return reject('validation_error', 'This shop uses MMK.');
  }
  if (payload.decimalPlaces !== undefined && payload.decimalPlaces !== 0) {
    return reject('validation_error', 'MMK uses no decimal places.');
  }
  const taxName = clean(payload.taxName, 80);
  const symbol = clean(payload.currencySymbol, 8);
  const rate = percent(payload.taxRatePercent);
  if (!taxName || !symbol || rate === null) {
    return reject('validation_error', 'Check the tax settings.');
  }
  return accept(
    'store.tax_updated',
    { ...input.store, taxName, currencySymbol: symbol, taxRatePercent: rate, revision: input.store.revision + 1 },
    null,
  );
}

function createMethod(input: Parameters<typeof decideShopCommand>[0], payload: Record<string, unknown>): ShopDecision {
  const id = uuid(payload.id);
  const name = clean(payload.name, 40);
  const account = activeAccount(input.accounts, payload.accountId);
  if (!id || !name || !account || typeof payload.isDefault !== 'boolean') {
    return reject('validation_error', 'Check the payment method.');
  }
  if (input.methods.some((method) => method.id === id || (method.isActive && method.normalizedName === name.toLowerCase()))) {
    return reject('validation_error', 'This payment method already exists.');
  }
  const makeDefault = payload.isDefault || input.methods.every((method) => !method.isActive);
  const created: PaymentMethodRecord = {
    id,
    storeId: input.store.id,
    name,
    normalizedName: name.toLowerCase(),
    accountId: account.id,
    accountName: account.name,
    isDefault: makeDefault,
    isActive: true,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const methods = input.methods.map((method) =>
    makeDefault && method.isDefault ? { ...method, isDefault: false, revision: method.revision + 1, updatedAt: input.now } : method,
  );
  methods.push(created);
  return accept('payment_method.created', null, methods);
}

function updateMethod(input: Parameters<typeof decideShopCommand>[0], payload: Record<string, unknown>): ShopDecision {
  const current = input.methods.find((method) => method.id === uuid(payload.id) && method.isActive);
  const name = clean(payload.name, 40);
  const account = activeAccount(input.accounts, payload.accountId);
  const requestedDefault = payload.isDefault;
  const revisionMatches = current !== undefined && current.revision === baseRevision(payload.baseRevision);
  if (!current || !name || !account || typeof requestedDefault !== 'boolean' || !revisionMatches) {
    return current && !revisionMatches
      ? conflict()
      : reject('validation_error', 'Check the payment method.');
  }
  if (input.methods.some((method) => method.id !== current.id && method.isActive && method.normalizedName === name.toLowerCase())) {
    return reject('validation_error', 'This payment method already exists.');
  }
  const activeDefaults = input.methods.filter((method) => method.isActive && method.isDefault && method.id !== current.id);
  if (!requestedDefault && !current.isDefault && activeDefaults.length === 0) {
    return reject('validation_error', 'Choose a default payment method.');
  }
  if (!requestedDefault && current.isDefault && activeDefaults.length === 0) {
    return reject('validation_error', 'Choose another default before removing this one.');
  }
  const methods = input.methods.map((method) => {
    if (method.id === current.id) {
      return {
        ...method,
        name,
        normalizedName: name.toLowerCase(),
        accountId: account.id,
        accountName: account.name,
        isDefault: requestedDefault,
        revision: method.revision + 1,
        updatedAt: input.now,
      };
    }
    if (requestedDefault && method.isDefault) {
      return { ...method, isDefault: false, revision: method.revision + 1, updatedAt: input.now };
    }
    return method;
  });
  return accept('payment_method.updated', null, methods);
}

function accept(changeType: string, store: PublicStore | null, methods: PaymentMethodRecord[] | null): ShopDecision {
  return { type: 'accept', changeType, store, methods };
}

function reject(code: string, message: string): ShopDecision {
  return { type: 'reject', code, message };
}

function conflict(): ShopDecision {
  return reject('revision_conflict', 'This shop changed on another device. Review it and try again.');
}

function matchesRevision(store: PublicStore, value: unknown): boolean {
  return store.revision === baseRevision(value);
}

function activeAccount(
  accounts: Array<{ id: string; name: string; isActive: boolean }>,
  value: unknown,
): { id: string; name: string } | null {
  const id = uuid(value);
  const account = accounts.find((row) => row.id === id && row.isActive);
  return account ? { id: account.id, name: account.name } : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function optional(value: unknown, max: number): string | null | typeof invalid {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return clean(value, max) ?? invalid;
}

function optionalEmail(value: unknown): string | null | typeof invalid {
  const email = optional(value, 120);
  if (email === null || email === invalid) {
    return email;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.toLowerCase() : invalid;
}

function percent(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
}

function uuid(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function baseRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

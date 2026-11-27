import {
  decideCashCommand,
  syncLinkedExpense,
  seedCashDrawer,
  toPublicCashAccount,
  toPublicCashMovement,
  toPublicReconciliation,
} from '../domain/cash.js';
import type { CashAccountRecord, CashMovementRecord, ReconciliationRecord } from '../domain/cash.js';
import { decidePurchaseCommand, toPublicPurchase } from '../domain/purchase.js';
import type { PurchaseRecord } from '../domain/purchase.js';
import { decideHeldSale } from '../domain/held-sale.js';
import type { PublicHeldSale } from '../domain/held-sale.js';
import { decideSaleCommand, toPublicSale } from '../domain/sale.js';
import type { SaleRecord } from '../domain/sale.js';
import { decideExpenseCommand, toPublicExpense } from '../domain/expense.js';
import type { ExpenseRecord } from '../domain/expense.js';
import { decideCategoryCommand, seedCategories, toPublicCategory } from '../domain/category.js';
import type { CategoryRecord, IncomingCommand, StoredCommand } from '../domain/category.js';
import { decideContactCommand, toPublicContact } from '../domain/contact.js';
import type { ContactRecord } from '../domain/contact.js';
import {
  decideItemCommand,
  toPublicBatch,
  toPublicItem,
  toPublicMovement,
  toPublicUnit,
} from '../domain/item.js';
import type { BatchRecord, ItemRecord, MovementRecord, UnitRecord } from '../domain/item.js';
import { decideShopCommand, seedCashMethod, toPublicPaymentMethod } from '../domain/shop-settings.js';
import type { PaymentMethodRecord } from '../domain/shop-settings.js';
import { parseImportedShop } from '../domain/import-backup.js';
import { CatalogError } from '../domain/catalog-error.js';
import type {
  CatalogRepository,
  ChangeEntry,
  CreateStoreInput,
  ImportBackupInput,
  ImportedShopRef,
  StoreRecord,
  StoreSnapshot,
} from '../application/ports.js';

export class MemoryCatalogRepository implements CatalogRepository {
  private readonly stores = new Map<string, StoreRecord>();
  private readonly heldSales = new Map<string, PublicHeldSale>();
  private readonly members = new Set<string>();
  private readonly categories = new Map<string, CategoryRecord>();
  private readonly contacts = new Map<string, ContactRecord>();
  private readonly units = new Map<string, UnitRecord>();
  private readonly items = new Map<string, ItemRecord>();
  private readonly movements = new Map<string, MovementRecord>();
  private readonly batches = new Map<string, BatchRecord>();
  private readonly expenses = new Map<string, ExpenseRecord>();
  private readonly accounts = new Map<string, CashAccountRecord>();
  private readonly cashMovements = new Map<string, CashMovementRecord>();
  private readonly reconciliations = new Map<string, ReconciliationRecord>();
  private readonly sales = new Map<string, SaleRecord>();
  private readonly purchases = new Map<string, PurchaseRecord>();
  private readonly paymentMethods = new Map<string, PaymentMethodRecord>();
  private readonly commands = new Map<string, StoredCommand>();
  private readonly changeLog = new Map<string, ChangeEntry[]>();
  private readonly sequences = new Map<string, number>();
  private readonly cursors = new Map<string, number>();

  async findStore(id: string): Promise<StoreRecord | null> {
    return this.stores.get(id) ?? null;
  }

  async listOwnedStores(userId: string) {
    return [...this.stores.values()]
      .filter((store) => store.ownerId === userId)
      .reverse()
      .map((store) => ({ id: store.id, name: store.name }));
  }

  async isMember(storeId: string, userId: string): Promise<boolean> {
    return this.members.has(memberKey(storeId, userId));
  }

  async createStore(input: CreateStoreInput, now: Date): Promise<StoreSnapshot> {
    const store: StoreRecord = {
      id: input.id,
      name: input.name,
      address: input.address,
      phone: input.phone,
      email: input.email,
      currencyCode: 'MMK',
      currencySymbol: 'Ks',
      taxName: 'Commercial tax',
      taxRatePercent: 0,
      timezone: 'Asia/Yangon',
      revision: 1,
      ownerId: input.actorUserId,
    };
    this.stores.set(store.id, store);
    this.members.add(memberKey(store.id, input.actorUserId));
    const seeded = seedCategories({
      storeId: store.id,
      actorUserId: input.actorUserId,
      deviceId: input.deviceId,
      now,
    });
    const changes: ChangeEntry[] = seeded.map((category, index) => {
      this.categories.set(category.id, category);
      return {
        sequence: index + 1,
        storeId: store.id,
        aggregateType: 'category',
        aggregateId: category.id,
        type: 'category.created',
        commandId: `seed:${category.id}`,
        category: toPublicCategory(category),
      };
    });
    const drawer = seedCashDrawer({
      storeId: store.id,
      actorUserId: input.actorUserId,
      deviceId: input.deviceId,
      now,
    });
    this.accounts.set(drawer.account.id, drawer.account);
    this.cashMovements.set(drawer.movement.id, drawer.movement);
    const cashMethod = seedCashMethod(store.id, drawer.account.id, now);
    this.paymentMethods.set(cashMethod.id, cashMethod);
    changes.push({
      sequence: changes.length + 1,
      storeId: store.id,
      aggregateType: 'account',
      aggregateId: drawer.account.id,
      type: 'account.created',
      commandId: `seed:${drawer.account.id}`,
      account: toPublicCashAccount(drawer.account),
      cashMovements: [toPublicCashMovement(drawer.movement)],
    });
    this.changeLog.set(store.id, changes);
    this.sequences.set(store.id, changes.length);
    return this.snapshot(store.id);
  }

  async importBackup(input: ImportBackupInput, now: Date): Promise<ImportedShopRef> {
    const shop = parseImportedShop(input.tables, { ...input, now });
    const existing = this.stores.get(shop.store.id);
    if (existing && existing.ownerId !== input.actorUserId) {
      throw new CatalogError('store_taken', 'This shop already belongs to another account.', 409);
    }
    if (!existing) {
      this.stores.set(shop.store.id, shop.store);
      this.members.add(memberKey(shop.store.id, input.actorUserId));
      for (const row of shop.categories) this.categories.set(row.id, row);
      for (const row of shop.contacts) this.contacts.set(row.id, row);
      for (const row of shop.units) this.units.set(row.id, row);
      for (const row of shop.items) this.items.set(row.id, row);
      for (const row of shop.movements) this.movements.set(row.id, row);
      for (const row of shop.batches) this.batches.set(row.id, row);
      for (const row of shop.expenses) this.expenses.set(row.id, row);
      for (const row of shop.accounts) this.accounts.set(row.id, row);
      for (const row of shop.cashMovements) this.cashMovements.set(row.id, row);
      for (const row of shop.reconciliations) this.reconciliations.set(row.id, row);
      for (const row of shop.sales) this.sales.set(row.id, row);
      for (const row of shop.purchases) this.purchases.set(row.id, row);
      for (const row of shop.paymentMethods) this.paymentMethods.set(row.id, row);
      this.sequences.set(shop.store.id, 0);
    }
    return { storeId: shop.store.id, ids: shop.ids };
  }

  async submitCommand(actorUserId: string, command: IncomingCommand, now: Date): Promise<StoredCommand> {
    const existing = this.commands.get(command.id);
    if (existing) {
      return existing;
    }
    if (command.type.startsWith('store.') || command.type.startsWith('paymentMethod.')) {
      return this.submitShop(actorUserId, command, now);
    }
    if (command.type.startsWith('contact.')) {
      return this.submitContact(actorUserId, command, now);
    }
    if (command.type.startsWith('item.') || command.type.startsWith('unit.')) {
      return this.submitItem(actorUserId, command, now);
    }
    if (command.type.startsWith('expense.')) {
      return this.submitExpense(actorUserId, command, now);
    }
    if (command.type.startsWith('cash.') || command.type === 'account.create') {
      return this.submitCash(actorUserId, command, now);
    }
    if (command.type.startsWith('heldSale.')) {
      return this.submitHeld(actorUserId, command);
    }
    if (command.type.startsWith('sale.')) {
      return this.submitSale(actorUserId, command, now);
    }
    if (command.type.startsWith('purchase.')) {
      return this.submitPurchase(actorUserId, command, now);
    }
    const decision = decideCategoryCommand({
      categories: this.categoriesFor(command.storeId),
      lastSequence: this.sequences.get(command.storeId) ?? 0,
      existingCommand: null,
      command,
      actorUserId,
      now,
    });
    if (decision.type === 'replay') {
      return decision.command;
    }
    this.commands.set(command.id, decision.command);
    if (decision.type === 'accept') {
      this.categories.set(decision.category.id, decision.category);
      const page = this.changeLog.get(command.storeId) ?? [];
      page.push({
        sequence: decision.sequence,
        storeId: command.storeId,
        aggregateType: 'category',
        aggregateId: decision.category.id,
        type: decision.changeType,
        commandId: command.id,
        category: toPublicCategory(decision.category),
      });
      this.changeLog.set(command.storeId, page);
      this.sequences.set(command.storeId, decision.sequence);
    }
    return decision.command;
  }

  private submitContact(actorUserId: string, command: IncomingCommand, now: Date): StoredCommand {
    const decision = decideContactCommand({
      contacts: this.contactsFor(command.storeId),
      categories: this.categoriesFor(command.storeId),
      command,
      actorUserId,
      now,
    });
    const sequence = (this.sequences.get(command.storeId) ?? 0) + (decision.type === 'accept' ? 1 : 0);
    const stored: StoredCommand = {
      id: command.id,
      storeId: command.storeId,
      deviceId: command.deviceId,
      actorUserId,
      type: command.type,
      status: decision.type === 'accept' ? 'accepted' : 'rejected',
      code: decision.type === 'reject' ? decision.code : null,
      message: decision.type === 'reject' ? decision.message : null,
      changeSequence: decision.type === 'accept' ? sequence : null,
      category: null,
      contact: decision.type === 'accept' ? toPublicContact(decision.contact) : null,
    };
    this.commands.set(command.id, stored);
    if (decision.type === 'accept') {
      this.contacts.set(decision.contact.id, decision.contact);
      const page = this.changeLog.get(command.storeId) ?? [];
      page.push({
        sequence,
        storeId: command.storeId,
        aggregateType: 'contact',
        aggregateId: decision.contact.id,
        type: decision.changeType,
        commandId: command.id,
        contact: toPublicContact(decision.contact),
      });
      this.changeLog.set(command.storeId, page);
      this.sequences.set(command.storeId, sequence);
    }
    return stored;
  }

  async snapshot(storeId: string): Promise<StoreSnapshot> {
    const store = this.stores.get(storeId);
    if (!store) {
      throw new Error('missing store');
    }
    return {
      store,
      categories: this.categoriesFor(storeId)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map(toPublicCategory),
      contacts: this.contactsFor(storeId).map(toPublicContact),
      units: this.unitsFor(storeId).map(toPublicUnit),
      items: this.itemsFor(storeId).map((item) => toPublicItem(item, this.batchesFor(storeId))),
      movements: this.movementsFor(storeId).map(toPublicMovement),
      batches: this.batchesFor(storeId).map(toPublicBatch),
      expenses: this.expensesFor(storeId).map(toPublicExpense),
      accounts: this.accountsFor(storeId).map(toPublicCashAccount),
      cashMovements: this.cashMovementsFor(storeId).map(toPublicCashMovement),
      reconciliations: this.reconciliationsFor(storeId).map(toPublicReconciliation),
      sales: this.salesFor(storeId).map(toPublicSale),
      heldSales: [...this.heldSales.values()].filter((row) => row.storeId === storeId && !row.removed),
      purchases: this.purchasesFor(storeId).map(toPublicPurchase),
      paymentMethods: this.methodsFor(storeId).map(toPublicPaymentMethod),
      lastSequence: this.sequences.get(storeId) ?? 0,
    };
  }

  async changes(storeId: string, after: number): Promise<{ changes: ChangeEntry[]; lastSequence: number }> {
    const page = (this.changeLog.get(storeId) ?? []).filter((change) => change.sequence > after);
    return { changes: page, lastSequence: this.sequences.get(storeId) ?? 0 };
  }

  async acknowledge(storeId: string, deviceId: string, sequence: number): Promise<void> {
    this.cursors.set(`${storeId}:${deviceId}`, sequence);
  }

  async listDevices() {
    return [];
  }

  async revokeDevice(): Promise<void> {}

  async listMembers() {
    return [];
  }

  async inviteMember(
    _storeId: string,
    _actorUserId: string,
    input: { email: string; role: 'MANAGER' | 'CASHIER'; password: string },
  ) {
    return {
      userId: input.email,
      name: input.email,
      email: input.email,
      role: input.role,
      status: 'ACTIVE' as const,
    };
  }

  async listCommands(storeId: string) {
    return [...this.commands.values()]
      .filter((command) => command.storeId === storeId)
      .map((command) => ({
        id: command.id,
        type: command.type,
        deviceId: command.deviceId,
        deviceName: 'Device',
        status: command.status,
        message: command.message,
        createdAt: new Date(0).toISOString(),
        label: command.type,
      }));
  }

  cursor(storeId: string, deviceId: string): number | undefined {
    return this.cursors.get(`${storeId}:${deviceId}`);
  }

  private categoriesFor(storeId: string): CategoryRecord[] {
    return [...this.categories.values()].filter((category) => category.storeId === storeId);
  }

  private submitItem(actorUserId: string, command: IncomingCommand, now: Date): StoredCommand {
    const decision = decideItemCommand({
      items: this.itemsFor(command.storeId, false),
      units: this.unitsFor(command.storeId),
      batches: this.batchesFor(command.storeId),
      movements: this.movementsFor(command.storeId),
      categories: this.categoriesFor(command.storeId),
      command,
      actorUserId,
      actorName: actorUserId,
      now,
    });
    const accepted = decision.type === 'accept';
    const sequence = (this.sequences.get(command.storeId) ?? 0) + (accepted ? 1 : 0);
    const item = accepted && decision.item ? toPublicItem(decision.item, decision.batches ?? []) : null;
    const stored: StoredCommand = {
      id: command.id,
      storeId: command.storeId,
      deviceId: command.deviceId,
      actorUserId,
      type: command.type,
      status: accepted ? 'accepted' : 'rejected',
      code: decision.type === 'reject' ? decision.code : null,
      message: decision.type === 'reject' ? decision.message : null,
      changeSequence: accepted ? sequence : null,
      category: null,
      contact: null,
      unit: accepted && decision.unit ? toPublicUnit(decision.unit) : null,
      item,
      movement: accepted && decision.movement ? toPublicMovement(decision.movement) : null,
      batches: accepted && decision.batches ? decision.batches.map(toPublicBatch) : null,
    };
    this.commands.set(command.id, stored);
    if (!accepted) {
      return stored;
    }
    if (decision.unit) {
      this.units.set(decision.unit.id, decision.unit);
    }
    if (decision.item) {
      this.items.set(decision.item.id, decision.item);
    }
    if (decision.movement) {
      this.movements.set(decision.movement.id, decision.movement);
    }
    if (decision.item && decision.batches) {
      for (const batch of [...this.batches.values()]) {
        if (batch.itemId === decision.item.id) {
          this.batches.delete(batch.id);
        }
      }
      for (const batch of decision.batches) {
        this.batches.set(batch.id, batch);
      }
    }
    const page = this.changeLog.get(command.storeId) ?? [];
    page.push({
      sequence,
      storeId: command.storeId,
      aggregateType: decision.unit && !decision.item ? 'unit' : 'item',
      aggregateId: decision.unit && !decision.item ? decision.unit.id : decision.item?.id ?? command.id,
      type: decision.changeType,
      commandId: command.id,
      unit: stored.unit,
      item: stored.item,
      movement: stored.movement,
      batches: stored.batches,
    });
    this.changeLog.set(command.storeId, page);
    this.sequences.set(command.storeId, sequence);
    return stored;
  }

  private unitsFor(storeId: string): UnitRecord[] {
    return [...this.units.values()].filter((unit) => unit.storeId === storeId);
  }

  private itemsFor(storeId: string, activeOnly = true): ItemRecord[] {
    return [...this.items.values()].filter(
      (item) => item.storeId === storeId && (!activeOnly || item.isActive),
    );
  }

  private movementsFor(storeId: string): MovementRecord[] {
    return [...this.movements.values()].filter((movement) => movement.storeId === storeId);
  }

  private batchesFor(storeId: string): BatchRecord[] {
    return [...this.batches.values()].filter((batch) => batch.storeId === storeId);
  }

  private submitExpense(actorUserId: string, command: IncomingCommand, now: Date): StoredCommand {
    const decision = decideExpenseCommand({
      expenses: this.expensesFor(command.storeId, false),
      categories: this.categoriesFor(command.storeId),
      command,
      actorUserId,
      actorName: actorUserId,
      now,
    });
    const accepted = decision.type === 'accept';
    const sequence = (this.sequences.get(command.storeId) ?? 0) + (accepted ? 1 : 0);
    const expense = accepted ? toPublicExpense(decision.expense) : null;
    const stored: StoredCommand = {
      id: command.id,
      storeId: command.storeId,
      deviceId: command.deviceId,
      actorUserId,
      type: command.type,
      status: accepted ? 'accepted' : 'rejected',
      code: decision.type === 'reject' ? decision.code : null,
      message: decision.type === 'reject' ? decision.message : null,
      changeSequence: accepted ? sequence : null,
      category: null,
      expense,
    };
    this.commands.set(command.id, stored);
    if (!accepted) {
      return stored;
    }
    this.expenses.set(decision.expense.id, decision.expense);
    const linked = syncLinkedExpense(
      this.cashMovementsFor(command.storeId),
      decision.expense,
      this.accountsFor(command.storeId, false),
      now,
    );
    for (const row of linked) {
      this.cashMovements.set(row.id, row);
    }
    stored.cashMovements = linked.map(toPublicCashMovement);
    const page = this.changeLog.get(command.storeId) ?? [];
    page.push({
      sequence,
      storeId: command.storeId,
      aggregateType: 'expense',
      aggregateId: decision.expense.id,
      type: decision.changeType,
      commandId: command.id,
      expense,
      cashMovements: stored.cashMovements,
    });
    this.changeLog.set(command.storeId, page);
    this.sequences.set(command.storeId, sequence);
    return stored;
  }

  private submitCash(actorUserId: string, command: IncomingCommand, now: Date): StoredCommand {
    const decision = decideCashCommand({
      accounts: this.accountsFor(command.storeId, false),
      movements: this.cashMovementsFor(command.storeId),
      reconciliations: this.reconciliationsFor(command.storeId),
      expenses: this.expensesFor(command.storeId, false),
      contacts: [...this.contacts.values()].filter((contact) => contact.storeId === command.storeId),
      categories: this.categoriesFor(command.storeId),
      command,
      actorUserId,
      actorName: actorUserId,
      now,
    });
    const accepted = decision.type === 'accept';
    const sequence = (this.sequences.get(command.storeId) ?? 0) + (accepted ? 1 : 0);
    const stored: StoredCommand = {
      id: command.id,
      storeId: command.storeId,
      deviceId: command.deviceId,
      actorUserId,
      type: command.type,
      status: accepted ? 'accepted' : 'rejected',
      code: decision.type === 'reject' ? decision.code : null,
      message: decision.type === 'reject' ? decision.message : null,
      changeSequence: accepted ? sequence : null,
      category: null,
      account: accepted && decision.account ? toPublicCashAccount(decision.account) : null,
      cashMovements: accepted ? decision.movements.map(toPublicCashMovement) : null,
      reconciliation: accepted && decision.reconciliation ? toPublicReconciliation(decision.reconciliation) : null,
      expense: accepted && decision.expense ? toPublicExpense(decision.expense) : null,
    };
    this.commands.set(command.id, stored);
    if (!accepted) {
      return stored;
    }
    if (decision.account) {
      this.accounts.set(decision.account.id, decision.account);
    }
    for (const row of decision.movements) {
      this.cashMovements.set(row.id, row);
    }
    if (decision.reconciliation) {
      this.reconciliations.set(decision.reconciliation.id, decision.reconciliation);
    }
    if (decision.expense) {
      this.expenses.set(decision.expense.id, decision.expense);
    }
    const page = this.changeLog.get(command.storeId) ?? [];
    page.push({
      sequence,
      storeId: command.storeId,
      aggregateType: 'account',
      aggregateId: decision.account?.id ?? decision.movements[0]?.accountId ?? decision.reconciliation?.accountId ?? command.id,
      type: decision.changeType,
      commandId: command.id,
      account: stored.account,
      cashMovements: stored.cashMovements,
      reconciliation: stored.reconciliation,
      expense: stored.expense,
    });
    this.changeLog.set(command.storeId, page);
    this.sequences.set(command.storeId, sequence);
    return stored;
  }

  private submitHeld(actorUserId: string, command: IncomingCommand): StoredCommand {
    const decision = decideHeldSale({
      held: [...this.heldSales.values()].filter((row) => row.storeId === command.storeId),
      command,
    });
    const accepted = decision.type === 'accept';
    const sequence = (this.sequences.get(command.storeId) ?? 0) + (accepted ? 1 : 0);
    const stored: StoredCommand = {
      id: command.id,
      storeId: command.storeId,
      deviceId: command.deviceId,
      actorUserId,
      type: command.type,
      status: accepted ? 'accepted' : 'rejected',
      code: decision.type === 'reject' ? decision.code : null,
      message: decision.type === 'reject' ? decision.message : null,
      changeSequence: accepted ? sequence : null,
      category: null,
      heldSale: accepted ? decision.held : null,
    };
    this.commands.set(command.id, stored);
    if (!accepted) {
      return stored;
    }
    if (decision.held.removed) {
      this.heldSales.delete(decision.held.id);
    } else {
      this.heldSales.set(decision.held.id, decision.held);
    }
    const page = this.changeLog.get(command.storeId) ?? [];
    page.push({
      sequence,
      storeId: command.storeId,
      aggregateType: 'heldSale',
      aggregateId: decision.held.id,
      type: decision.changeType,
      commandId: command.id,
      heldSale: decision.held,
    });
    this.changeLog.set(command.storeId, page);
    this.sequences.set(command.storeId, sequence);
    return stored;
  }

  private submitSale(actorUserId: string, command: IncomingCommand, now: Date): StoredCommand {
    const decision = decideSaleCommand({
      sales: this.salesFor(command.storeId, false),
      items: this.itemsFor(command.storeId, false),
      batches: this.batchesFor(command.storeId),
      movements: this.movementsFor(command.storeId),
      accounts: this.accountsFor(command.storeId, false),
      cashMovements: this.cashMovementsFor(command.storeId),
      command,
      actorName: actorUserId,
      now,
    });
    const accepted = decision.type === 'accept';
    const sequence = (this.sequences.get(command.storeId) ?? 0) + (accepted ? 1 : 0);
    const sale = accepted ? toPublicSale(decision.effects.sale) : null;
    const stored: StoredCommand = {
      id: command.id,
      storeId: command.storeId,
      deviceId: command.deviceId,
      actorUserId,
      type: command.type,
      status: accepted ? 'accepted' : 'rejected',
      code: decision.type === 'reject' ? decision.code : null,
      message: decision.type === 'reject' ? decision.message : null,
      changeSequence: accepted ? sequence : null,
      category: null,
      sale,
      item: null,
      movement: accepted ? decision.effects.movements[0] ? toPublicMovement(decision.effects.movements[0]) : null : null,
      batches: accepted ? decision.effects.batches.map(toPublicBatch) : null,
      cashMovements: accepted ? decision.effects.cashMovements.map(toPublicCashMovement) : null,
    };
    this.commands.set(command.id, stored);
    if (!accepted) {
      return stored;
    }
    if (command.type === 'sale.purge') {
      this.sales.delete(decision.effects.sale.id);
    } else {
      this.sales.set(decision.effects.sale.id, decision.effects.sale);
    }
    for (const item of decision.effects.items) {
      this.items.set(item.id, item);
    }
    for (const movement of decision.effects.movements) {
      this.movements.set(movement.id, movement);
    }
    for (const batch of decision.effects.batches) {
      this.batches.set(batch.id, batch);
    }
    for (const movement of decision.effects.cashMovements) {
      this.cashMovements.set(movement.id, movement);
    }
    const page = this.changeLog.get(command.storeId) ?? [];
    page.push({
      sequence,
      storeId: command.storeId,
      aggregateType: 'sale',
      aggregateId: decision.effects.sale.id,
      type: decision.changeType,
      commandId: command.id,
      sale,
      batches: stored.batches,
      cashMovements: stored.cashMovements,
      movement: stored.movement,
    });
    this.changeLog.set(command.storeId, page);
    this.sequences.set(command.storeId, sequence);
    return stored;
  }

  private submitPurchase(actorUserId: string, command: IncomingCommand, now: Date): StoredCommand {
    const decision = decidePurchaseCommand({
      purchases: this.purchasesFor(command.storeId, false),
      items: this.itemsFor(command.storeId, false),
      batches: this.batchesFor(command.storeId),
      movements: this.movementsFor(command.storeId),
      accounts: this.accountsFor(command.storeId, false),
      cashMovements: this.cashMovementsFor(command.storeId),
      command,
      actorName: actorUserId,
      now,
    });
    const accepted = decision.type === 'accept';
    const sequence = (this.sequences.get(command.storeId) ?? 0) + (accepted ? 1 : 0);
    const purchase = accepted ? toPublicPurchase(decision.effects.purchase) : null;
    const stored: StoredCommand = {
      id: command.id,
      storeId: command.storeId,
      deviceId: command.deviceId,
      actorUserId,
      type: command.type,
      status: accepted ? 'accepted' : 'rejected',
      code: decision.type === 'reject' ? decision.code : null,
      message: decision.type === 'reject' ? decision.message : null,
      changeSequence: accepted ? sequence : null,
      category: null,
      purchase,
      movement: accepted && decision.effects.movements[0] ? toPublicMovement(decision.effects.movements[0]) : null,
      batches: accepted ? decision.effects.batches.map(toPublicBatch) : null,
      cashMovements: accepted ? decision.effects.cashMovements.map(toPublicCashMovement) : null,
    };
    this.commands.set(command.id, stored);
    if (!accepted) {
      return stored;
    }
    if (command.type === 'purchase.purge') {
      this.purchases.delete(decision.effects.purchase.id);
    } else {
      this.purchases.set(decision.effects.purchase.id, decision.effects.purchase);
    }
    for (const item of decision.effects.items) {
      this.items.set(item.id, item);
    }
    for (const movement of decision.effects.movements) {
      this.movements.set(movement.id, movement);
    }
    for (const batch of decision.effects.batches) {
      this.batches.set(batch.id, batch);
    }
    for (const movement of decision.effects.cashMovements) {
      this.cashMovements.set(movement.id, movement);
    }
    const page = this.changeLog.get(command.storeId) ?? [];
    page.push({
      sequence,
      storeId: command.storeId,
      aggregateType: 'purchase',
      aggregateId: decision.effects.purchase.id,
      type: decision.changeType,
      commandId: command.id,
      purchase,
      batches: stored.batches,
      cashMovements: stored.cashMovements,
      movement: stored.movement,
    });
    this.changeLog.set(command.storeId, page);
    this.sequences.set(command.storeId, sequence);
    return stored;
  }

  private submitShop(actorUserId: string, command: IncomingCommand, now: Date): StoredCommand {
    const store = this.stores.get(command.storeId);
    if (!store) {
      const missing: StoredCommand = {
        id: command.id,
        storeId: command.storeId,
        deviceId: command.deviceId,
        actorUserId,
        type: command.type,
        status: 'rejected',
        code: 'not_found',
        message: 'This shop was not found.',
        changeSequence: null,
        category: null,
      };
      this.commands.set(command.id, missing);
      return missing;
    }
    const decision = decideShopCommand({
      store,
      methods: this.methodsFor(command.storeId, false),
      accounts: this.accountsFor(command.storeId, false).map((account) => ({
        id: account.id,
        name: account.name,
        isActive: account.isActive,
      })),
      command,
      now,
    });
    const accepted = decision.type === 'accept';
    const sequence = (this.sequences.get(command.storeId) ?? 0) + (accepted ? 1 : 0);
    const methods = accepted && decision.methods ? decision.methods.map(toPublicPaymentMethod) : null;
    const stored: StoredCommand = {
      id: command.id,
      storeId: command.storeId,
      deviceId: command.deviceId,
      actorUserId,
      type: command.type,
      status: accepted ? 'accepted' : 'rejected',
      code: decision.type === 'reject' ? decision.code : null,
      message: decision.type === 'reject' ? decision.message : null,
      changeSequence: accepted ? sequence : null,
      category: null,
      store: accepted ? decision.store : null,
      paymentMethods: methods,
    };
    this.commands.set(command.id, stored);
    if (!accepted) {
      return stored;
    }
    if (decision.store) {
      this.stores.set(store.id, { ...decision.store, ownerId: store.ownerId });
    }
    if (decision.methods) {
      for (const method of this.methodsFor(command.storeId, false)) {
        this.paymentMethods.delete(method.id);
      }
      for (const method of decision.methods) {
        this.paymentMethods.set(method.id, method);
      }
    }
    const page = this.changeLog.get(command.storeId) ?? [];
    page.push({
      sequence,
      storeId: command.storeId,
      aggregateType: command.type.startsWith('store.') ? 'store' : 'paymentMethod',
      aggregateId: decision.store?.id ?? command.storeId,
      type: decision.changeType,
      commandId: command.id,
      store: stored.store,
      paymentMethods: stored.paymentMethods,
    });
    this.changeLog.set(command.storeId, page);
    this.sequences.set(command.storeId, sequence);
    return stored;
  }

  private methodsFor(storeId: string, activeOnly = true): PaymentMethodRecord[] {
    return [...this.paymentMethods.values()].filter((method) => method.storeId === storeId && (!activeOnly || method.isActive));
  }

  private purchasesFor(storeId: string, activeOnly = true): PurchaseRecord[] {
    return [...this.purchases.values()].filter((row) => row.storeId === storeId && (!activeOnly || row.isActive));
  }

  private salesFor(storeId: string, activeOnly = true): SaleRecord[] {
    return [...this.sales.values()].filter((sale) => sale.storeId === storeId && (!activeOnly || sale.isActive));
  }

  private expensesFor(storeId: string, activeOnly = true): ExpenseRecord[] {
    return [...this.expenses.values()].filter(
      (expense) => expense.storeId === storeId && (!activeOnly || expense.isActive),
    );
  }

  private accountsFor(storeId: string, activeOnly = true): CashAccountRecord[] {
    return [...this.accounts.values()].filter(
      (account) => account.storeId === storeId && (!activeOnly || account.isActive),
    );
  }

  private cashMovementsFor(storeId: string): CashMovementRecord[] {
    return [...this.cashMovements.values()].filter((row) => row.storeId === storeId);
  }

  private reconciliationsFor(storeId: string): ReconciliationRecord[] {
    return [...this.reconciliations.values()].filter((row) => row.storeId === storeId);
  }

  private contactsFor(storeId: string): ContactRecord[] {
    return [...this.contacts.values()].filter((contact) => contact.storeId === storeId && contact.isActive);
  }
}

function memberKey(storeId: string, userId: string): string {
  return `${storeId}:${userId}`;
}

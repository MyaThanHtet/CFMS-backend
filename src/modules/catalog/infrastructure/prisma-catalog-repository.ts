import { randomUUID } from 'node:crypto';
import { Argon2PasswordHasher } from '../../auth/infrastructure/argon2-password-hasher.js';
import type { PlatformService } from '../../platform/platform-service.js';
import { CatalogError } from '../domain/catalog-error.js';
import { parseImportedShop } from '../domain/import-backup.js';
import { mergeShopDevices } from '../domain/devices.js';
import type { Prisma, PrismaClient } from '../../../generated/prisma/client.js';
import type {
  CatalogRepository,
  ChangeEntry,
  CreateStoreInput,
  StoreRecord,
  StoreSnapshot,
} from '../application/ports.js';
import {
  decideCategoryCommand,
  seedCategories,
  toPublicCategory,
  type CategoryRecord,
  type IncomingCommand,
  type PublicCategory,
  type StoredCommand,
} from '../domain/category.js';
import {
  decideCashCommand,
  syncLinkedExpense,
  seedCashDrawer,
  toPublicCashAccount,
  toPublicCashMovement,
  toPublicReconciliation,
  type CashAccountRecord,
  type CashMovementRecord,
  type PublicCashAccount,
  type PublicCashMovement,
  type PublicReconciliation,
  type ReconciliationRecord,
} from '../domain/cash.js';
import { decideExpenseCommand, toPublicExpense, type ExpenseRecord, type PublicExpense } from '../domain/expense.js';
import { decideHeldSale, type PublicHeldSale } from '../domain/held-sale.js';
import { decideSaleCommand, toPublicSale, type PublicSale, type SaleRecord } from '../domain/sale.js';
import {
  decidePurchaseCommand,
  toPublicPurchase,
  type PublicPurchase,
  type PurchaseRecord,
} from '../domain/purchase.js';
import {
  decideShopCommand,
  seedCashMethod,
  toPublicPaymentMethod,
  type PaymentMethodRecord,
  type PublicPaymentMethod,
  type PublicStore,
} from '../domain/shop-settings.js';
import { decideContactCommand, toPublicContact, type ContactRecord, type PublicContact } from '../domain/contact.js';
import {
  decideItemCommand,
  toPublicBatch,
  toPublicItem,
  toPublicMovement,
  toPublicUnit,
  type BatchRecord,
  type ItemRecord,
  type MovementRecord,
  type PublicBatch,
  type PublicItem,
  type PublicMovement,
  type PublicUnit,
  type UnitRecord,
} from '../domain/item.js';

export class PrismaCatalogRepository implements CatalogRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly platform?: PlatformService,
  ) {}

  async findStore(id: string): Promise<StoreRecord | null> {
    const store = await this.prisma.store.findUnique({ where: { id } });
    return store ? toStore(store) : null;
  }

  async listOwnedStores(userId: string) {
    return this.prisma.store.findMany({
      where: { ownerId: userId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true },
    });
  }

  async isMember(storeId: string, userId: string): Promise<boolean> {
    const member = await this.prisma.storeMember.findUnique({
      where: { storeId_userId: { storeId, userId } },
    });
    return member !== null;
  }

  async createStore(input: CreateStoreInput, now: Date): Promise<StoreSnapshot> {
    const seeded =
      input.seedDefaults === false
        ? []
        : seedCategories({
            storeId: input.id,
            actorUserId: input.actorUserId,
            deviceId: input.deviceId,
            now,
          });
    await this.prisma.$transaction(async (tx) => {
      if (this.platform) {
        await tx.$queryRaw`SELECT id FROM users WHERE id=${input.actorUserId} FOR UPDATE`;
        await this.platform.requireQuota(tx, input.actorUserId, 'shops');
      }
      await tx.store.create({
        data: {
          id: input.id,
          name: input.name,
          address: input.address,
          phone: input.phone,
          email: input.email,
          currencyCode: 'MMK',
          timezone: 'Asia/Yangon',
          ownerId: input.actorUserId,
          createdAt: now,
          updatedAt: now,
        },
      });
      await tx.storeMember.create({
        data: {
          storeId: input.id,
          userId: input.actorUserId,
          role: 'OWNER',
          createdAt: now,
        },
      });
      await tx.category.createMany({
        data: seeded.map(categoryData),
      });
      await tx.changeRecord.createMany({
        data: seeded.map((category, index) => ({
          storeId: input.id,
          sequence: index + 1,
          aggregateType: 'category',
          aggregateId: category.id,
          type: 'category.created',
          commandId: `seed:${category.id}`,
          payload: toPublicCategory(category),
          createdAt: now,
        })),
      });
      if (input.seedDefaults !== false) {
        const drawer = seedCashDrawer({
          storeId: input.id,
          actorUserId: input.actorUserId,
          deviceId: input.deviceId,
          now,
        });
        await tx.cashAccount.create({ data: cashAccountData(drawer.account) });
        await tx.cashMovement.create({
          data: cashMovementData(drawer.movement),
        });
        const cashMethod = seedCashMethod(input.id, drawer.account.id, now);
        await tx.paymentMethod.create({
          data: {
            id: cashMethod.id,
            storeId: cashMethod.storeId,
            name: cashMethod.name,
            normalizedName: cashMethod.normalizedName,
            accountId: cashMethod.accountId,
            isDefault: cashMethod.isDefault,
            isActive: cashMethod.isActive,
            revision: cashMethod.revision,
            createdAt: now,
            updatedAt: now,
          },
        });
        await tx.changeRecord.create({
          data: {
            storeId: input.id,
            sequence: seeded.length + 1,
            aggregateType: 'account',
            aggregateId: drawer.account.id,
            type: 'account.created',
            commandId: `seed:${drawer.account.id}`,
            payload: {
              account: toPublicCashAccount(drawer.account),
              cashMovements: [toPublicCashMovement(drawer.movement)],
            },
            createdAt: now,
          },
        });
      }
      await tx.storeSequence.create({
        data: {
          storeId: input.id,
          lastSequence: seeded.length + (input.seedDefaults === false ? 0 : 1),
        },
      });
    });
    return this.snapshot(input.id);
  }

  async importBackup(
    input: { actorUserId: string; deviceId: string; tables: unknown },
    now: Date,
  ): Promise<{ storeId: string; ids: Record<string, string> }> {
    const shop = parseImportedShop(input.tables, { ...input, now });
    const existing = await this.findStore(shop.store.id);
    if (existing) {
      if (existing.ownerId !== input.actorUserId) {
        throw new CatalogError('store_taken', 'This shop already belongs to another account.', 409);
      }
      return { storeId: shop.store.id, ids: shop.ids };
    }
    await this.prisma.$transaction(async (tx) => {
      if (this.platform) {
        await tx.$queryRaw`SELECT id FROM users WHERE id=${input.actorUserId} FOR UPDATE`;
        await this.platform.requireQuota(tx, input.actorUserId, 'shops');
      }
      await tx.store.create({
        data: {
          id: shop.store.id,
          name: shop.store.name,
          address: shop.store.address,
          phone: shop.store.phone,
          email: shop.store.email,
          currencyCode: shop.store.currencyCode,
          currencySymbol: shop.store.currencySymbol,
          taxName: shop.store.taxName,
          taxRatePercent: shop.store.taxRatePercent,
          timezone: shop.store.timezone,
          revision: shop.store.revision,
          ownerId: input.actorUserId,
          createdAt: now,
          updatedAt: now,
        },
      });
      await tx.storeMember.create({
        data: { storeId: shop.store.id, userId: input.actorUserId, role: 'OWNER', createdAt: now },
      });
      await tx.storeSequence.create({ data: { storeId: shop.store.id, lastSequence: 0 } });
      if (shop.categories.length) await tx.category.createMany({ data: shop.categories });
      if (shop.contacts.length) await tx.contact.createMany({ data: shop.contacts });
      if (shop.units.length) await tx.unit.createMany({ data: shop.units });
      if (shop.items.length) {
        await tx.item.createMany({
          data: shop.items.map((row) => ({ ...row, sku: row.sku ?? '' })),
        });
      }
      if (shop.movements.length) await tx.stockMovement.createMany({ data: shop.movements });
      if (shop.batches.length) await tx.costBatch.createMany({ data: shop.batches });
      if (shop.expenses.length) await tx.expense.createMany({ data: shop.expenses });
      if (shop.accounts.length) await tx.cashAccount.createMany({ data: shop.accounts });
      if (shop.cashMovements.length) await tx.cashMovement.createMany({ data: shop.cashMovements });
      if (shop.reconciliations.length) await tx.cashReconciliation.createMany({ data: shop.reconciliations });
      if (shop.sales.length) {
        await tx.saleDocument.createMany({
          data: shop.sales.map((row) => ({
            id: row.id,
            storeId: row.storeId,
            number: row.number,
            normalizedNumber: row.normalizedNumber,
            contactName: row.contactName,
            effectiveDate: row.effectiveDate,
            occurredAt: row.occurredAt,
            grossMinor: row.grossMinor,
            discountMinor: row.discountMinor,
            taxMinor: row.taxMinor,
            deliveryMinor: row.deliveryMinor,
            netMinor: row.netMinor,
            costMinor: row.costMinor,
            receivedMinor: row.receivedMinor,
            dueMinor: row.dueMinor,
            note: row.note,
            isActive: row.isActive,
            revision: row.revision,
            lines: row.lines,
            payments: row.payments,
            returns: row.returns,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })),
        });
      }
      if (shop.purchases.length) {
        await tx.purchaseDocument.createMany({
          data: shop.purchases.map((row) => ({
            id: row.id,
            storeId: row.storeId,
            number: row.number,
            normalizedNumber: row.normalizedNumber,
            supplierName: row.supplierName,
            effectiveDate: row.effectiveDate,
            occurredAt: row.occurredAt,
            grossMinor: row.grossMinor,
            discountMinor: row.discountMinor,
            taxMinor: row.taxMinor,
            shippingMinor: row.shippingMinor,
            netMinor: row.netMinor,
            paidMinor: row.paidMinor,
            dueMinor: row.dueMinor,
            note: row.note,
            isActive: row.isActive,
            revision: row.revision,
            lines: row.lines,
            payments: row.payments,
            returns: row.returns,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })),
        });
      }
      if (shop.paymentMethods.length) {
        await tx.paymentMethod.createMany({
          data: shop.paymentMethods.map((row) => ({
            id: row.id,
            storeId: row.storeId,
            name: row.name,
            normalizedName: row.normalizedName,
            accountId: row.accountId,
            isDefault: row.isDefault,
            isActive: row.isActive,
            revision: row.revision,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })),
        });
      }
    });
    return { storeId: shop.store.id, ids: shop.ids };
  }

  async submitCommand(actorUserId: string, command: IncomingCommand, now: Date): Promise<StoredCommand> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.commandRecord.findUnique({
        where: { id: command.id },
      });
      if (existing) {
        return toStoredCommand(existing);
      }
      if (this.platform) {
        await tx.$queryRaw`SELECT id FROM stores WHERE id=${command.storeId} FOR UPDATE`;
        const resources: Record<string, string> = {
          'category.create': 'categories',
          'contact.create': 'contacts',
          'item.create': 'items',
          'unit.create': 'units',
          'expense.create': 'expenses',
          'account.create': 'cash_accounts',
          'sale.create': 'sales',
          'purchase.create': 'purchases',
          'paymentMethod.create': 'payment_methods',
        };
        const resource = resources[command.type];
        if (resource) await this.platform.requireQuota(tx, actorUserId, resource, command.storeId);
        else await this.platform.requireCloud(actorUserId, tx);
      }
      const rows = await tx.category.findMany({
        where: { storeId: command.storeId },
      });
      const sequence = await tx.storeSequence.findUnique({
        where: { storeId: command.storeId },
      });
      if (command.type.startsWith('store.') || command.type.startsWith('paymentMethod.')) {
        const [store, methodRows, accountRows] = await Promise.all([
          tx.store.findUnique({ where: { id: command.storeId } }),
          tx.paymentMethod.findMany({ where: { storeId: command.storeId } }),
          tx.cashAccount.findMany({ where: { storeId: command.storeId } }),
        ]);
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
          await tx.commandRecord.create({
            data: {
              id: command.id,
              storeId: command.storeId,
              deviceId: command.deviceId,
              actorUserId,
              type: command.type,
              payload: command.payload as Prisma.InputJsonValue,
              status: 'rejected',
              code: 'not_found',
              message: 'This shop was not found.',
              createdAt: now,
            },
          });
          return missing;
        }
        const accounts = accountRows.map((account) => ({
          id: account.id,
          name: account.name,
          isActive: account.isActive,
        }));
        return this.persistShop(tx, actorUserId, command, now, {
          store: toStore(store),
          methods: methodRows.map((method) =>
            toPaymentMethod(method, accounts.find((account) => account.id === method.accountId)?.name ?? ''),
          ),
          accounts,
          lastSequence: sequence?.lastSequence ?? 0,
        });
      }
      if (command.type.startsWith('item.') || command.type.startsWith('unit.')) {
        const [itemRows, unitRows, batchRows, movementRows, user] = await Promise.all([
          tx.item.findMany({ where: { storeId: command.storeId } }),
          tx.unit.findMany({ where: { storeId: command.storeId } }),
          tx.costBatch.findMany({ where: { storeId: command.storeId } }),
          tx.stockMovement.findMany({ where: { storeId: command.storeId } }),
          tx.user.findUnique({ where: { id: actorUserId } }),
        ]);
        return this.persistItem(tx, actorUserId, user?.name ?? actorUserId, command, now, {
          items: itemRows.map(toItem),
          units: unitRows.map(toUnit),
          batches: batchRows.map(toBatch),
          movements: movementRows.map(toMovement),
          categories: rows.map(toCategory),
          lastSequence: sequence?.lastSequence ?? 0,
        });
      }
      if (command.type.startsWith('purchase.')) {
        const [purchaseRows, itemRows, batchRows, movementRows, accountRows, cashRows, user] = await Promise.all([
          tx.purchaseDocument.findMany({ where: { storeId: command.storeId } }),
          tx.item.findMany({ where: { storeId: command.storeId } }),
          tx.costBatch.findMany({ where: { storeId: command.storeId } }),
          tx.stockMovement.findMany({ where: { storeId: command.storeId } }),
          tx.cashAccount.findMany({ where: { storeId: command.storeId } }),
          tx.cashMovement.findMany({ where: { storeId: command.storeId } }),
          tx.user.findUnique({ where: { id: actorUserId } }),
        ]);
        return this.persistPurchase(tx, actorUserId, user?.name ?? actorUserId, command, now, {
          purchases: purchaseRows.map(toPurchase),
          items: itemRows.map(toItem),
          batches: batchRows.map(toBatch),
          movements: movementRows.map(toMovement),
          accounts: accountRows.map(toCashAccount),
          cashMovements: cashRows.map(toCashMovement),
          lastSequence: sequence?.lastSequence ?? 0,
        });
      }
      if (command.type.startsWith('heldSale.')) {
        const [heldRows, sequence] = await Promise.all([
          tx.heldSale.findMany({ where: { storeId: command.storeId, removed: false } }),
          tx.storeSequence.findUnique({ where: { storeId: command.storeId } }),
        ]);
        return this.persistHeld(tx, actorUserId, command, now, {
          held: heldRows.map(toHeldSale),
          lastSequence: sequence?.lastSequence ?? 0,
        });
      }
      if (command.type.startsWith('sale.')) {
        const [saleRows, itemRows, batchRows, movementRows, accountRows, cashRows, user] = await Promise.all([
          tx.saleDocument.findMany({ where: { storeId: command.storeId } }),
          tx.item.findMany({ where: { storeId: command.storeId } }),
          tx.costBatch.findMany({ where: { storeId: command.storeId } }),
          tx.stockMovement.findMany({ where: { storeId: command.storeId } }),
          tx.cashAccount.findMany({ where: { storeId: command.storeId } }),
          tx.cashMovement.findMany({ where: { storeId: command.storeId } }),
          tx.user.findUnique({ where: { id: actorUserId } }),
        ]);
        return this.persistSale(tx, actorUserId, user?.name ?? actorUserId, command, now, {
          sales: saleRows.map(toSale),
          items: itemRows.map(toItem),
          batches: batchRows.map(toBatch),
          movements: movementRows.map(toMovement),
          accounts: accountRows.map(toCashAccount),
          cashMovements: cashRows.map(toCashMovement),
          lastSequence: sequence?.lastSequence ?? 0,
        });
      }
      if (command.type.startsWith('cash.') || command.type === 'account.create') {
        const [accountRows, movementRows, reconciliationRows, expenseRows, contactRows, user] = await Promise.all([
          tx.cashAccount.findMany({ where: { storeId: command.storeId } }),
          tx.cashMovement.findMany({ where: { storeId: command.storeId } }),
          tx.cashReconciliation.findMany({
            where: { storeId: command.storeId },
          }),
          tx.expense.findMany({ where: { storeId: command.storeId } }),
          tx.contact.findMany({
            where: { storeId: command.storeId, isActive: true },
          }),
          tx.user.findUnique({ where: { id: actorUserId } }),
        ]);
        return this.persistCash(tx, actorUserId, user?.name ?? actorUserId, command, now, {
          accounts: accountRows.map(toCashAccount),
          movements: movementRows.map(toCashMovement),
          reconciliations: reconciliationRows.map(toReconciliation),
          expenses: expenseRows.map(toExpense),
          contacts: contactRows.map(toContact),
          categories: rows.map(toCategory),
          lastSequence: sequence?.lastSequence ?? 0,
        });
      }
      if (command.type.startsWith('expense.')) {
        const [expenseRows, movementRows, accountRows, user] = await Promise.all([
          tx.expense.findMany({ where: { storeId: command.storeId } }),
          tx.cashMovement.findMany({ where: { storeId: command.storeId } }),
          tx.cashAccount.findMany({ where: { storeId: command.storeId } }),
          tx.user.findUnique({ where: { id: actorUserId } }),
        ]);
        return this.persistExpense(tx, actorUserId, user?.name ?? actorUserId, command, now, {
          expenses: expenseRows.map(toExpense),
          movements: movementRows.map(toCashMovement),
          accounts: accountRows.map(toCashAccount),
          categories: rows.map(toCategory),
          lastSequence: sequence?.lastSequence ?? 0,
        });
      }
      if (command.type.startsWith('contact.')) {
        const contactRows = await tx.contact.findMany({
          where: { storeId: command.storeId },
        });
        return this.persistContact(tx, actorUserId, command, now, {
          contacts: contactRows.filter((row) => row.isActive).map(toContact),
          categories: rows.map(toCategory),
          lastSequence: sequence?.lastSequence ?? 0,
        });
      }
      const decision = decideCategoryCommand({
        categories: rows.map(toCategory),
        lastSequence: sequence?.lastSequence ?? 0,
        existingCommand: null,
        command,
        actorUserId,
        now,
      });
      if (decision.type === 'replay') {
        return decision.command;
      }
      await tx.commandRecord.create({
        data: {
          id: decision.command.id,
          storeId: decision.command.storeId,
          deviceId: decision.command.deviceId,
          actorUserId: decision.command.actorUserId,
          type: decision.command.type,
          payload: command.payload as Prisma.InputJsonValue,
          status: decision.command.status,
          code: decision.command.code,
          message: decision.command.message,
          changeSequence: decision.command.changeSequence,
          resultCategory: decision.command.category ?? undefined,
          createdAt: now,
        },
      });
      if (decision.type === 'reject') {
        return decision.command;
      }
      await tx.category.upsert({
        where: { id: decision.category.id },
        create: categoryData(decision.category),
        update: {
          name: decision.category.name,
          normalizedName: decision.category.normalizedName,
          description: decision.category.description,
          isActive: decision.category.isActive,
          sortOrder: decision.category.sortOrder,
          revision: decision.category.revision,
          updatedBy: decision.category.updatedBy,
          deviceId: decision.category.deviceId,
          updatedAt: decision.category.updatedAt,
        },
      });
      await tx.changeRecord.create({
        data: {
          storeId: command.storeId,
          sequence: decision.sequence,
          aggregateType: 'category',
          aggregateId: decision.category.id,
          type: decision.changeType,
          commandId: command.id,
          payload: toPublicCategory(decision.category),
          createdAt: now,
        },
      });
      await tx.storeSequence.update({
        where: { storeId: command.storeId },
        data: { lastSequence: decision.sequence },
      });
      return decision.command;
    });
  }

  private async persistContact(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    command: IncomingCommand,
    now: Date,
    state: {
      contacts: ContactRecord[];
      categories: CategoryRecord[];
      lastSequence: number;
    },
  ): Promise<StoredCommand> {
    const decision = decideContactCommand({
      contacts: state.contacts,
      categories: state.categories,
      command,
      actorUserId,
      now,
    });
    const accepted = decision.type === 'accept';
    const sequence = accepted ? state.lastSequence + 1 : null;
    const stored: StoredCommand = {
      id: command.id,
      storeId: command.storeId,
      deviceId: command.deviceId,
      actorUserId,
      type: command.type,
      status: accepted ? 'accepted' : 'rejected',
      code: decision.type === 'reject' ? decision.code : null,
      message: decision.type === 'reject' ? decision.message : null,
      changeSequence: sequence,
      category: null,
      contact: accepted ? toPublicContact(decision.contact) : null,
    };
    await tx.commandRecord.create({
      data: {
        id: stored.id,
        storeId: stored.storeId,
        deviceId: stored.deviceId,
        actorUserId,
        type: stored.type,
        payload: command.payload as Prisma.InputJsonValue,
        status: stored.status,
        code: stored.code,
        message: stored.message,
        changeSequence: stored.changeSequence,
        resultContact: stored.contact ?? undefined,
        createdAt: now,
      },
    });
    if (!accepted) {
      return stored;
    }
    await tx.contact.upsert({
      where: { id: decision.contact.id },
      create: contactData(decision.contact),
      update: contactData(decision.contact),
    });
    await tx.changeRecord.create({
      data: {
        storeId: command.storeId,
        sequence: sequence ?? state.lastSequence,
        aggregateType: 'contact',
        aggregateId: decision.contact.id,
        type: decision.changeType,
        commandId: command.id,
        payload: toPublicContact(decision.contact),
        createdAt: now,
      },
    });
    await tx.storeSequence.update({
      where: { storeId: command.storeId },
      data: { lastSequence: sequence ?? state.lastSequence },
    });
    return stored;
  }

  private async persistCash(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    actorName: string,
    command: IncomingCommand,
    now: Date,
    state: {
      accounts: CashAccountRecord[];
      movements: CashMovementRecord[];
      reconciliations: ReconciliationRecord[];
      expenses: ExpenseRecord[];
      contacts: ContactRecord[];
      categories: CategoryRecord[];
      lastSequence: number;
    },
  ): Promise<StoredCommand> {
    const decision = decideCashCommand({
      ...state,
      command,
      actorUserId,
      actorName,
      now,
    });
    const accepted = decision.type === 'accept';
    const sequence = accepted ? state.lastSequence + 1 : null;
    const bundle = {
      account: accepted && decision.account ? toPublicCashAccount(decision.account) : null,
      cashMovements: accepted ? decision.movements.map(toPublicCashMovement) : null,
      reconciliation: accepted && decision.reconciliation ? toPublicReconciliation(decision.reconciliation) : null,
      expense: accepted && decision.expense ? toPublicExpense(decision.expense) : null,
    };
    const stored: StoredCommand = {
      id: command.id,
      storeId: command.storeId,
      deviceId: command.deviceId,
      actorUserId,
      type: command.type,
      status: accepted ? 'accepted' : 'rejected',
      code: decision.type === 'reject' ? decision.code : null,
      message: decision.type === 'reject' ? decision.message : null,
      changeSequence: sequence,
      category: null,
      ...bundle,
    };
    await tx.commandRecord.create({
      data: {
        id: stored.id,
        storeId: stored.storeId,
        deviceId: stored.deviceId,
        actorUserId,
        type: stored.type,
        payload: command.payload as Prisma.InputJsonValue,
        status: stored.status,
        code: stored.code,
        message: stored.message,
        changeSequence: stored.changeSequence,
        resultCash: bundle,
        resultExpense: bundle.expense ?? undefined,
        createdAt: now,
      },
    });
    if (!accepted) {
      return stored;
    }
    if (decision.account) {
      await tx.cashAccount.create({ data: cashAccountData(decision.account) });
    }
    for (const row of decision.movements) {
      await tx.cashMovement.create({ data: cashMovementData(row) });
    }
    if (decision.reconciliation) {
      await tx.cashReconciliation.create({
        data: reconciliationData(decision.reconciliation),
      });
    }
    if (decision.expense) {
      await tx.expense.create({ data: expenseData(decision.expense) });
    }
    await tx.changeRecord.create({
      data: {
        storeId: command.storeId,
        sequence: sequence ?? state.lastSequence,
        aggregateType: 'account',
        aggregateId:
          decision.account?.id ?? decision.movements[0]?.accountId ?? decision.reconciliation?.accountId ?? command.id,
        type: decision.changeType,
        commandId: command.id,
        payload: bundle,
        createdAt: now,
      },
    });
    await tx.storeSequence.update({
      where: { storeId: command.storeId },
      data: { lastSequence: sequence ?? state.lastSequence },
    });
    return stored;
  }

  private async persistExpense(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    actorName: string,
    command: IncomingCommand,
    now: Date,
    state: {
      expenses: ExpenseRecord[];
      movements: CashMovementRecord[];
      accounts: CashAccountRecord[];
      categories: CategoryRecord[];
      lastSequence: number;
    },
  ): Promise<StoredCommand> {
    const decision = decideExpenseCommand({
      expenses: state.expenses,
      categories: state.categories,
      command,
      actorUserId,
      actorName,
      now,
    });
    const accepted = decision.type === 'accept';
    const sequence = accepted ? state.lastSequence + 1 : null;
    const expense = accepted ? toPublicExpense(decision.expense) : null;
    const linked = accepted
      ? syncLinkedExpense(state.movements, decision.expense, state.accounts, now).map(toPublicCashMovement)
      : null;
    const stored: StoredCommand = {
      id: command.id,
      storeId: command.storeId,
      deviceId: command.deviceId,
      actorUserId,
      type: command.type,
      status: accepted ? 'accepted' : 'rejected',
      code: decision.type === 'reject' ? decision.code : null,
      message: decision.type === 'reject' ? decision.message : null,
      changeSequence: sequence,
      category: null,
      expense,
      cashMovements: linked,
    };
    await tx.commandRecord.create({
      data: {
        id: stored.id,
        storeId: stored.storeId,
        deviceId: stored.deviceId,
        actorUserId,
        type: stored.type,
        payload: command.payload as Prisma.InputJsonValue,
        status: stored.status,
        code: stored.code,
        message: stored.message,
        changeSequence: stored.changeSequence,
        resultExpense: expense ?? undefined,
        resultCash: linked ? { cashMovements: linked } : undefined,
        createdAt: now,
      },
    });
    if (!accepted) {
      return stored;
    }
    for (const row of linked ?? []) {
      await tx.cashMovement.update({
        where: { id: row.id },
        data: {
          accountId: row.accountId,
          amountMinor: row.amountMinor,
          description: row.description,
          status: row.status,
          revision: row.revision,
        },
      });
    }
    await tx.expense.upsert({
      where: { id: decision.expense.id },
      create: expenseData(decision.expense),
      update: {
        title: decision.expense.title,
        categoryId: decision.expense.categoryId,
        categoryName: decision.expense.categoryName,
        amountMinor: decision.expense.amountMinor,
        accountName: decision.expense.accountName,
        paymentMethodName: decision.expense.paymentMethodName,
        effectiveDate: decision.expense.effectiveDate,
        note: decision.expense.note,
        status: decision.expense.status,
        actorName: decision.expense.actorName,
        isActive: decision.expense.isActive,
        revision: decision.expense.revision,
        updatedBy: decision.expense.updatedBy,
        deviceId: decision.expense.deviceId,
        updatedAt: decision.expense.updatedAt,
      },
    });
    await tx.changeRecord.create({
      data: {
        storeId: command.storeId,
        sequence: sequence ?? state.lastSequence,
        aggregateType: 'expense',
        aggregateId: decision.expense.id,
        type: decision.changeType,
        commandId: command.id,
        payload: { ...(expense ?? {}), cashMovements: linked ?? [] },
        createdAt: now,
      },
    });
    await tx.storeSequence.update({
      where: { storeId: command.storeId },
      data: { lastSequence: sequence ?? state.lastSequence },
    });
    return stored;
  }

  private async persistItem(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    actorName: string,
    command: IncomingCommand,
    now: Date,
    state: {
      items: ItemRecord[];
      units: UnitRecord[];
      batches: BatchRecord[];
      movements: MovementRecord[];
      categories: CategoryRecord[];
      lastSequence: number;
    },
  ): Promise<StoredCommand> {
    const decision = decideItemCommand({
      ...state,
      command,
      actorUserId,
      actorName,
      now,
    });
    const accepted = decision.type === 'accept';
    const sequence = accepted ? state.lastSequence + 1 : null;
    const bundle = {
      unit: accepted && decision.unit ? toPublicUnit(decision.unit) : null,
      item: accepted && decision.item ? toPublicItem(decision.item, decision.batches ?? []) : null,
      movement: accepted && decision.movement ? toPublicMovement(decision.movement) : null,
      batches: accepted && decision.batches ? decision.batches.map(toPublicBatch) : null,
    };
    const stored: StoredCommand = {
      id: command.id,
      storeId: command.storeId,
      deviceId: command.deviceId,
      actorUserId,
      type: command.type,
      status: accepted ? 'accepted' : 'rejected',
      code: decision.type === 'reject' ? decision.code : null,
      message: decision.type === 'reject' ? decision.message : null,
      changeSequence: sequence,
      category: null,
      ...bundle,
    };
    await tx.commandRecord.create({
      data: {
        id: stored.id,
        storeId: stored.storeId,
        deviceId: stored.deviceId,
        actorUserId,
        type: stored.type,
        payload: command.payload as Prisma.InputJsonValue,
        status: stored.status,
        code: stored.code,
        message: stored.message,
        changeSequence: stored.changeSequence,
        resultItem: bundle,
        createdAt: now,
      },
    });
    if (!accepted) {
      return stored;
    }
    if (decision.unit) {
      await tx.unit.upsert({
        where: { id: decision.unit.id },
        create: unitData(decision.unit),
        update: unitData(decision.unit),
      });
    }
    if (decision.item) {
      await tx.item.upsert({
        where: { id: decision.item.id },
        create: itemData(decision.item),
        update: itemData(decision.item),
      });
      await tx.costBatch.deleteMany({ where: { itemId: decision.item.id } });
      if (decision.batches && decision.batches.length > 0) {
        await tx.costBatch.createMany({
          data: decision.batches.map(batchData),
        });
      }
    }
    if (decision.movement) {
      await tx.stockMovement.create({ data: movementData(decision.movement) });
    }
    await tx.changeRecord.create({
      data: {
        storeId: command.storeId,
        sequence: sequence ?? state.lastSequence,
        aggregateType: decision.unit && !decision.item ? 'unit' : 'item',
        aggregateId: decision.unit && !decision.item ? decision.unit.id : (decision.item?.id ?? command.id),
        type: decision.changeType,
        commandId: command.id,
        payload: bundle,
        createdAt: now,
      },
    });
    await tx.storeSequence.update({
      where: { storeId: command.storeId },
      data: { lastSequence: sequence ?? state.lastSequence },
    });
    return stored;
  }

  private async persistPurchase(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    actorName: string,
    command: IncomingCommand,
    now: Date,
    state: {
      purchases: PurchaseRecord[];
      items: ItemRecord[];
      batches: BatchRecord[];
      movements: MovementRecord[];
      accounts: CashAccountRecord[];
      cashMovements: CashMovementRecord[];
      lastSequence: number;
    },
  ): Promise<StoredCommand> {
    const decision = decidePurchaseCommand({
      ...state,
      command,
      actorName,
      now,
    });
    const accepted = decision.type === 'accept';
    const sequence = accepted ? state.lastSequence + 1 : null;
    const purchase = accepted ? toPublicPurchase(decision.effects.purchase) : null;
    const bundle = {
      purchase,
      movement: accepted && decision.effects.movements[0] ? toPublicMovement(decision.effects.movements[0]) : null,
      batches: accepted ? decision.effects.batches.map(toPublicBatch) : null,
      cashMovements: accepted ? decision.effects.cashMovements.map(toPublicCashMovement) : null,
    };
    const stored: StoredCommand = {
      id: command.id,
      storeId: command.storeId,
      deviceId: command.deviceId,
      actorUserId,
      type: command.type,
      status: accepted ? 'accepted' : 'rejected',
      code: decision.type === 'reject' ? decision.code : null,
      message: decision.type === 'reject' ? decision.message : null,
      changeSequence: sequence,
      category: null,
      purchase,
      movement: bundle.movement,
      batches: bundle.batches,
      cashMovements: bundle.cashMovements,
    };
    await tx.commandRecord.create({
      data: {
        id: stored.id,
        storeId: stored.storeId,
        deviceId: stored.deviceId,
        actorUserId,
        type: stored.type,
        payload: command.payload as Prisma.InputJsonValue,
        status: stored.status,
        code: stored.code,
        message: stored.message,
        changeSequence: stored.changeSequence,
        resultPurchase: bundle,
        createdAt: now,
      },
    });
    if (!accepted) {
      return stored;
    }
    const row = decision.effects.purchase;
    if (command.type === 'purchase.purge') {
      await tx.purchaseDocument.deleteMany({ where: { id: row.id, storeId: row.storeId, isActive: false } });
      await tx.changeRecord.create({
        data: {
          storeId: command.storeId,
          sequence: sequence ?? state.lastSequence,
          aggregateType: 'purchase',
          aggregateId: row.id,
          type: decision.changeType,
          commandId: command.id,
          payload: bundle,
          createdAt: now,
        },
      });
      await tx.storeSequence.update({
        where: { storeId: command.storeId },
        data: { lastSequence: sequence ?? state.lastSequence },
      });
      return stored;
    }
    await tx.purchaseDocument.upsert({
      where: { id: row.id },
      create: {
        id: row.id,
        storeId: row.storeId,
        number: row.number,
        normalizedNumber: row.normalizedNumber,
        supplierName: row.supplierName,
        effectiveDate: row.effectiveDate,
        occurredAt: row.occurredAt,
        grossMinor: row.grossMinor,
        discountMinor: row.discountMinor,
        taxMinor: row.taxMinor,
        shippingMinor: row.shippingMinor,
        netMinor: row.netMinor,
        paidMinor: row.paidMinor,
        dueMinor: row.dueMinor,
        note: row.note,
        isActive: row.isActive,
        revision: row.revision,
        lines: row.lines as Prisma.InputJsonValue,
        payments: row.payments as Prisma.InputJsonValue,
        returns: row.returns as Prisma.InputJsonValue,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      update: {
        supplierName: row.supplierName,
        paidMinor: row.paidMinor,
        dueMinor: row.dueMinor,
        note: row.note,
        isActive: row.isActive,
        revision: row.revision,
        lines: row.lines as Prisma.InputJsonValue,
        payments: row.payments as Prisma.InputJsonValue,
        returns: row.returns as Prisma.InputJsonValue,
        updatedAt: row.updatedAt,
      },
    });
    for (const item of decision.effects.items) {
      await tx.item.update({
        where: { id: item.id },
        data: {
          stockQty: item.stockQty,
          revision: item.revision,
          updatedAt: item.updatedAt,
        },
      });
    }
    for (const batch of decision.effects.batches) {
      await tx.costBatch.upsert({
        where: { id: batch.id },
        create: batchData(batch),
        update: { remainingQty: batch.remainingQty, revision: batch.revision },
      });
    }
    for (const movement of decision.effects.movements) {
      await upsertStockMovement(tx, movement);
    }
    for (const movement of decision.effects.cashMovements) {
      await tx.cashMovement.upsert({
        where: { id: movement.id },
        create: cashMovementData(movement),
        update: {
          status: movement.status,
          amountMinor: movement.amountMinor,
          revision: movement.revision,
        },
      });
    }
    await tx.changeRecord.create({
      data: {
        storeId: command.storeId,
        sequence: sequence ?? state.lastSequence,
        aggregateType: 'purchase',
        aggregateId: row.id,
        type: decision.changeType,
        commandId: command.id,
        payload: bundle,
        createdAt: now,
      },
    });
    await tx.storeSequence.update({
      where: { storeId: command.storeId },
      data: { lastSequence: sequence ?? state.lastSequence },
    });
    return stored;
  }

  private async persistHeld(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    command: IncomingCommand,
    now: Date,
    state: { held: PublicHeldSale[]; lastSequence: number },
  ): Promise<StoredCommand> {
    const decision = decideHeldSale({ held: state.held, command });
    const accepted = decision.type === 'accept';
    const sequence = accepted ? state.lastSequence + 1 : null;
    const held = accepted ? decision.held : null;
    const stored: StoredCommand = {
      id: command.id,
      storeId: command.storeId,
      deviceId: command.deviceId,
      actorUserId,
      type: command.type,
      status: accepted ? 'accepted' : 'rejected',
      code: decision.type === 'reject' ? decision.code : null,
      message: decision.type === 'reject' ? decision.message : null,
      changeSequence: sequence,
      category: null,
      heldSale: held,
    };
    await tx.commandRecord.create({
      data: {
        id: stored.id,
        storeId: stored.storeId,
        deviceId: stored.deviceId,
        actorUserId,
        type: stored.type,
        payload: command.payload as Prisma.InputJsonValue,
        status: stored.status,
        code: stored.code,
        message: stored.message,
        changeSequence: stored.changeSequence,
        resultHeld: held ?? undefined,
        createdAt: now,
      },
    });
    if (!accepted || !held) {
      return stored;
    }
    if (held.removed) {
      await tx.heldSale.deleteMany({ where: { id: held.id, storeId: held.storeId } });
    } else {
      const data = heldData(held);
      await tx.heldSale.upsert({
        where: { id: held.id },
        create: { id: held.id, store: { connect: { id: held.storeId } }, ...data },
        update: data,
      });
    }
    await tx.changeRecord.create({
      data: {
        storeId: command.storeId,
        sequence: sequence ?? state.lastSequence,
        aggregateType: 'heldSale',
        aggregateId: held.id,
        type: decision.changeType,
        commandId: command.id,
        payload: held as Prisma.InputJsonValue,
        createdAt: now,
      },
    });
    await tx.storeSequence.update({
      where: { storeId: command.storeId },
      data: { lastSequence: sequence ?? state.lastSequence },
    });
    return stored;
  }

  private async persistSale(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    actorName: string,
    command: IncomingCommand,
    now: Date,
    state: {
      sales: SaleRecord[];
      items: ItemRecord[];
      batches: BatchRecord[];
      movements: MovementRecord[];
      accounts: CashAccountRecord[];
      cashMovements: CashMovementRecord[];
      lastSequence: number;
    },
  ): Promise<StoredCommand> {
    const decision = decideSaleCommand({ ...state, command, actorName, now });
    const accepted = decision.type === 'accept';
    const sequence = accepted ? state.lastSequence + 1 : null;
    const sale = accepted ? toPublicSale(decision.effects.sale) : null;
    const bundle = {
      sale,
      movement: accepted && decision.effects.movements[0] ? toPublicMovement(decision.effects.movements[0]) : null,
      batches: accepted ? decision.effects.batches.map(toPublicBatch) : null,
      cashMovements: accepted ? decision.effects.cashMovements.map(toPublicCashMovement) : null,
    };
    const stored: StoredCommand = {
      id: command.id,
      storeId: command.storeId,
      deviceId: command.deviceId,
      actorUserId,
      type: command.type,
      status: accepted ? 'accepted' : 'rejected',
      code: decision.type === 'reject' ? decision.code : null,
      message: decision.type === 'reject' ? decision.message : null,
      changeSequence: sequence,
      category: null,
      sale,
      movement: bundle.movement,
      batches: bundle.batches,
      cashMovements: bundle.cashMovements,
    };
    await tx.commandRecord.create({
      data: {
        id: stored.id,
        storeId: stored.storeId,
        deviceId: stored.deviceId,
        actorUserId,
        type: stored.type,
        payload: command.payload as Prisma.InputJsonValue,
        status: stored.status,
        code: stored.code,
        message: stored.message,
        changeSequence: stored.changeSequence,
        resultSale: bundle,
        createdAt: now,
      },
    });
    if (!accepted) {
      return stored;
    }
    const row = decision.effects.sale;
    if (command.type === 'sale.purge') {
      await tx.saleDocument.deleteMany({ where: { id: row.id, storeId: row.storeId, isActive: false } });
      await tx.changeRecord.create({
        data: {
          storeId: command.storeId,
          sequence: sequence ?? state.lastSequence,
          aggregateType: 'sale',
          aggregateId: row.id,
          type: decision.changeType,
          commandId: command.id,
          payload: bundle,
          createdAt: now,
        },
      });
      await tx.storeSequence.update({
        where: { storeId: command.storeId },
        data: { lastSequence: sequence ?? state.lastSequence },
      });
      return stored;
    }
    await tx.saleDocument.upsert({
      where: { id: row.id },
      create: {
        id: row.id,
        storeId: row.storeId,
        number: row.number,
        normalizedNumber: row.normalizedNumber,
        contactName: row.contactName,
        effectiveDate: row.effectiveDate,
        occurredAt: row.occurredAt,
        grossMinor: row.grossMinor,
        discountMinor: row.discountMinor,
        taxMinor: row.taxMinor,
        deliveryMinor: row.deliveryMinor,
        netMinor: row.netMinor,
        costMinor: row.costMinor,
        receivedMinor: row.receivedMinor,
        dueMinor: row.dueMinor,
        note: row.note,
        isActive: row.isActive,
        revision: row.revision,
        lines: row.lines as Prisma.InputJsonValue,
        payments: row.payments as Prisma.InputJsonValue,
        returns: row.returns as Prisma.InputJsonValue,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      update: {
        contactName: row.contactName,
        netMinor: row.netMinor,
        costMinor: row.costMinor,
        receivedMinor: row.receivedMinor,
        dueMinor: row.dueMinor,
        note: row.note,
        isActive: row.isActive,
        revision: row.revision,
        lines: row.lines as Prisma.InputJsonValue,
        payments: row.payments as Prisma.InputJsonValue,
        returns: row.returns as Prisma.InputJsonValue,
        updatedAt: row.updatedAt,
      },
    });
    for (const item of decision.effects.items) {
      await tx.item.update({
        where: { id: item.id },
        data: {
          stockQty: item.stockQty,
          revision: item.revision,
          updatedAt: item.updatedAt,
        },
      });
    }
    for (const batch of decision.effects.batches) {
      await tx.costBatch.upsert({
        where: { id: batch.id },
        create: batchData(batch),
        update: { remainingQty: batch.remainingQty, revision: batch.revision },
      });
    }
    for (const movement of decision.effects.movements) {
      await upsertStockMovement(tx, movement);
    }
    for (const movement of decision.effects.cashMovements) {
      await tx.cashMovement.upsert({
        where: { id: movement.id },
        create: cashMovementData(movement),
        update: {
          status: movement.status,
          amountMinor: movement.amountMinor,
          revision: movement.revision,
        },
      });
    }
    await tx.changeRecord.create({
      data: {
        storeId: command.storeId,
        sequence: sequence ?? state.lastSequence,
        aggregateType: 'sale',
        aggregateId: row.id,
        type: decision.changeType,
        commandId: command.id,
        payload: bundle,
        createdAt: now,
      },
    });
    await tx.storeSequence.update({
      where: { storeId: command.storeId },
      data: { lastSequence: sequence ?? state.lastSequence },
    });
    return stored;
  }

  private async persistShop(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    command: IncomingCommand,
    now: Date,
    state: {
      store: StoreRecord;
      methods: PaymentMethodRecord[];
      accounts: Array<{ id: string; name: string; isActive: boolean }>;
      lastSequence: number;
    },
  ): Promise<StoredCommand> {
    const decision = decideShopCommand({
      store: state.store,
      methods: state.methods,
      accounts: state.accounts,
      command,
      now,
    });
    const accepted = decision.type === 'accept';
    const sequence = accepted ? state.lastSequence + 1 : null;
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
      changeSequence: sequence,
      category: null,
      store: accepted ? decision.store : null,
      paymentMethods: methods,
    };
    await tx.commandRecord.create({
      data: {
        id: command.id,
        storeId: command.storeId,
        deviceId: command.deviceId,
        actorUserId,
        type: command.type,
        payload: command.payload as Prisma.InputJsonValue,
        status: stored.status,
        code: stored.code,
        message: stored.message,
        changeSequence: sequence,
        resultShop: {
          store: stored.store,
          paymentMethods: stored.paymentMethods,
        } as Prisma.InputJsonValue,
        createdAt: now,
      },
    });
    if (!accepted) {
      return stored;
    }
    if (decision.store) {
      await tx.store.update({
        where: { id: state.store.id },
        data: {
          name: decision.store.name,
          address: decision.store.address,
          phone: decision.store.phone,
          email: decision.store.email,
          currencySymbol: decision.store.currencySymbol,
          taxName: decision.store.taxName,
          taxRatePercent: decision.store.taxRatePercent,
          revision: decision.store.revision,
          updatedAt: now,
        },
      });
    }
    if (decision.methods) {
      await tx.paymentMethod.deleteMany({
        where: { storeId: command.storeId },
      });
      await tx.paymentMethod.createMany({
        data: decision.methods.map((method) => ({
          id: method.id,
          storeId: method.storeId,
          name: method.name,
          normalizedName: method.normalizedName,
          accountId: method.accountId,
          isDefault: method.isDefault,
          isActive: method.isActive,
          revision: method.revision,
          createdAt: method.createdAt,
          updatedAt: method.updatedAt,
        })),
      });
    }
    await tx.changeRecord.create({
      data: {
        storeId: command.storeId,
        sequence: sequence ?? state.lastSequence,
        aggregateType: command.type.startsWith('store.') ? 'store' : 'paymentMethod',
        aggregateId: decision.store?.id ?? command.storeId,
        type: decision.changeType,
        commandId: command.id,
        payload: (decision.store ?? {
          paymentMethods: methods,
        }) as Prisma.InputJsonValue,
        createdAt: now,
      },
    });
    await tx.storeSequence.update({
      where: { storeId: command.storeId },
      data: { lastSequence: sequence ?? state.lastSequence },
    });
    return stored;
  }

  private async publicItems(storeId: string): Promise<PublicItem[]> {
    const [items, batches] = await Promise.all([
      this.prisma.item.findMany({
        where: { storeId, isActive: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.costBatch.findMany({ where: { storeId } }),
    ]);
    const records = batches.map(toBatch);
    return items.map((item) => toPublicItem(toItem(item), records));
  }

  async snapshot(storeId: string): Promise<StoreSnapshot> {
    const store = await this.prisma.store.findUniqueOrThrow({
      where: { id: storeId },
    });
    const categories = await this.prisma.category.findMany({
      where: { storeId },
      orderBy: { sortOrder: 'asc' },
    });
    const sequence = await this.prisma.storeSequence.findUnique({
      where: { storeId },
    });
    const methodRows = await this.prisma.paymentMethod.findMany({
      where: { storeId, isActive: true },
      orderBy: { name: 'asc' },
    });
    const accountNames = new Map(
      (await this.prisma.cashAccount.findMany({ where: { storeId } })).map((account) => [account.id, account.name]),
    );
    return {
      store: toStore(store),
      categories: categories.map((category) => toPublicCategory(toCategory(category))),
      contacts: (
        await this.prisma.contact.findMany({
          where: { storeId, isActive: true },
          orderBy: { name: 'asc' },
        })
      ).map((contact) => toPublicContact(toContact(contact))),
      units: (
        await this.prisma.unit.findMany({
          where: { storeId },
          orderBy: { name: 'asc' },
        })
      ).map((unit) => toPublicUnit(toUnit(unit))),
      items: await this.publicItems(storeId),
      movements: (
        await this.prisma.stockMovement.findMany({
          where: { storeId },
          orderBy: { occurredAt: 'desc' },
        })
      ).map((movement) => toPublicMovement(toMovement(movement))),
      batches: (
        await this.prisma.costBatch.findMany({
          where: { storeId },
          orderBy: { receivedOn: 'asc' },
        })
      ).map((batch) => toPublicBatch(toBatch(batch))),
      expenses: (
        await this.prisma.expense.findMany({
          where: { storeId, isActive: true },
          orderBy: [{ effectiveDate: 'desc' }, { title: 'asc' }],
        })
      ).map((expense) => toPublicExpense(toExpense(expense))),
      accounts: (
        await this.prisma.cashAccount.findMany({
          where: { storeId, isActive: true },
          orderBy: { name: 'asc' },
        })
      ).map((account) => toPublicCashAccount(toCashAccount(account))),
      cashMovements: (
        await this.prisma.cashMovement.findMany({
          where: { storeId },
          orderBy: { occurredAt: 'asc' },
        })
      ).map((row) => toPublicCashMovement(toCashMovement(row))),
      reconciliations: (
        await this.prisma.cashReconciliation.findMany({
          where: { storeId },
          orderBy: { cutoffAt: 'desc' },
        })
      ).map((row) => toPublicReconciliation(toReconciliation(row))),
      sales: (
        await this.prisma.saleDocument.findMany({
          where: { storeId, isActive: true },
          orderBy: { occurredAt: 'desc' },
        })
      ).map((row) => toPublicSale(toSale(row))),
      heldSales: (
        await this.prisma.heldSale.findMany({
          where: { storeId, removed: false },
          orderBy: { updatedAt: 'desc' },
        })
      ).map(toHeldSale),
      purchases: (
        await this.prisma.purchaseDocument.findMany({
          where: { storeId, isActive: true },
          orderBy: { occurredAt: 'desc' },
        })
      ).map((row) => toPublicPurchase(toPurchase(row))),
      paymentMethods: methodRows.map((method) =>
        toPublicPaymentMethod(toPaymentMethod(method, accountNames.get(method.accountId) ?? '')),
      ),
      lastSequence: sequence?.lastSequence ?? 0,
    };
  }

  async changes(storeId: string, after: number): Promise<{ changes: ChangeEntry[]; lastSequence: number }> {
    const rows = await this.prisma.changeRecord.findMany({
      where: { storeId, sequence: { gt: after } },
      orderBy: { sequence: 'asc' },
    });
    const sequence = await this.prisma.storeSequence.findUnique({
      where: { storeId },
    });
    return {
      changes: rows.map((row) => ({
        sequence: row.sequence,
        storeId: row.storeId,
        aggregateType: changeType(row.aggregateType),
        aggregateId: row.aggregateId,
        type: row.type,
        commandId: row.commandId,
        category: row.aggregateType === 'category' ? (row.payload as PublicCategory) : null,
        contact: row.aggregateType === 'contact' ? (row.payload as PublicContact) : null,
        unit: row.aggregateType === 'unit' ? (row.payload as PublicUnit) : itemBundle(row.payload).unit,
        item: itemBundle(row.payload).item,
        expense:
          row.aggregateType === 'expense' && isPublicExpense(row.payload)
            ? row.payload
            : cashBundle(row.payload).expense,
        account: cashBundle(row.payload).account,
        reconciliation: cashBundle(row.payload).reconciliation,
        sale: row.aggregateType === 'sale' ? saleBundle(row.payload).sale : null,
        heldSale: row.aggregateType === 'heldSale' ? toPublicHeld(row.payload) : null,
        purchase: row.aggregateType === 'purchase' ? purchaseBundle(row.payload).purchase : null,
        store: row.aggregateType === 'store' && isPublicStore(row.payload) ? row.payload : null,
        paymentMethods: row.aggregateType === 'paymentMethod' ? paymentMethodList(row.payload) : null,
        batches:
          row.aggregateType === 'purchase'
            ? purchaseBundle(row.payload).batches
            : row.aggregateType === 'sale'
              ? saleBundle(row.payload).batches
              : itemBundle(row.payload).batches,
        cashMovements:
          row.aggregateType === 'purchase'
            ? purchaseBundle(row.payload).cashMovements
            : row.aggregateType === 'sale'
              ? saleBundle(row.payload).cashMovements
              : cashBundle(row.payload).cashMovements,
        movement:
          row.aggregateType === 'purchase'
            ? purchaseBundle(row.payload).movement
            : row.aggregateType === 'sale'
              ? saleBundle(row.payload).movement
              : itemBundle(row.payload).movement,
      })),
      lastSequence: sequence?.lastSequence ?? 0,
    };
  }

  async acknowledge(storeId: string, deviceId: string, sequence: number): Promise<void> {
    await this.prisma.syncCursor.upsert({
      where: { storeId_deviceId: { storeId, deviceId } },
      create: { storeId, deviceId, lastSequence: sequence },
      update: { lastSequence: sequence },
    });
  }

  async listDevices(storeId: string) {
    const members = await this.prisma.storeMember.findMany({
      where: { storeId },
      include: { user: { select: { id: true, name: true } } },
    });
    const names = new Map(members.map((member) => [member.userId, member.user.name]));
    const owner = members.find((member) => member.role === 'OWNER') ?? members[0];
    const sessions =
      names.size === 0
        ? []
        : await this.prisma.session.findMany({
            where: { userId: { in: [...names.keys()] }, revokedAt: null },
            orderBy: { createdAt: 'desc' },
          });
    const seen = await this.prisma.commandRecord.groupBy({
      by: ['deviceId'],
      where: { storeId },
      _max: { createdAt: true },
    });
    const cursors = await this.prisma.syncCursor.findMany({ where: { storeId } });
    return mergeShopDevices({
      sessions,
      commands: seen.map((row) => ({ deviceId: row.deviceId, createdAt: row._max.createdAt })),
      cursors,
      names,
      fallbackName: owner?.user.name ?? '',
    });
  }

  async revokeDevice(storeId: string, deviceId: string, now: Date): Promise<void> {
    const members = await this.prisma.storeMember.findMany({
      where: { storeId },
      select: { userId: true },
    });
    if (members.length === 0) {
      return;
    }
    await this.prisma.session.updateMany({
      where: {
        deviceId,
        userId: { in: members.map((member) => member.userId) },
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
  }

  async listCommands(storeId: string) {
    const rows = await this.prisma.commandRecord.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const sessions = await this.prisma.session.findMany({
      where: { deviceId: { in: [...new Set(rows.map((row) => row.deviceId))] } },
      orderBy: { createdAt: 'desc' },
    });
    const names = new Map<string, string>();
    for (const session of sessions) {
      if (!names.has(session.deviceId)) {
        names.set(session.deviceId, session.deviceName ?? 'Device');
      }
    }
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      deviceId: row.deviceId,
      deviceName: names.get(row.deviceId) ?? 'Device',
      status: row.status,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
      label: commandLabel(row.type, row.payload),
    }));
  }

  async listMembers(storeId: string) {
    const rows = await this.prisma.storeMember.findMany({
      where: { storeId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const rank = { OWNER: 0, MANAGER: 1, CASHIER: 2 };
    return rows
      .map((row) => ({
        userId: row.user.id,
        name: row.user.name,
        email: row.user.email,
        role: memberRole(row.role),
        status: 'ACTIVE' as const,
      }))
      .sort((left, right) => rank[left.role] - rank[right.role]);
  }

  async inviteMember(
    storeId: string,
    actorUserId: string,
    input: { email: string; role: 'MANAGER' | 'CASHIER'; password: string },
  ) {
    const actor = await this.prisma.storeMember.findUnique({
      where: { storeId_userId: { storeId, userId: actorUserId } },
    });
    if (!actor || actor.role !== 'OWNER') {
      throw new CatalogError('forbidden', 'Only the owner can invite a member.', 403);
    }
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      const membership = await this.prisma.storeMember.findUnique({
        where: { storeId_userId: { storeId, userId: existing.id } },
      });
      if (membership) {
        throw new CatalogError('validation_error', 'This person is already on the team.', 400);
      }
    }
    const passwordHash = await new Argon2PasswordHasher().hash(input.password);
    const user = existing
      ? await this.prisma.user.update({
          where: { id: existing.id },
          data: { passwordHash },
        })
      : await this.prisma.user.create({
          data: {
            id: randomUUID(),
            email,
            name: nameFromEmail(email),
            passwordHash,
          },
        });
    await this.prisma.storeMember.create({
      data: { storeId, userId: user.id, role: input.role },
    });
    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      role: input.role,
      status: 'ACTIVE' as const,
    };
  }
}

function memberRole(value: string): 'OWNER' | 'MANAGER' | 'CASHIER' {
  if (value === 'MANAGER' || value === 'CASHIER') {
    return value;
  }
  return 'OWNER';
}

function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  const name = local
    .split(/[._-]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  return name.length > 0 ? name : email;
}

function commandLabel(type: string, payload: unknown): string {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const number = typeof record.number === 'string' ? record.number : '';
  const title = typeof record.title === 'string' ? record.title : '';
  const name = typeof record.name === 'string' ? record.name : '';
  if (type.startsWith('sale')) {
    return `Sale ${number}`.trim();
  }
  if (type.startsWith('purchase')) {
    return `Purchase ${number}`.trim();
  }
  if (type.startsWith('expense')) {
    return `Expense ${title || name}`.trim();
  }
  if (type.startsWith('item')) {
    return `Item ${name}`.trim();
  }
  if (type.startsWith('contact')) {
    return `Contact ${name}`.trim();
  }
  if (type.startsWith('category')) {
    return `Category ${name}`.trim();
  }
  if (type.startsWith('cash') || type.startsWith('payment')) {
    return `Cash ${title || name}`.trim();
  }
  return type;
}

function changeType(value: string): ChangeEntry['aggregateType'] {
  if (
    value === 'contact' ||
    value === 'unit' ||
    value === 'item' ||
    value === 'expense' ||
    value === 'account' ||
    value === 'sale' ||
    value === 'heldSale' ||
    value === 'purchase' ||
    value === 'store' ||
    value === 'paymentMethod'
  ) {
    return value;
  }
  return 'category';
}

function itemBundle(payload: Prisma.JsonValue | null): {
  unit: PublicUnit | null;
  item: PublicItem | null;
  movement: PublicMovement | null;
  batches: PublicBatch[] | null;
} {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || !('item' in payload)) {
    return { unit: null, item: null, movement: null, batches: null };
  }
  const row = payload as Record<string, Prisma.JsonValue | undefined>;
  return {
    unit: isPublicUnit(row.unit) ? row.unit : null,
    item: isPublicItem(row.item) ? row.item : null,
    movement: isPublicMovement(row.movement) ? row.movement : null,
    batches: Array.isArray(row.batches) ? row.batches.filter(isPublicBatch) : null,
  };
}

function isPublicUnit(value: Prisma.JsonValue | null | undefined): value is PublicUnit {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.id === 'string';
}

function isPublicItem(value: Prisma.JsonValue | null | undefined): value is PublicItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.id === 'string' &&
    typeof value.itemType === 'string'
  );
}

function isPublicMovement(value: Prisma.JsonValue | null | undefined): value is PublicMovement {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.id === 'string';
}

function isPublicBatch(value: Prisma.JsonValue | null | undefined): value is PublicBatch {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.id === 'string';
}

function toStore(store: {
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
  ownerId: string;
}): StoreRecord {
  return {
    id: store.id,
    name: store.name,
    address: store.address,
    phone: store.phone,
    email: store.email,
    currencyCode: store.currencyCode,
    currencySymbol: store.currencySymbol,
    taxName: store.taxName,
    taxRatePercent: store.taxRatePercent,
    timezone: store.timezone,
    revision: store.revision,
    ownerId: store.ownerId,
  };
}

function toPaymentMethod(
  method: {
    id: string;
    storeId: string;
    name: string;
    normalizedName: string;
    accountId: string;
    isDefault: boolean;
    isActive: boolean;
    revision: number;
    createdAt: Date;
    updatedAt: Date;
  },
  accountName: string,
): PaymentMethodRecord {
  return {
    id: method.id,
    storeId: method.storeId,
    name: method.name,
    normalizedName: method.normalizedName,
    accountId: method.accountId,
    accountName,
    isDefault: method.isDefault,
    isActive: method.isActive,
    revision: method.revision,
    createdAt: method.createdAt,
    updatedAt: method.updatedAt,
  };
}

function isPublicStore(value: Prisma.JsonValue | null): value is PublicStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.id === 'string' &&
    typeof value.revision === 'number'
  );
}

function paymentMethodList(value: Prisma.JsonValue | null): PublicPaymentMethod[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('paymentMethods' in value)) {
    return null;
  }
  const methods = value.paymentMethods;
  return Array.isArray(methods) ? methods.filter(isPublicPaymentMethod) : null;
}

function isPublicPaymentMethod(value: unknown): value is PublicPaymentMethod {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const method = value as PublicPaymentMethod;
  return typeof method.id === 'string' && typeof method.name === 'string' && typeof method.accountId === 'string';
}

function toCategory(row: {
  id: string;
  storeId: string;
  kind: string;
  name: string;
  normalizedName: string;
  description: string;
  isActive: boolean;
  sortOrder: number;
  revision: number;
  createdBy: string;
  updatedBy: string;
  deviceId: string;
  createdAt: Date;
  updatedAt: Date;
}): CategoryRecord {
  return {
    id: row.id,
    storeId: row.storeId,
    kind: row.kind as CategoryRecord['kind'],
    name: row.name,
    normalizedName: row.normalizedName,
    description: row.description,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    revision: row.revision,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    deviceId: row.deviceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function categoryData(category: CategoryRecord): Prisma.CategoryCreateManyInput {
  return {
    id: category.id,
    storeId: category.storeId,
    kind: category.kind,
    name: category.name,
    normalizedName: category.normalizedName,
    description: category.description,
    isActive: category.isActive,
    sortOrder: category.sortOrder,
    revision: category.revision,
    createdBy: category.createdBy,
    updatedBy: category.updatedBy,
    deviceId: category.deviceId,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
}

function toStoredCommand(row: {
  id: string;
  storeId: string;
  deviceId: string;
  actorUserId: string;
  type: string;
  status: string;
  code: string | null;
  message: string | null;
  changeSequence: number | null;
  resultCategory: Prisma.JsonValue | null;
  resultContact: Prisma.JsonValue | null;
  resultItem: Prisma.JsonValue | null;
  resultExpense: Prisma.JsonValue | null;
  resultCash: Prisma.JsonValue | null;
  resultSale: Prisma.JsonValue | null;
  resultHeld: Prisma.JsonValue | null;
  resultPurchase: Prisma.JsonValue | null;
  resultShop: Prisma.JsonValue | null;
}): StoredCommand {
  const bundle = itemBundle(row.resultItem);
  const cash = cashBundle(row.resultCash);
  const shop = shopBundle(row.resultShop);
  return {
    id: row.id,
    storeId: row.storeId,
    deviceId: row.deviceId,
    actorUserId: row.actorUserId,
    type: row.type,
    status: row.status === 'accepted' ? 'accepted' : 'rejected',
    code: row.code,
    message: row.message,
    changeSequence: row.changeSequence,
    category: isPublicCategory(row.resultCategory) ? row.resultCategory : null,
    contact: isPublicContact(row.resultContact) ? row.resultContact : null,
    unit: bundle.unit,
    item: bundle.item,
    movement: bundle.movement,
    batches: bundle.batches,
    expense: isPublicExpense(row.resultExpense) ? row.resultExpense : cash.expense,
    account: cash.account,
    cashMovements: cash.cashMovements,
    reconciliation: cash.reconciliation,
    sale: saleBundle(row.resultSale).sale,
    heldSale: toPublicHeld(row.resultHeld),
    purchase: purchaseBundle(row.resultPurchase).purchase,
    store: shop.store,
    paymentMethods: shop.paymentMethods,
  };
}

function shopBundle(value: Prisma.JsonValue | null): {
  store: PublicStore | null;
  paymentMethods: PublicPaymentMethod[] | null;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { store: null, paymentMethods: null };
  }
  const record = value as Record<string, Prisma.JsonValue | undefined>;
  return {
    store: record.store && isPublicStore(record.store) ? record.store : null,
    paymentMethods: Array.isArray(record.paymentMethods) ? record.paymentMethods.filter(isPublicPaymentMethod) : null,
  };
}

function purchaseBundle(value: Prisma.JsonValue | null): {
  purchase: PublicPurchase | null;
  batches: PublicBatch[] | null;
  cashMovements: PublicCashMovement[] | null;
  movement: PublicMovement | null;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      purchase: null,
      batches: null,
      cashMovements: null,
      movement: null,
    };
  }
  const record = value as Record<string, Prisma.JsonValue>;
  return {
    purchase: isPublicPurchase(record.purchase) ? record.purchase : null,
    batches: Array.isArray(record.batches) ? record.batches.filter(isPublicBatch) : null,
    cashMovements: Array.isArray(record.cashMovements) ? (record.cashMovements as PublicCashMovement[]) : null,
    movement: isPublicMovement(record.movement) ? record.movement : null,
  };
}

function isPublicPurchase(value: unknown): value is PublicPurchase {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const purchase = value as PublicPurchase;
  return typeof purchase.id === 'string' && typeof purchase.number === 'string' && Array.isArray(purchase.lines);
}

function saleBundle(value: Prisma.JsonValue | null): {
  sale: PublicSale | null;
  batches: PublicBatch[] | null;
  cashMovements: PublicCashMovement[] | null;
  movement: PublicMovement | null;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { sale: null, batches: null, cashMovements: null, movement: null };
  }
  const record = value as Record<string, Prisma.JsonValue>;
  return {
    sale: isPublicSale(record.sale) ? record.sale : null,
    batches: Array.isArray(record.batches) ? record.batches.filter(isPublicBatch) : null,
    cashMovements: Array.isArray(record.cashMovements) ? (record.cashMovements as PublicCashMovement[]) : null,
    movement: isPublicMovement(record.movement) ? record.movement : null,
  };
}

function isPublicSale(value: unknown): value is PublicSale {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const sale = value as PublicSale;
  return typeof sale.id === 'string' && typeof sale.number === 'string' && Array.isArray(sale.lines);
}

function cashBundle(value: Prisma.JsonValue | null): {
  account: PublicCashAccount | null;
  cashMovements: PublicCashMovement[] | null;
  reconciliation: PublicReconciliation | null;
  expense: PublicExpense | null;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      account: null,
      cashMovements: null,
      reconciliation: null,
      expense: null,
    };
  }
  const record = value as Record<string, Prisma.JsonValue | undefined>;
  const account = record.account ?? null;
  const reconciliation = record.reconciliation ?? null;
  const expense = record.expense ?? null;
  const movements = record.cashMovements;
  return {
    account: isCashAccount(account) ? account : null,
    cashMovements: Array.isArray(movements) ? movements.filter(isCashMovement) : null,
    reconciliation: isReconciliation(reconciliation) ? reconciliation : null,
    expense: isPublicExpense(expense) ? expense : null,
  };
}

function isCashAccount(value: Prisma.JsonValue | null): value is PublicCashAccount {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'accountType' in value &&
    'openingMinor' in value
  );
}

function isCashMovement(value: Prisma.JsonValue): value is PublicCashMovement {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'direction' in value && 'source' in value
  );
}

function isReconciliation(value: Prisma.JsonValue | null): value is PublicReconciliation {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'countedMinor' in value &&
    'cutoffAt' in value
  );
}

function isPublicExpense(value: Prisma.JsonValue | null): value is PublicExpense {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && 'amountMinor' in value && 'status' in value
  );
}

function toExpense(row: {
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
    receiptImage?: string;
    status: string;
  actorName: string;
  isActive: boolean;
  revision: number;
  createdBy: string;
  updatedBy: string;
  deviceId: string;
  createdAt: Date;
  updatedAt: Date;
}): ExpenseRecord {
  return {
    id: row.id,
    storeId: row.storeId,
    title: row.title,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    amountMinor: row.amountMinor,
    accountName: row.accountName,
    paymentMethodName: row.paymentMethodName,
    effectiveDate: row.effectiveDate,
    note: row.note,
    receiptImage: 'receiptImage' in row && typeof row.receiptImage === 'string' ? row.receiptImage : '',
    status: row.status === 'VOID' ? 'VOID' : 'PAID',
    actorName: row.actorName,
    isActive: row.isActive,
    revision: row.revision,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    deviceId: row.deviceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function expenseData(expense: ExpenseRecord): Prisma.ExpenseCreateInput {
  return {
    id: expense.id,
    store: { connect: { id: expense.storeId } },
    title: expense.title,
    categoryId: expense.categoryId,
    categoryName: expense.categoryName,
    amountMinor: expense.amountMinor,
    accountName: expense.accountName,
    paymentMethodName: expense.paymentMethodName,
    effectiveDate: expense.effectiveDate,
    note: expense.note,
    receiptImage: expense.receiptImage,
    status: expense.status,
    actorName: expense.actorName,
    isActive: expense.isActive,
    revision: expense.revision,
    createdBy: expense.createdBy,
    updatedBy: expense.updatedBy,
    deviceId: expense.deviceId,
    createdAt: expense.createdAt,
    updatedAt: expense.updatedAt,
  };
}

function cashAccountData(account: CashAccountRecord): Prisma.CashAccountCreateInput {
  return {
    id: account.id,
    store: { connect: { id: account.storeId } },
    name: account.name,
    normalizedName: account.normalizedName,
    accountType: account.accountType,
    openingMinor: account.openingMinor,
    isActive: account.isActive,
    revision: account.revision,
    createdBy: account.createdBy,
    updatedBy: account.updatedBy,
    deviceId: account.deviceId,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function cashMovementData(row: CashMovementRecord): Prisma.CashMovementCreateInput {
  return {
    id: row.id,
    store: { connect: { id: row.storeId } },
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
    createdAt: row.createdAt,
  };
}

function reconciliationData(row: ReconciliationRecord): Prisma.CashReconciliationCreateInput {
  return {
    id: row.id,
    store: { connect: { id: row.storeId } },
    accountId: row.accountId,
    cutoffAt: row.cutoffAt,
    systemBalanceMinor: row.systemBalanceMinor,
    countedMinor: row.countedMinor,
    note: row.note,
    revision: row.revision,
    createdBy: row.createdBy,
    deviceId: row.deviceId,
    createdAt: row.createdAt,
  };
}

function toCashAccount(row: {
  id: string;
  storeId: string;
  name: string;
  normalizedName: string;
  accountType: string;
  openingMinor: number;
  isActive: boolean;
  revision: number;
  createdBy: string;
  updatedBy: string;
  deviceId: string;
  createdAt: Date;
  updatedAt: Date;
}): CashAccountRecord {
  const accountType = row.accountType === 'BANK' || row.accountType === 'WALLET' ? row.accountType : 'CASH';
  return { ...row, accountType };
}

function toCashMovement(row: {
  id: string;
  storeId: string;
  accountId: string;
  direction: string;
  amountMinor: number;
  source: string;
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
  status: string;
  revision: number;
  createdAt: Date;
}): CashMovementRecord {
  return {
    ...row,
    direction: row.direction === 'OUT' ? 'OUT' : 'IN',
    source: cashSource(row.source),
    status: row.status === 'REVERSED' ? 'REVERSED' : 'ACTIVE',
  };
}

function cashSource(value: string): CashMovementRecord['source'] {
  if (
    value === 'INCOME' ||
    value === 'EXPENSE' ||
    value === 'TRANSFER' ||
    value === 'WITHDRAWAL' ||
    value === 'REFUND' ||
    value === 'SALE' ||
    value === 'PURCHASE'
  ) {
    return value;
  }
  return 'OPENING';
}

function toReconciliation(row: {
  id: string;
  storeId: string;
  accountId: string;
  cutoffAt: string;
  systemBalanceMinor: number;
  countedMinor: number;
  note: string;
  revision: number;
  createdBy: string;
  deviceId: string;
  createdAt: Date;
}): ReconciliationRecord {
  return row;
}

function toContact(row: {
  id: string;
  storeId: string;
  contactType: string;
  name: string;
  normalizedName: string;
  categoryId: string | null;
  categoryName: string | null;
  phone: string;
  email: string;
  address: string;
  creditLimitMinor?: number;
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
  settlements: Prisma.JsonValue;
  isActive: boolean;
  revision: number;
  createdBy: string;
  updatedBy: string;
  deviceId: string;
  createdAt: Date;
  updatedAt: Date;
}): ContactRecord {
  return {
    id: row.id,
    storeId: row.storeId,
    contactType: row.contactType === 'SUPPLIER' ? 'SUPPLIER' : 'CUSTOMER',
    name: row.name,
    normalizedName: row.normalizedName,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    phone: row.phone,
    email: row.email,
    address: row.address,
    creditLimitMinor: row.creditLimitMinor ?? 0,
    openingReceivableMinor: row.openingReceivableMinor,
    openingPayableMinor: row.openingPayableMinor,
    collectedMinor: row.collectedMinor,
    paidMinor: row.paidMinor,
    receivableMinor: row.receivableMinor,
    payableMinor: row.payableMinor,
    receivableAsOf: row.receivableAsOf,
    receivableNote: row.receivableNote,
    payableAsOf: row.payableAsOf,
    payableNote: row.payableNote,
    settlements: settlementsOf(row.settlements),
    isActive: row.isActive,
    revision: row.revision,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    deviceId: row.deviceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function contactData(contact: ContactRecord): Prisma.ContactCreateInput {
  return {
    id: contact.id,
    store: { connect: { id: contact.storeId } },
    contactType: contact.contactType,
    name: contact.name,
    normalizedName: contact.normalizedName,
    categoryId: contact.categoryId,
    categoryName: contact.categoryName,
    phone: contact.phone,
    email: contact.email,
    address: contact.address,
    creditLimitMinor: contact.creditLimitMinor,
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
    createdBy: contact.createdBy,
    updatedBy: contact.updatedBy,
    deviceId: contact.deviceId,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  };
}

function settlementsOf(value: Prisma.JsonValue): ContactRecord['settlements'] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: ContactRecord['settlements'] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const side = row.side === 'PAYABLE' ? 'PAYABLE' : row.side === 'RECEIVABLE' ? 'RECEIVABLE' : null;
    if (
      typeof row.id !== 'string' ||
      side === null ||
      typeof row.amountMinor !== 'number' ||
      typeof row.effectiveDate !== 'string' ||
      typeof row.accountName !== 'string' ||
      typeof row.paymentMethodName !== 'string'
    ) {
      continue;
    }
    rows.push({
      id: row.id,
      side,
      amountMinor: row.amountMinor,
      effectiveDate: row.effectiveDate,
      accountName: row.accountName,
      paymentMethodName: row.paymentMethodName,
      note: typeof row.note === 'string' ? row.note : '',
    });
  }
  return rows;
}

function isPublicContact(value: Prisma.JsonValue | null): value is PublicContact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return typeof value.id === 'string' && typeof value.revision === 'number' && typeof value.contactType === 'string';
}

function isPublicCategory(value: Prisma.JsonValue | null): value is PublicCategory {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return typeof value.id === 'string' && typeof value.revision === 'number';
}

function toUnit(row: {
  id: string;
  storeId: string;
  name: string;
  normalizedName: string;
  isActive: boolean;
  revision: number;
  createdBy: string;
  updatedBy: string;
  deviceId: string;
  createdAt: Date;
  updatedAt: Date;
}): UnitRecord {
  return row;
}

function unitData(unit: UnitRecord): Prisma.UnitCreateInput {
  return {
    id: unit.id,
    store: { connect: { id: unit.storeId } },
    name: unit.name,
    normalizedName: unit.normalizedName,
    isActive: unit.isActive,
    revision: unit.revision,
    createdBy: unit.createdBy,
    updatedBy: unit.updatedBy,
    deviceId: unit.deviceId,
    createdAt: unit.createdAt,
    updatedAt: unit.updatedAt,
  };
}

function toHeldSale(row: {
  id: string;
  storeId: string;
  name: string;
  contactName: string;
  wholesale: boolean;
  discountMode: string;
  discountValue: number;
  taxMode: string;
  taxValue: number;
  deliveryMinor: number;
  note: string;
  lines: Prisma.JsonValue;
  revision: number;
  removed: boolean;
}): PublicHeldSale {
  const lines = Array.isArray(row.lines)
    ? row.lines.flatMap((line) => {
        if (!line || typeof line !== 'object' || Array.isArray(line)) {
          return [];
        }
        const record = line as Record<string, unknown>;
        if (
          typeof record.itemId !== 'string' ||
          typeof record.qty !== 'number' ||
          typeof record.unitPriceMinor !== 'number'
        ) {
          return [];
        }
        return [{ itemId: record.itemId, qty: record.qty, unitPriceMinor: record.unitPriceMinor }];
      })
    : [];
  return {
    id: row.id,
    storeId: row.storeId,
    name: row.name,
    contactName: row.contactName,
    wholesale: row.wholesale,
    discountMode: row.discountMode === 'PERCENT' ? 'PERCENT' : 'AMOUNT',
    discountValue: row.discountValue,
    taxMode: row.taxMode === 'PERCENT' ? 'PERCENT' : 'AMOUNT',
    taxValue: row.taxValue,
    deliveryMinor: row.deliveryMinor,
    note: row.note,
    lines,
    revision: row.revision,
    removed: row.removed,
  };
}

function toPublicHeld(value: Prisma.JsonValue | null): PublicHeldSale | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.storeId !== 'string' || typeof row.name !== 'string') {
    return null;
  }
  return toHeldSale({
    id: row.id,
    storeId: row.storeId,
    name: row.name,
    contactName: typeof row.contactName === 'string' ? row.contactName : '',
    wholesale: row.wholesale === true,
    discountMode: typeof row.discountMode === 'string' ? row.discountMode : 'AMOUNT',
    discountValue: typeof row.discountValue === 'number' ? row.discountValue : 0,
    taxMode: typeof row.taxMode === 'string' ? row.taxMode : 'AMOUNT',
    taxValue: typeof row.taxValue === 'number' ? row.taxValue : 0,
    deliveryMinor: typeof row.deliveryMinor === 'number' ? row.deliveryMinor : 0,
    note: typeof row.note === 'string' ? row.note : '',
    lines: (row.lines ?? []) as Prisma.JsonValue,
    revision: typeof row.revision === 'number' ? row.revision : 1,
    removed: row.removed === true,
  });
}

function heldData(held: PublicHeldSale) {
  return {
    name: held.name,
    contactName: held.contactName,
    wholesale: held.wholesale,
    discountMode: held.discountMode,
    discountValue: held.discountValue,
    taxMode: held.taxMode,
    taxValue: held.taxValue,
    deliveryMinor: held.deliveryMinor,
    note: held.note,
    lines: held.lines as Prisma.InputJsonValue,
    revision: held.revision,
    removed: held.removed,
  };
}

function toItem(row: {
  id: string;
  storeId: string;
  itemType: string;
  name: string;
  normalizedName: string;
  sku: string;
  normalizedSku: string;
  unitId: string | null;
  unitName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  salePriceMinor: number;
  wholesalePriceMinor: number | null;
  purchaseCostMinor: number | null;
  stockQty: number | null;
  lowStockLevel: number | null;
  quickSaleRank: number | null;
  isActive: boolean;
  revision: number;
  createdBy: string;
  updatedBy: string;
  deviceId: string;
  createdAt: Date;
  updatedAt: Date;
}): ItemRecord {
  return {
    ...row,
    itemType: row.itemType === 'SERVICE' ? 'SERVICE' : 'PRODUCT',
    sku: row.sku.length === 0 ? null : row.sku,
  };
}

function itemData(item: ItemRecord): Prisma.ItemCreateInput {
  return {
    id: item.id,
    store: { connect: { id: item.storeId } },
    itemType: item.itemType,
    name: item.name,
    normalizedName: item.normalizedName,
    sku: item.sku ?? '',
    normalizedSku: item.normalizedSku,
    unitId: item.unitId,
    unitName: item.unitName,
    categoryId: item.categoryId,
    categoryName: item.categoryName,
    salePriceMinor: item.salePriceMinor,
    wholesalePriceMinor: item.wholesalePriceMinor,
    purchaseCostMinor: item.purchaseCostMinor,
    stockQty: item.stockQty,
    lowStockLevel: item.lowStockLevel,
    quickSaleRank: item.quickSaleRank,
    isActive: item.isActive,
    revision: item.revision,
    createdBy: item.createdBy,
    updatedBy: item.updatedBy,
    deviceId: item.deviceId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function toMovement(row: {
  id: string;
  storeId: string;
  itemId: string;
  movementType: string;
  quantityChange: number;
  onHandAfter: number;
  reference: string;
  occurredAt: string;
  actorName: string;
  status: string;
  revision: number;
  createdAt: Date;
}): MovementRecord {
  return {
    ...row,
    movementType:
      row.movementType === 'OPENING' ||
      row.movementType === 'SALE' ||
      row.movementType === 'RETURN' ||
      row.movementType === 'PURCHASE'
        ? row.movementType
        : 'ADJUSTMENT',
    status: row.status === 'REVERSED' ? 'REVERSED' : 'ACTIVE',
  };
}

async function upsertStockMovement(
  tx: Prisma.TransactionClient,
  movement: MovementRecord,
): Promise<void> {
  await tx.stockMovement.upsert({
    where: { id: movement.id },
    create: movementData(movement),
    update: {
      status: movement.status,
      revision: movement.revision,
    },
  });
}

function movementData(movement: MovementRecord): Prisma.StockMovementCreateInput {
  return {
    id: movement.id,
    store: { connect: { id: movement.storeId } },
    itemId: movement.itemId,
    movementType: movement.movementType,
    quantityChange: movement.quantityChange,
    onHandAfter: movement.onHandAfter,
    reference: movement.reference,
    occurredAt: movement.occurredAt,
    actorName: movement.actorName,
    status: movement.status,
    revision: movement.revision,
    createdAt: movement.createdAt,
  };
}

function toPurchase(row: {
  id: string;
  storeId: string;
  number: string;
  normalizedNumber: string;
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
  lines: Prisma.JsonValue;
  payments: Prisma.JsonValue;
  returns: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}): PurchaseRecord {
  return {
    ...row,
    lines: Array.isArray(row.lines) ? (row.lines as PurchaseRecord['lines']) : [],
    payments: Array.isArray(row.payments) ? (row.payments as PurchaseRecord['payments']) : [],
    returns: Array.isArray(row.returns) ? (row.returns as PurchaseRecord['returns']) : [],
  };
}

function toSale(row: {
  id: string;
  storeId: string;
  number: string;
  normalizedNumber: string;
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
  lines: Prisma.JsonValue;
  payments: Prisma.JsonValue;
  returns: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}): SaleRecord {
  return {
    ...row,
    lines: Array.isArray(row.lines) ? (row.lines as SaleRecord['lines']) : [],
    payments: Array.isArray(row.payments) ? (row.payments as SaleRecord['payments']) : [],
    returns: Array.isArray(row.returns) ? (row.returns as SaleRecord['returns']) : [],
  };
}

function toBatch(row: {
  id: string;
  storeId: string;
  itemId: string;
  receivedOn: string;
  source: string;
  sourceReference: string;
  unitCostMinor: number;
  receivedQty: number;
  remainingQty: number;
  revision: number;
  createdAt: Date;
}): BatchRecord {
  return {
    ...row,
    source:
      row.source === 'OPENING' || row.source === 'RETURN' || row.source === 'PURCHASE' ? row.source : 'ADJUSTMENT',
  };
}

function batchData(batch: BatchRecord): Prisma.CostBatchCreateManyInput {
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
    createdAt: batch.createdAt,
  };
}

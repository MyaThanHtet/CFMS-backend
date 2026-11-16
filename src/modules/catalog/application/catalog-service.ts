import { CatalogError } from '../domain/catalog-error.js';
import { cashFlow, itemReport, profitAndLoss, purchaseReport, saleReport, stockValue } from '../domain/report.js';
import { toReportSale } from '../domain/sale.js';
import { toReportPurchase } from '../domain/purchase.js';
import type { IncomingCommand, StoredCommand } from '../domain/category.js';
import type { CatalogRepository, CreateStoreInput, StoreSnapshot } from './ports.js';

export class CatalogService {
  constructor(private readonly catalog: CatalogRepository) {}

  async listOwnedStores(actorUserId: string) {
    return this.catalog.listOwnedStores(actorUserId);
  }

  async createStore(input: CreateStoreInput): Promise<StoreSnapshot> {
    const existing = await this.catalog.findStore(input.id);
    if (existing) {
      if (existing.ownerId !== input.actorUserId) {
        throw new CatalogError('store_taken', 'This shop already belongs to another account.', 409);
      }
      if (!(await this.catalog.isMember(input.id, input.actorUserId))) {
        throw new CatalogError('forbidden', 'You cannot open this shop.', 403);
      }
      return this.catalog.snapshot(input.id);
    }
    return this.catalog.createStore(input, new Date());
  }

  async report(actorUserId: string, storeId: string, from: string, to: string) {
    const snapshot = await this.snapshot(actorUserId, storeId);
    const sales = snapshot.sales.map(toReportSale);
    const purchases = snapshot.purchases.map(toReportPurchase);
    return {
      from,
      to,
      sales: saleReport(sales, from, to),
      purchases: purchaseReport(purchases, from, to),
      items: itemReport(sales, from, to),
      stock: stockValue(snapshot.items, snapshot.batches),
      profit: profitAndLoss(sales, snapshot.expenses, from, to, snapshot.cashMovements),
      cash: cashFlow(snapshot.cashMovements, from, to),
    };
  }

  async snapshot(actorUserId: string, storeId: string): Promise<StoreSnapshot> {
    await this.requireMember(actorUserId, storeId);
    return this.catalog.snapshot(storeId);
  }

  async changes(
    actorUserId: string,
    storeId: string,
    after: number,
    acknowledgement?: { deviceId: string; sequence: number },
  ): Promise<{ changes: Awaited<ReturnType<CatalogRepository['changes']>>['changes']; lastSequence: number }> {
    await this.requireMember(actorUserId, storeId);
    const page = await this.catalog.changes(storeId, after);
    if (acknowledgement) {
      if (acknowledgement.sequence > page.lastSequence) {
        throw new CatalogError('validation_error', 'The sync position is ahead of this shop.', 400);
      }
      await this.catalog.acknowledge(storeId, acknowledgement.deviceId, acknowledgement.sequence);
    }
    return page;
  }

  async submit(actorUserId: string, commands: IncomingCommand[]): Promise<StoredCommand[]> {
    const results: StoredCommand[] = [];
    for (const command of commands) {
      await this.requireMember(actorUserId, command.storeId);
      results.push(await this.catalog.submitCommand(actorUserId, command, new Date()));
    }
    return results;
  }

  private async requireMember(actorUserId: string, storeId: string): Promise<void> {
    const store = await this.catalog.findStore(storeId);
    if (!store) {
      throw new CatalogError('not_found', 'This shop was not found.', 404);
    }
    if (!(await this.catalog.isMember(storeId, actorUserId))) {
      throw new CatalogError('forbidden', 'You cannot change this shop.', 403);
    }
  }
}

export function commandResponse(command: StoredCommand): {
  commandId: string;
  status: StoredCommand['status'];
  code: string | null;
  message: string | null;
  changeSequence: number | null;
  category: StoredCommand['category'];
  contact: StoredCommand['contact'];
  unit: StoredCommand['unit'];
  item: StoredCommand['item'];
  movement: StoredCommand['movement'];
  batches: StoredCommand['batches'];
  expense: StoredCommand['expense'];
  account: StoredCommand['account'];
  cashMovements: StoredCommand['cashMovements'];
  reconciliation: StoredCommand['reconciliation'];
  sale: StoredCommand['sale'];
  purchase: StoredCommand['purchase'];
  store: StoredCommand['store'];
  paymentMethods: StoredCommand['paymentMethods'];
} {
  return {
    commandId: command.id,
    status: command.status,
    code: command.code,
    message: command.message,
    changeSequence: command.changeSequence,
    category: command.category,
    contact: command.contact ?? null,
    unit: command.unit ?? null,
    item: command.item ?? null,
    movement: command.movement ?? null,
    batches: command.batches ?? null,
    expense: command.expense ?? null,
    account: command.account ?? null,
    cashMovements: command.cashMovements ?? null,
    reconciliation: command.reconciliation ?? null,
    sale: command.sale ?? null,
    purchase: command.purchase ?? null,
    store: command.store ?? null,
    paymentMethods: command.paymentMethods ?? null,
  };
}

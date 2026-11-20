import type { IncomingCommand, PublicCategory, StoredCommand } from '../domain/category.js';
import type { PublicContact } from '../domain/contact.js';
import type { PublicCashAccount, PublicCashMovement, PublicReconciliation } from '../domain/cash.js';
import type { PublicExpense } from '../domain/expense.js';
import type { PublicBatch, PublicItem, PublicMovement, PublicUnit } from '../domain/item.js';
import type { PublicSale } from '../domain/sale.js';
import type { PublicPurchase } from '../domain/purchase.js';
import type { PublicPaymentMethod, PublicStore } from '../domain/shop-settings.js';

export type StoreRecord = PublicStore & {
  ownerId: string;
};

export type StoreSnapshot = {
  store: StoreRecord;
  categories: PublicCategory[];
  contacts: PublicContact[];
  units: PublicUnit[];
  items: PublicItem[];
  movements: PublicMovement[];
  batches: PublicBatch[];
  expenses: PublicExpense[];
  accounts: PublicCashAccount[];
  cashMovements: PublicCashMovement[];
  reconciliations: PublicReconciliation[];
  sales: PublicSale[];
  purchases: PublicPurchase[];
  paymentMethods: PublicPaymentMethod[];
  lastSequence: number;
};

export type CreateStoreInput = {
  seedDefaults?: boolean;
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  deviceId: string;
  actorUserId: string;
};

export type ChangeEntry = {
  sequence: number;
  storeId: string;
  aggregateType:
    'category' | 'contact' | 'unit' | 'item' | 'expense' | 'account' | 'sale' | 'purchase' | 'store' | 'paymentMethod';
  aggregateId: string;
  type: string;
  commandId: string;
  category?: PublicCategory | null;
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
  purchase?: PublicPurchase | null;
  store?: PublicStore | null;
  paymentMethods?: PublicPaymentMethod[] | null;
};

export type OwnedStore = {
  id: string;
  name: string;
};

export interface CatalogRepository {
  findStore(id: string): Promise<StoreRecord | null>;
  listOwnedStores(userId: string): Promise<OwnedStore[]>;
  isMember(storeId: string, userId: string): Promise<boolean>;
  createStore(input: CreateStoreInput, now: Date): Promise<StoreSnapshot>;
  submitCommand(actorUserId: string, command: IncomingCommand, now: Date): Promise<StoredCommand>;
  snapshot(storeId: string): Promise<StoreSnapshot>;
  changes(storeId: string, after: number): Promise<{ changes: ChangeEntry[]; lastSequence: number }>;
  acknowledge(storeId: string, deviceId: string, sequence: number): Promise<void>;
  listDevices(storeId: string): Promise<ShopDevice[]>;
  revokeDevice(storeId: string, deviceId: string, now: Date): Promise<void>;
  listCommands(storeId: string): Promise<ShopCommand[]>;
  listMembers(storeId: string): Promise<ShopMember[]>;
  inviteMember(storeId: string, actorUserId: string, input: InviteMemberInput): Promise<ShopMember>;
}

export type ShopMember = {
  userId: string;
  name: string;
  email: string;
  role: 'OWNER' | 'MANAGER' | 'CASHIER';
  status: 'ACTIVE';
};

export type InviteMemberInput = {
  email: string;
  role: 'MANAGER' | 'CASHIER';
  password: string;
};

export type ShopDevice = {
  deviceId: string;
  deviceName: string;
  memberName: string;
  lastSeenAt: string;
};

export type ShopCommand = {
  id: string;
  type: string;
  deviceId: string;
  deviceName: string;
  status: string;
  message: string | null;
  createdAt: string;
  label: string;
};

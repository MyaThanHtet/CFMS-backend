import type { PublicCashMovement } from './cash.js';
import type { PublicExpense } from './expense.js';
import type { PublicBatch, PublicItem } from './item.js';

export type ReportLine = {
  itemName: string;
  qty: number;
  amountMinor: number;
  costMinor: number;
  occurredAt: string;
  contactName: string;
  reference: string;
};

export type SaleDocument = {
  id: string;
  number: string;
  contactName: string;
  effectiveDate: string;
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
  costMinor: number;
  receivedMinor: number;
  dueMinor: number;
  status: string;
  lines: ReportLine[];
};

export type PurchaseDocument = {
  id: string;
  number: string;
  supplierName: string;
  effectiveDate: string;
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
  paidMinor: number;
  dueMinor: number;
  lineCount: number;
  status: string;
  lines: ReportLine[];
};

export type SaleReport = {
  count: number;
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
  receivedMinor: number;
  dueMinor: number;
  profitMinor: number;
  rows: SaleDocument[];
};

export type PurchaseReport = {
  count: number;
  grossMinor: number;
  discountMinor: number;
  netMinor: number;
  paidMinor: number;
  dueMinor: number;
  rows: PurchaseDocument[];
};

export type ItemReportRow = {
  itemName: string;
  qty: number;
  revenueMinor: number;
  costMinor: number;
  profitMinor: number;
};

export type ItemReport = {
  count: number;
  qty: number;
  revenueMinor: number;
  costMinor: number;
  profitMinor: number;
  rows: ItemReportRow[];
};

export function saleReport(sales: SaleDocument[], from: string, to: string, query = ''): SaleReport {
  const rows = sales.filter((sale) => sale.status === 'ACTIVE' && inRange(sale.effectiveDate, from, to) && matches(query, sale.number, sale.contactName));
  return {
    count: rows.length,
    grossMinor: sum(rows, (row) => row.grossMinor),
    discountMinor: sum(rows, (row) => row.discountMinor),
    netMinor: sum(rows, (row) => row.netMinor),
    receivedMinor: sum(rows, (row) => row.receivedMinor),
    dueMinor: sum(rows, (row) => row.dueMinor),
    profitMinor: sum(rows, (row) => row.netMinor - row.costMinor),
    rows,
  };
}

export function purchaseReport(purchases: PurchaseDocument[], from: string, to: string, query = ''): PurchaseReport {
  const rows = purchases.filter(
    (purchase) => purchase.status === 'ACTIVE' && inRange(purchase.effectiveDate, from, to) && matches(query, purchase.number, purchase.supplierName),
  );
  return {
    count: rows.length,
    grossMinor: sum(rows, (row) => row.grossMinor),
    discountMinor: sum(rows, (row) => row.discountMinor),
    netMinor: sum(rows, (row) => row.netMinor),
    paidMinor: sum(rows, (row) => row.paidMinor),
    dueMinor: sum(rows, (row) => row.dueMinor),
    rows,
  };
}

export function itemReport(sales: SaleDocument[], from: string, to: string, query = ''): ItemReport {
  const grouped = new Map<string, ItemReportRow>();
  for (const sale of sales) {
    if (sale.status !== 'ACTIVE') {
      continue;
    }
    for (const line of sale.lines) {
      const day = line.occurredAt.slice(0, 10);
      if (!inRange(day, from, to) || !matches(query, line.itemName)) {
        continue;
      }
      const current = grouped.get(line.itemName) ?? {
        itemName: line.itemName,
        qty: 0,
        revenueMinor: 0,
        costMinor: 0,
        profitMinor: 0,
      };
      current.qty += line.qty;
      current.revenueMinor += line.amountMinor;
      current.costMinor += line.costMinor;
      current.profitMinor += line.amountMinor - line.costMinor;
      grouped.set(line.itemName, current);
    }
  }
  const rows = [...grouped.values()].sort((left, right) => right.revenueMinor - left.revenueMinor);
  return {
    count: rows.length,
    qty: sum(rows, (row) => row.qty),
    revenueMinor: sum(rows, (row) => row.revenueMinor),
    costMinor: sum(rows, (row) => row.costMinor),
    profitMinor: sum(rows, (row) => row.profitMinor),
    rows,
  };
}

export function itemHistory(input: {
  sales: SaleDocument[];
  purchases: PurchaseDocument[];
  itemName: string;
  side: 'SALE' | 'PURCHASE';
  from: string;
  to: string;
}): { qty: number; amountMinor: number; costMinor: number; profitMinor: number; rows: ReportLine[] } {
  const rows = (input.side === 'SALE' ? input.sales.flatMap(activeLines) : input.purchases.flatMap(activePurchaseLines))
    .filter((line) => line.itemName === input.itemName && inRange(line.occurredAt.slice(0, 10), input.from, input.to))
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
  return {
    qty: sum(rows, (row) => row.qty),
    amountMinor: sum(rows, (row) => row.amountMinor),
    costMinor: sum(rows, (row) => row.costMinor),
    profitMinor: sum(rows, (row) => row.amountMinor - row.costMinor),
    rows,
  };
}

export function stockValue(items: PublicItem[], batches: PublicBatch[]): { batchCount: number; remainingQty: number; valueMinor: number } {
  const active = new Set(items.filter((item) => item.isActive).map((item) => item.id));
  const open = batches.filter((batch) => batch.remainingQty > 0 && active.has(batch.itemId));
  return {
    batchCount: open.length,
    remainingQty: sum(open, (batch) => batch.remainingQty),
    valueMinor: open.reduce((total, batch) => total + batch.remainingQty * batch.unitCostMinor, 0),
  };
}

export function profitAndLoss(
  sales: SaleDocument[],
  expenses: PublicExpense[],
  from: string,
  to: string,
  movements: PublicCashMovement[] = [],
): {
  salesNetMinor: number;
  costMinor: number;
  grossProfitMinor: number;
  otherIncomeMinor: number;
  expenseMinor: number;
  netProfitMinor: number;
  expensesByCategory: Array<{ name: string; amountMinor: number }>;
} {
  const reported = saleReport(sales, from, to);
  const paid = expenses.filter((expense) => expense.isActive && expense.status === 'PAID' && inRange(expense.effectiveDate, from, to));
  const grouped = new Map<string, number>();
  for (const expense of paid) {
    const name = expense.categoryName && expense.categoryName.length > 0 ? expense.categoryName : 'Expenses';
    grouped.set(name, (grouped.get(name) ?? 0) + expense.amountMinor);
  }
  const expenseMinor = sum(paid, (expense) => expense.amountMinor);
  const otherIncomeMinor = movements
    .filter(
      (movement) =>
        movement.status === 'ACTIVE' &&
        movement.direction === 'IN' &&
        movement.source === 'INCOME' &&
        movement.amountMinor > 0 &&
        !movement.description.startsWith('Sale ') &&
        inRange(movement.effectiveDate, from, to),
    )
    .reduce((total, movement) => total + movement.amountMinor, 0);
  return {
    salesNetMinor: reported.netMinor,
    costMinor: sum(reported.rows, (row) => row.costMinor),
    grossProfitMinor: reported.profitMinor,
    otherIncomeMinor,
    expenseMinor,
    netProfitMinor: reported.profitMinor + otherIncomeMinor - expenseMinor,
    expensesByCategory: [...grouped.entries()]
      .map(([name, amountMinor]) => ({ name, amountMinor }))
      .sort((left, right) => right.amountMinor - left.amountMinor || left.name.localeCompare(right.name)),
  };
}

export function cashFlow(movements: PublicCashMovement[], from: string, to: string): {
  inMinor: number;
  outMinor: number;
  netMinor: number;
} {
  let inMinor = 0;
  let outMinor = 0;
  for (const movement of movements) {
    if (movement.status !== 'ACTIVE' || !inRange(movement.effectiveDate, from, to)) {
      continue;
    }
    if (movement.direction === 'IN') {
      inMinor += movement.amountMinor;
    } else {
      outMinor += movement.amountMinor;
    }
  }
  return { inMinor, outMinor, netMinor: inMinor - outMinor };
}

export function reportRange(period: string, today: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return null;
  }
  if (period === 'today') {
    return { from: today, to: today };
  }
  const date = new Date(`${today}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  if (period === 'week') {
    const day = date.getUTCDay();
    const mondayOffset = day === 0 ? 6 : day - 1;
    const monday = new Date(date);
    monday.setUTCDate(date.getUTCDate() - mondayOffset);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
  }
  if (period === 'month') {
    const from = `${today.slice(0, 8)}01`;
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    return { from, to: end.toISOString().slice(0, 10) };
  }
  return null;
}

function activeLines(sale: SaleDocument): ReportLine[] {
  return sale.status === 'ACTIVE' ? sale.lines : [];
}

function activePurchaseLines(purchase: PurchaseDocument): ReportLine[] {
  return purchase.status === 'ACTIVE' ? purchase.lines : [];
}

function inRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

function matches(query: string, ...fields: string[]): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  return fields.some((field) => field.toLowerCase().includes(needle));
}

function sum<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

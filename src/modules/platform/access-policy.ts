export type SubscriptionState = {
  status: string;
  expiresAt: Date | null;
  graceUntil: Date | null;
  planCode: string;
  planName: string;
  entitlements: unknown;
  version: number;
  cancelAtPeriodEnd: boolean;
};
export function integerCap(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() !== '') return integerCap(Number(value));
  if (value && typeof value === 'object' && 'value' in value) return integerCap(value.value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function mergeEntitlements(plan: unknown, subscription: unknown) {
  const record = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const fromPlan = record(plan);
  const current = record(subscription);
  const merged: Record<string, unknown> = { ...current, ...fromPlan };
  for (const key of new Set([...Object.keys(fromPlan), ...Object.keys(current)])) {
    const left = integerCap(fromPlan[key]);
    const right = integerCap(current[key]);
    if (left !== null && right !== null && key.startsWith('max_')) merged[key] = Math.max(left, right);
  }
  return merged;
}
export const FREE_LIMITS = {
  max_shops: 1,
  max_categories: 3,
  max_items: 5,
  max_contacts: 5,
  max_units: 5,
  max_expenses: 5,
  max_cash_accounts: 5,
  max_sales: 5,
  max_purchases: 5,
  max_payment_methods: 5,
};
export function accessPolicy(subscription: SubscriptionState | null, now = new Date()) {
  const entitlements =
    subscription?.entitlements && typeof subscription.entitlements === 'object'
      ? (subscription.entitlements as Record<string, unknown>)
      : {};
  const until =
    subscription?.graceUntil && subscription.expiresAt && subscription.graceUntil > subscription.expiresAt
      ? subscription.graceUntil
      : subscription?.expiresAt;
  const paid =
    !!subscription && ['active', 'trial'].includes(subscription.status.toLowerCase()) && !!until && until > now;
  const limits: Record<string, number | null> = {};
  for (const [key, free] of Object.entries(FREE_LIMITS)) {
    limits[key] = paid ? integerCap(entitlements[key]) : free;
  }
  if (paid) {
    const branches = integerCap(entitlements.max_branches);
    const shops = integerCap(entitlements.max_shops);
    if (branches !== null) limits.max_branches = branches;
    const caps = [shops, branches].filter((value) => value !== null);
    limits.max_shops = caps.length === 0 ? null : Math.max(...caps);
  }
  return {
    tier: paid ? subscription.planName || subscription.planCode : 'Free',
    planCode: paid ? subscription.planCode : 'free',
    paid,
    canSync: paid && entitlements.cloud_sync !== false && entitlements.sync_enabled !== false,
    expiresAt: subscription?.expiresAt?.toISOString() ?? null,
    accessUntil: until?.toISOString() ?? null,
    cancelAtPeriodEnd: paid && subscription.cancelAtPeriodEnd,
    status: paid ? subscription.status.toLowerCase() : 'free',
    limits,
    version: subscription?.version ?? 0,
  };
}

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
function integerCap(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
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
    if (branches !== null) limits.max_branches = branches;
    if (limits.max_shops === null) limits.max_shops = branches;
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

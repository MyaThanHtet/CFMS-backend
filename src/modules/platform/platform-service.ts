import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from '../../config/env.js';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { CatalogError } from '../catalog/domain/catalog-error.js';
import { accessPolicy } from './access-policy.js';

type Projection = {
  tenantId: string;
  status: string;
  expiresAt: Date | null;
  graceUntil: Date | null;
  planCode: string;
  planName: string;
  entitlements: Prisma.InputJsonValue;
  version: number;
  cancelAtPeriodEnd: boolean;
};
export class PlatformService {
  private readonly jwks;
  constructor(
    private readonly db: PrismaClient,
    private readonly env: Env,
  ) {
    this.jwks = env.BYTECRAFT_ISSUER
      ? createRemoteJWKSet(new URL('/.well-known/jwks.json', env.BYTECRAFT_ISSUER))
      : null;
  }
  async profile(userId: string) {
    return this.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true },
    });
  }
  configuration() {
    return {
      configured: !!this.jwks && this.env.BYTECRAFT_CLIENT_IDS.length > 0,
      issuer: this.env.BYTECRAFT_ISSUER,
      appCode: this.env.BYTECRAFT_APP_CODE,
      androidClientId: this.env.BYTECRAFT_ANDROID_CLIENT_ID,
      iosClientId: this.env.BYTECRAFT_IOS_CLIENT_ID,
      redirectUri: this.env.BYTECRAFT_REDIRECT_URI,
    };
  }
  async access(userId: string, tx: Prisma.TransactionClient | PrismaClient = this.db) {
    const link = await tx.platformBinding.findUnique({ where: { userId } });
    const subscription = link
      ? await tx.platformSubscription.findUnique({
          where: { tenantId: link.tenantId },
        })
      : null;
    return { ...accessPolicy(subscription), linked: !!link };
  }
  async requireQuota(tx: Prisma.TransactionClient, userId: string, resource: string, storeId?: string) {
    const access = await this.requireCloud(userId, tx);
    const maximum = access.limits[`max_${resource}`];
    if (maximum === null || maximum === undefined) return;
    const where = { storeId };
    const count =
      resource === 'shops'
        ? await tx.store.count({ where: { ownerId: userId } })
        : resource === 'categories'
          ? await tx.category.count({ where })
          : resource === 'contacts'
            ? await tx.contact.count({ where })
            : resource === 'items'
              ? await tx.item.count({ where })
              : resource === 'units'
                ? await tx.unit.count({ where })
                : resource === 'expenses'
                  ? await tx.expense.count({ where })
                  : resource === 'cash_accounts'
                    ? await tx.cashAccount.count({ where })
                    : resource === 'sales'
                      ? await tx.saleDocument.count({ where })
                      : resource === 'purchases'
                        ? await tx.purchaseDocument.count({ where })
                        : resource === 'payment_methods'
                          ? await tx.paymentMethod.count({ where })
                          : 0;
    if (count >= maximum) throw new CatalogError('plan_limit_reached', `Your plan allows ${maximum} ${resource}.`, 402);
  }
  async requireCloud(userId: string, tx: Prisma.TransactionClient | PrismaClient = this.db) {
    const access = await this.access(userId, tx);
    if (!access.canSync)
      throw new CatalogError(
        'subscription_required',
        'Free is offline only. Choose a paid plan to enable cloud sync.',
        402,
      );
    return access;
  }
  async verifyCustomer(token: string): Promise<string> {
    const claims = await this.validate(token);
    const profile = await this.read('/api/v1/auth/me', token);
    if (profile.id !== claims.sub || profile.tenantId !== claims.tenant_id)
      throw new CatalogError('invalid_platform_token', 'Invalid ByteCraft identity.', 401);
    const mapped = await this.db.user.findUnique({
      where: { bytecraftSubject: claims.sub as string },
    });
    const id = mapped?.id ?? (claims.sub as string);
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id},780186))::text`;
      const existing = await tx.user.findUnique({ where: { id } });
      if (existing && existing.bytecraftSubject !== claims.sub)
        throw new CatalogError('legacy_account_conflict', 'Account migration is required. Contact support.', 409);
      if (!existing) {
        const email = String(profile.email).toLowerCase();
        if (await tx.user.findUnique({ where: { email } }))
          throw new CatalogError(
            'legacy_account_conflict',
            'An older CFMS account needs verified migration. Contact support.',
            409,
          );
        await tx.user.create({
          data: {
            id,
            email,
            name: String(profile.displayName ?? email),
            bytecraftSubject: id,
          },
        });
      }
    });
    return id;
  }
  private async validate(token: string) {
    if (!this.jwks || !this.env.BYTECRAFT_CLIENT_IDS.length)
      throw new CatalogError('platform_not_configured', 'ByteCraft integration is not configured.', 503);
    let claims;
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.env.BYTECRAFT_ISSUER,
        audience: this.env.BYTECRAFT_CLIENT_IDS,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'tenant_id', 'app_client_id', 'client_id', 'scope'],
      });
      claims = result.payload;
      if (
        result.protectedHeader.typ !== 'at+jwt' ||
        typeof claims.sub !== 'string' ||
        typeof claims.tenant_id !== 'string' ||
        typeof claims.app_client_id !== 'string' ||
        !this.env.BYTECRAFT_CLIENT_IDS.includes(claims.app_client_id) ||
        !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(claims.app_client_id) ||
        claims.client_id !== claims.app_client_id ||
        typeof claims.scope !== 'string' ||
        !claims.scope.split(' ').includes('platform')
      )
        throw new Error('Invalid token');
    } catch {
      throw new CatalogError('invalid_platform_token', 'Sign in to ByteCraft again.', 401);
    }
    return claims;
  }
  async reconcile(userId: string, token: string) {
    const claims = await this.validate(token);
    const customer = await this.db.user.findUnique({ where: { id: userId } });
    if (claims.sub !== customer?.bytecraftSubject)
      throw new CatalogError('invalid_platform_token', 'Wrong customer account.', 403);
    const profile = await this.read('/api/v1/auth/me', token);
    if (
      profile.id !== claims.sub ||
      profile.tenantId !== claims.tenant_id ||
      !['OWNER', 'ADMIN'].includes(String(profile.role))
    )
      throw new CatalogError('platform_owner_required', 'A ByteCraft tenant owner or administrator is required.', 403);
    const response = await this.read('/api/v1/subscriptions/me', token);
    const sub = response.subscription as Record<string, unknown> | null;
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;
      const prior = await tx.platformBinding.findUnique({ where: { userId } });
      if (prior && (prior.platformUserId !== claims.sub || prior.tenantId !== claims.tenant_id))
        throw new CatalogError(
          'platform_binding_conflict',
          'This CFMS account is linked to another ByteCraft business.',
          409,
        );
      const other = await tx.platformBinding.findUnique({
        where: { tenantId: claims.tenant_id as string },
      });
      if (other && other.userId !== userId)
        throw new CatalogError(
          'platform_binding_conflict',
          'This ByteCraft business is linked to another CFMS account.',
          409,
        );
      await tx.platformBinding.upsert({
        where: { userId },
        update: {},
        create: {
          userId,
          platformUserId: claims.sub as string,
          tenantId: claims.tenant_id as string,
          clientId: claims.app_client_id as string,
        },
      });
      const plan = sub?.plan as Record<string, unknown> | undefined;
      await this.project(tx, {
        tenantId: claims.tenant_id as string,
        status: sub ? String(sub.status) : 'none',
        expiresAt: sub ? new Date(String(sub.expiresAt)) : null,
        graceUntil: sub?.graceUntil ? new Date(String(sub.graceUntil)) : null,
        planCode: String(plan?.code ?? 'free'),
        planName: String(plan?.name ?? plan?.code ?? 'Free'),
        entitlements: (sub?.entitlements ?? {}) as Prisma.InputJsonObject,
        version: Number(sub?.version ?? 0),
        cancelAtPeriodEnd: sub?.cancelAtPeriodEnd === true,
      });
    });
    return this.access(userId);
  }
  private async read(path: string, token: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.env.BYTECRAFT_ISSUER), {
        redirect: 'error',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new CatalogError('platform_unavailable', 'ByteCraft is temporarily unavailable.', 503);
    }
    if (!response.ok)
      throw new CatalogError(
        'platform_access_denied',
        'ByteCraft authorization could not be verified.',
        response.status === 401 ? 401 : 502,
      );
    return (await response.json()) as Record<string, unknown>;
  }
  private async project(tx: Prisma.TransactionClient, state: Projection) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${state.tenantId},780184))::text`;
    const prior = await tx.platformSubscription.findUnique({
      where: { tenantId: state.tenantId },
    });
    if (prior && prior.version > state.version) return;
    // Same version may receive richer authoritative plan display metadata from reconciliation.
    await tx.platformSubscription.upsert({
      where: { tenantId: state.tenantId },
      create: state,
      update: state,
    });
  }
  async webhook(raw: Buffer, signature: string | undefined, eventId: string | undefined) {
    const secret = this.env.BYTECRAFT_WEBHOOK_SECRET;
    if (!secret) throw new CatalogError('platform_not_configured', 'Webhook receiver is not configured.', 503);
    const match = /^t=(\d{10,12}),v1=([a-f0-9]{64})$/.exec(signature ?? '');
    if (!match || Math.abs(Date.now() / 1000 - Number(match[1])) > 300)
      throw new CatalogError('invalid_signature', 'Invalid webhook signature.', 401);
    const expected = createHmac('sha256', secret).update(`${match[1]}.`).update(raw).digest();
    if (!timingSafeEqual(expected, Buffer.from(match[2]!, 'hex')))
      throw new CatalogError('invalid_signature', 'Invalid webhook signature.', 401);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new CatalogError('invalid_payload', 'Invalid webhook JSON.', 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new CatalogError('invalid_payload', 'Invalid webhook JSON object.', 400);
    const data = body.data as Record<string, unknown> | undefined;
    if (
      !body ||
      typeof body.event_id !== 'string' ||
      body.event_id !== eventId ||
      !data ||
      data.app_client_id !== this.env.BYTECRAFT_WEBHOOK_CLIENT_ID
    )
      throw new CatalogError('invalid_destination', 'Invalid webhook destination.', 403);
    if (body.event === 'connection.test') return;
    if (body.event !== 'subscription.updated') return;
    if (
      typeof data.tenant_id !== 'string' ||
      !Number.isSafeInteger(data.version) ||
      Number(data.version) < 1 ||
      !['active', 'trial', 'expired', 'cancelled', 'suspended'].includes(String(data.status)) ||
      (data.grace_until != null && !Number.isFinite(Date.parse(String(data.grace_until)))) ||
      !Number.isFinite(Date.parse(String(data.expires_at))) ||
      !data.entitlements ||
      typeof data.entitlements !== 'object' ||
      Array.isArray(data.entitlements)
    )
      throw new CatalogError('invalid_payload', 'Invalid subscription payload.', 400);
    await this.db.$transaction(async (tx) => {
      // Serialize event IDs as well as subscription versions so parallel delivery retries are safe.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${body.event_id as string},780185))::text`;
      if (
        await tx.platformWebhookEvent.findUnique({
          where: { eventId: body.event_id as string },
        })
      )
        return;
      const prior = await tx.platformSubscription.findUnique({
        where: { tenantId: data.tenant_id as string },
      });
      await this.project(tx, {
        tenantId: data.tenant_id as string,
        status: String(data.status),
        expiresAt: new Date(String(data.expires_at)),
        graceUntil: data.grace_until ? new Date(String(data.grace_until)) : null,
        planCode: String(data.plan_tier),
        planName: prior && prior.planCode === data.plan_tier ? prior.planName : String(data.plan_tier),
        entitlements: data.entitlements as Prisma.InputJsonObject,
        version: Number(data.version),
        cancelAtPeriodEnd: data.cancel_at_period_end === true,
      });
      await tx.platformWebhookEvent.create({
        data: { eventId: body.event_id as string },
      });
    });
  }
}

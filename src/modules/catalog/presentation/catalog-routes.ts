import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AuthError } from '../../auth/domain/auth-error.js';
import type { AccessTokenVerifier } from '../../auth/infrastructure/jwt-access-token-verifier.js';
import { commandResponse, type CatalogService } from '../application/catalog-service.js';
import { CatalogError } from '../domain/catalog-error.js';

const idSchema = z.uuid();

const createStoreSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(240).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().pipe(z.email())]).optional(),
  deviceId: z.string().trim().min(1).max(128),
});

const commandSchema = z.object({
  id: idSchema,
  storeId: idSchema,
  deviceId: z.string().trim().min(1).max(128),
  type: z.enum([
    'category.create',
    'category.rename',
    'category.update_description',
    'category.set_active',
    'contact.create',
    'contact.update',
    'contact.deactivate',
    'contact.set_opening_balance',
    'contact.settle',
    'unit.create',
    'item.create',
    'item.update',
    'item.deactivate',
    'item.adjust_stock',
    'expense.create',
    'expense.update',
    'expense.void',
    'expense.deactivate',
    'account.create',
    'cash.in',
    'cash.out',
    'cash.transfer',
    'cash.reconcile',
    'sale.create',
    'sale.collect',
    'sale.return',
    'sale.deactivate',
    'purchase.create',
    'purchase.pay',
    'purchase.return',
    'purchase.deactivate',
    'store.profile',
    'store.tax',
    'paymentMethod.create',
    'paymentMethod.update',
  ]),
  payload: z.record(z.string(), z.unknown()),
});

const batchSchema = z.object({
  commands: z.array(commandSchema).min(1).max(50),
});

const changesQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  deviceId: z.string().trim().min(1).max(128).optional(),
  ack: z.coerce.number().int().min(0).optional(),
});

export function registerCatalogRoutes(
  app: FastifyInstance,
  catalog: CatalogService,
  tokens: AccessTokenVerifier,
): void {
  app.get('/v1/stores', async (request, reply) => {
    const actorUserId = await actor(tokens, request.headers.authorization, reply);
    if (!actorUserId) {
      return;
    }
    const stores = await catalog.listOwnedStores(actorUserId);
    return reply.send({ stores });
  });

  app.post('/v1/stores', async (request, reply) => {
    const actorUserId = await actor(tokens, request.headers.authorization, reply);
    if (!actorUserId) {
      return;
    }
    const parsed = createStoreSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(errorBody('validation_error', 'Check the shop name.'));
    }
    const email = parsed.data.email && parsed.data.email.length > 0 ? parsed.data.email : null;
    return send(reply, () =>
      catalog.createStore({
        id: parsed.data.id,
        name: parsed.data.name,
        address: emptyToNull(parsed.data.address),
        phone: emptyToNull(parsed.data.phone),
        email,
        deviceId: parsed.data.deviceId,
        actorUserId,
      }),
    );
  });

  app.get('/v1/stores/:storeId/snapshot', async (request, reply) => {
    const actorUserId = await actor(tokens, request.headers.authorization, reply);
    if (!actorUserId) {
      return;
    }
    const params = z.object({ storeId: idSchema }).safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(errorBody('validation_error', 'This shop was not found.'));
    }
    return send(reply, () => catalog.snapshot(actorUserId, params.data.storeId));
  });

  app.get('/v1/stores/:storeId/reports', async (request, reply) => {
    const actorUserId = await actor(tokens, request.headers.authorization, reply);
    if (!actorUserId) {
      return;
    }
    const params = z.object({ storeId: idSchema }).safeParse(request.params);
    const query = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .safeParse(request.query);
    if (!params.success || !query.success || query.data.from > query.data.to) {
      return reply.code(400).send(errorBody('validation_error', 'Check the report dates.'));
    }
    return send(reply, () => catalog.report(actorUserId, params.data.storeId, query.data.from, query.data.to));
  });

  app.get('/v1/stores/:storeId/changes', async (request, reply) => {
    const actorUserId = await actor(tokens, request.headers.authorization, reply);
    if (!actorUserId) {
      return;
    }
    const params = z.object({ storeId: idSchema }).safeParse(request.params);
    const query = changesQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send(errorBody('validation_error', 'Check the sync request.'));
    }
    const acknowledgement =
      query.data.deviceId && query.data.ack !== undefined
        ? { deviceId: query.data.deviceId, sequence: query.data.ack }
        : undefined;
    return send(reply, () =>
      catalog.changes(actorUserId, params.data.storeId, query.data.after, acknowledgement),
    );
  });

  app.post('/v1/commands', async (request, reply) => {
    const actorUserId = await actor(tokens, request.headers.authorization, reply);
    if (!actorUserId) {
      return;
    }
    const parsed = batchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(errorBody('validation_error', 'Check the category changes.'));
    }
    return send(reply, async () => {
      const results = await catalog.submit(actorUserId, parsed.data.commands);
      return { results: results.map(commandResponse) };
    });
  });
}

async function actor(
  tokens: AccessTokenVerifier,
  header: string | undefined,
  reply: FastifyReply,
): Promise<string | undefined> {
  if (!header?.startsWith('Bearer ')) {
    await reply.code(401).send(errorBody('unauthenticated', 'Sign in again.'));
    return undefined;
  }
  try {
    return await tokens.verify(header.slice('Bearer '.length));
  } catch (error) {
    await sendFailure(reply, error);
    return undefined;
  }
}

async function send(reply: FastifyReply, action: () => Promise<unknown>): Promise<unknown> {
  try {
    return reply.send(await action());
  } catch (error) {
    return sendFailure(reply, error);
  }
}

async function sendFailure(reply: FastifyReply, error: unknown): Promise<unknown> {
  if (error instanceof CatalogError || error instanceof AuthError) {
    return reply.code(error.statusCode).send(errorBody(error.code, error.message));
  }
  throw error;
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function emptyToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

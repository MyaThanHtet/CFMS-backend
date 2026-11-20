import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AccessTokenVerifier } from '../auth/infrastructure/jwt-access-token-verifier.js';
import { AuthError } from '../auth/domain/auth-error.js';
import { CatalogError } from '../catalog/domain/catalog-error.js';
import type { PlatformService } from './platform-service.js';
export function registerPlatformRoutes(app: FastifyInstance, platform: PlatformService, tokens: AccessTokenVerifier) {
  app.get('/v1/platform/config', async () => platform.configuration());
  async function user(header: string | undefined) {
    if (!header?.startsWith('Bearer ')) throw new AuthError('unauthenticated', 'Sign in again.', 401);
    return tokens.verify(header.slice(7));
  }
  app.get('/v1/auth/bytecraft/me', async (request, reply) => {
    try {
      return await platform.profile(await user(request.headers.authorization));
    } catch (error) {
      return failure(error, reply);
    }
  });
  app.get('/v1/platform/access', async (request, reply) => {
    try {
      const id = await user(request.headers.authorization);
      return await platform.reconcile(id, request.headers.authorization!.slice(7));
    } catch (error) {
      return failure(error, reply);
    }
  });
  app.post('/v1/platform/reconcile', async (request, reply) => {
    try {
      const id = await user(request.headers.authorization);
      const body = z
        .object({ accessToken: z.string().min(1).max(16384) })
        .strict()
        .parse(request.body);
      return await platform.reconcile(id, body.accessToken);
    } catch (error) {
      return failure(error, reply);
    }
  });
  app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 262144 }, (_req, body, done) =>
      done(null, body),
    );
    scope.post('/v1/platform/webhook', async (request, reply) => {
      try {
        await platform.webhook(
          request.body as Buffer,
          request.headers['x-bytecraft-signature'] as string | undefined,
          request.headers['x-bytecraft-event-id'] as string | undefined,
        );
        return reply.code(204).send();
      } catch (error) {
        return failure(error, reply);
      }
    });
  });
}
function failure(error: unknown, reply: FastifyReply) {
  if (error instanceof AuthError || error instanceof CatalogError)
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  if (error instanceof z.ZodError)
    return reply.code(400).send({
      error: {
        code: 'validation_error',
        message: 'Check the request fields.',
      },
    });
  throw error;
}

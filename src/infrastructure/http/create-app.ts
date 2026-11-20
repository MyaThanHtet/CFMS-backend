import { registerPlatformRoutes } from '../../modules/platform/platform-routes.js';
import { CatalogError } from '../../modules/catalog/domain/catalog-error.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthRoutes } from '../../modules/auth/presentation/auth-routes.js';
import { registerCatalogRoutes } from '../../modules/catalog/presentation/catalog-routes.js';
import { registerHealthRoutes } from '../../modules/health/presentation/health-routes.js';
import type { AppContainer } from '../composition/container.js';
import { errorHandler } from './error-handler.js';

type CreateAppOptions = {
  logger?: boolean;
};

export function createApp(container: AppContainer, options: CreateAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  app.setErrorHandler(errorHandler);
  registerHealthRoutes(app, container.checkHealth);
  if (container.authenticator) {
    registerAuthRoutes(app, container.authenticator);
  }
  if (container.catalog && container.accessTokens) {
    registerCatalogRoutes(app, container.catalog, {
      verify: async (token) => {
        const id = await container.accessTokens!.verify(token);
        if (!container.cloudAccess)
          throw new CatalogError('subscription_required', 'Free is offline only. Upgrade to sync.', 402);
        // Reconcile using the caller's central token, so skipping the mobile access
        // endpoint cannot preserve stale cloud permissions when a webhook is delayed.
        if (container.platform) await container.platform.reconcile(id, token);
        await container.cloudAccess.requireCloud(id);
        return id;
      },
    });
  }
  if (container.platform && container.accessTokens)
    registerPlatformRoutes(app, container.platform, container.accessTokens);
  app.addHook('onClose', async () => {
    await container.disconnect();
  });
  return app;
}

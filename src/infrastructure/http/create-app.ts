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
    registerCatalogRoutes(app, container.catalog, container.accessTokens);
  }
  app.addHook('onClose', async () => {
    await container.disconnect();
  });
  return app;
}

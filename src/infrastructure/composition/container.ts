import { PlatformService } from '../../modules/platform/platform-service.js';
import type { Env } from '../../config/env.js';
import type { Authenticator } from '../../modules/auth/application/authenticator.js';
import { type AccessTokenVerifier } from '../../modules/auth/infrastructure/jwt-access-token-verifier.js';
import { CatalogService } from '../../modules/catalog/application/catalog-service.js';
import { PrismaCatalogRepository } from '../../modules/catalog/infrastructure/prisma-catalog-repository.js';
import { CheckHealth } from '../../modules/health/application/check-health.js';
import { PrismaDatabaseProbe } from '../../modules/health/infrastructure/prisma-database-probe.js';
import { createPrismaClient } from '../db/prisma-client.js';

export type AppContainer = {
  checkHealth: CheckHealth;
  authenticator?: Authenticator;
  catalog?: CatalogService;
  accessTokens?: AccessTokenVerifier;
  platform?: PlatformService;
  cloudAccess?: { requireCloud(userId: string): Promise<unknown> };
  disconnect(): Promise<void>;
};

export function createContainer(env: Env): AppContainer {
  const prisma = createPrismaClient(env.DATABASE_URL);
  const platform = new PlatformService(prisma, env);
  return {
    platform,
    cloudAccess: platform,
    checkHealth: new CheckHealth(new PrismaDatabaseProbe(prisma)),
    catalog: new CatalogService(new PrismaCatalogRepository(prisma, platform)),
    accessTokens: { verify: (token) => platform.verifyCustomer(token) },
    disconnect: () => prisma.$disconnect(),
  };
}

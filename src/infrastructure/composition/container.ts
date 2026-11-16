import type { Env } from '../../config/env.js';
import { Authenticator } from '../../modules/auth/application/authenticator.js';
import { Argon2PasswordHasher } from '../../modules/auth/infrastructure/argon2-password-hasher.js';
import { GoogleIdTokenVerifier } from '../../modules/auth/infrastructure/google-id-token-verifier.js';
import { JwtAccessTokenIssuer } from '../../modules/auth/infrastructure/jwt-access-token-issuer.js';
import {
  JwtAccessTokenVerifier,
  type AccessTokenVerifier,
} from '../../modules/auth/infrastructure/jwt-access-token-verifier.js';
import { PrismaSessionRepository } from '../../modules/auth/infrastructure/prisma-session-repository.js';
import { PrismaUserRepository } from '../../modules/auth/infrastructure/prisma-user-repository.js';
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
  disconnect(): Promise<void>;
};

export function createContainer(env: Env): AppContainer {
  const prisma = createPrismaClient(env.DATABASE_URL);
  return {
    checkHealth: new CheckHealth(new PrismaDatabaseProbe(prisma)),
    authenticator: new Authenticator({
      users: new PrismaUserRepository(prisma),
      sessions: new PrismaSessionRepository(prisma),
      passwords: new Argon2PasswordHasher(),
      tokens: new JwtAccessTokenIssuer(env.JWT_ACCESS_SECRET),
      google: new GoogleIdTokenVerifier(env.GOOGLE_CLIENT_IDS),
    }),
    catalog: new CatalogService(new PrismaCatalogRepository(prisma)),
    accessTokens: new JwtAccessTokenVerifier(env.JWT_ACCESS_SECRET),
    disconnect: () => prisma.$disconnect(),
  };
}

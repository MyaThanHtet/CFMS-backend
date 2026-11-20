import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { pathToFileURL, URL, URLSearchParams } from 'node:url';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID, createHmac, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';
import { Pool } from 'pg';
import { importJWK, SignJWT } from 'jose';
import { createApp } from '../../src/infrastructure/http/create-app.ts';
import { createContainer } from '../../src/infrastructure/composition/container.ts';
import { loadEnv } from '../../src/config/env.ts';
import { createPrismaClient } from '../../src/infrastructure/db/prisma-client.ts';
const root = process.cwd(),
  platform = resolve(root, '../../ByteCraft-Platform/bytecraft-platform-backend');
const containerName = `cfms-platform-integration-${process.pid}`;
let platformApp,
  cfmsApp,
  platformDb,
  cfmsDb,
  token,
  subscription,
  tenantId,
  storeId,
  planId,
  receiverUrl,
  events,
  worker;
const secret = randomBytes(32).toString('base64url'),
  clientId = 'bc_cfms_integration_native';
const freePort = () =>
  new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
const auth = () => ({ authorization: `Bearer ${token}` });
const request = async (path, method = 'GET', body) => {
  const response = await globalThis.fetch(`${receiverUrl}${path}`, {
    method,
    headers: {
      ...auth(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
};
describe(
  'real ByteCraft authentication, CFMS paid sync and period-end cancellation',
  { timeout: 120000, concurrency: false },
  () => {
    before(async () => {
      const password = randomBytes(20).toString('hex');
      execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '-d',
          '--name',
          containerName,
          '--tmpfs',
          '/var/lib/postgresql',
          '-e',
          'POSTGRES_USER=cfms',
          '-e',
          `POSTGRES_PASSWORD=${password}`,
          '-e',
          'POSTGRES_DB=platform_test',
          '-p',
          '127.0.0.1::5432',
          'postgres:18-alpine',
        ],
        { stdio: 'pipe' },
      );
      for (let i = 0; i < 80; i++) {
        try {
          execFileSync('docker', ['exec', containerName, 'pg_isready', '-U', 'cfms', '-d', 'platform_test'], {
            stdio: 'pipe',
          });
          break;
        } catch {
          await delay(200);
        }
      }
      const port = execFileSync('docker', ['port', containerName, '5432/tcp'], {
        encoding: 'utf8',
      })
        .trim()
        .split(':')
        .at(-1);
      const platformUrl = `postgresql://cfms:${password}@127.0.0.1:${port}/platform_test`,
        cfmsUrl = `postgresql://cfms:${password}@127.0.0.1:${port}/cfms_test`;
      const pool = new Pool({ connectionString: platformUrl });
      // Wait for the final TCP listener, not the temporary initdb socket server.
      for (let attempt = 0; ; attempt++) {
        try {
          await pool.query('SELECT 1');
          break;
        } catch (error) {
          if (attempt >= 79) throw error;
          await delay(250);
        }
      }
      await pool.query('CREATE DATABASE cfms_test');
      await pool.end();
      for (const [cwd, url] of [
        [platform, platformUrl],
        [root, cfmsUrl],
      ])
        execFileSync(process.execPath, [join(cwd, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'], {
          cwd,
          env: { ...process.env, DATABASE_URL: url },
          stdio: 'pipe',
        });
      const apiPort = await freePort(),
        issuer = `http://127.0.0.1:${apiPort}`;
      Object.assign(process.env, {
        DATABASE_URL: platformUrl,
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
        SWAGGER_ENABLED: 'false',
        OIDC_ISSUER: issuer,
        ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        PLATFORM_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
        ADMIN_ORIGINS: 'http://localhost:5173',
        CORS_ORIGINS: 'http://localhost:5173',
        WEBHOOK_WORKER_ENABLED: 'false',
        WEBHOOK_ALLOW_PRIVATE: 'true',
        EMAIL_WORKER_ENABLED: 'false',
        SMTP_HOST: '',
        QR_STORAGE_DRIVER: 'database',
      });
      const { createApplication } = await import(pathToFileURL(join(platform, 'dist/app.js')));
      platformApp = await createApplication();
      await platformApp.listen(apiPort, '127.0.0.1');
      const { PrismaService } = await import(
        pathToFileURL(join(platform, 'dist/infrastructure/database/prisma.service.js'))
      );
      platformDb = platformApp.get(PrismaService);
      const user = await platformDb.user.create({
        data: {
          email: 'owner@cfms-integration.example.test',
          displayName: 'CFMS Owner',
          passwordHash: 'integration-password-hash',
        },
      });
      const tenant = await platformDb.tenant.create({
        data: {
          name: 'CFMS Business',
          slug: `test-${randomUUID()}`,
          memberships: { create: { userId: user.id, role: 'OWNER' } },
        },
      });
      tenantId = tenant.id;
      const app = await platformDb.application.create({
        data: { code: 'cfms', name: 'CFMS' },
      });
      const client = await platformDb.oAuthClient.create({
        data: {
          applicationId: app.id,
          clientId,
          isPublic: true,
          applicationType: 'native',
          redirectUris: ['com.cfms.mobile:/oauth2redirect'],
          allowedScopes: ['openid', 'profile', 'email', 'offline_access', 'platform'],
        },
      });
      const grantId = randomUUID();
      await platformDb.oidcGrantBinding.create({
        data: {
          grantId,
          userId: user.id,
          tenantId,
          oauthClientId: client.id,
          authVersion: 1,
        },
      });
      const { SigningKeysService } = await import(
        pathToFileURL(join(platform, 'dist/infrastructure/security/signing-keys.service.js'))
      );
      const keys = await platformApp.get(SigningKeysService).keys();
      token = await new SignJWT({
        tenant_id: tenantId,
        tenant_role: 'owner',
        app_client_id: clientId,
        client_id: clientId,
        session_version: 1,
        grant_id: grantId,
        scope: 'platform',
      })
        .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: keys.kid })
        .setSubject(user.id)
        .setIssuer(issuer)
        .setAudience([clientId, `${issuer}/api`])
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(await importJWK(keys.privateKeys[0], 'RS256'));
      const env = loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: cfmsUrl,
        JWT_ACCESS_SECRET: 'test-secret-with-at-least-32-characters',
        BYTECRAFT_ISSUER: issuer,
        BYTECRAFT_APP_CODE: 'cfms',
        BYTECRAFT_CLIENT_IDS: clientId,
        BYTECRAFT_ANDROID_CLIENT_ID: clientId,
        BYTECRAFT_IOS_CLIENT_ID: clientId,
        BYTECRAFT_WEBHOOK_CLIENT_ID: clientId,
        BYTECRAFT_WEBHOOK_SECRET: secret,
      });
      cfmsApp = createApp(createContainer(env), { logger: false });
      receiverUrl = await cfmsApp.listen({ host: '127.0.0.1', port: 0 });
      cfmsDb = createPrismaClient(cfmsUrl);
      const { SecretsService } = await import(
        pathToFileURL(join(platform, 'dist/infrastructure/security/secrets.service.js'))
      );
      const endpointId = randomUUID();
      await platformDb.webhookEndpoint.create({
        data: {
          id: endpointId,
          applicationId: app.id,
          oauthClientId: client.id,
          url: `${receiverUrl}/v1/platform/webhook`,
          encryptedSecret: platformApp.get(SecretsService).encrypt(secret, 'webhook', endpointId),
        },
      });
      const plan = await platformDb.plan.create({
        data: {
          applicationId: app.id,
          code: 'pro',
          name: 'CFMS Pro',
          amountMinor: 3000000,
          currency: 'MMK',
          durationDays: 30,
          entitlements: {
            cloud_sync: true,
            max_shops: 1,
            max_categories: 3,
            max_items: 10,
            max_contacts: 10,
          },
        },
      });
      planId = plan.id;
      const { WebhookEventsService } = await import(
        pathToFileURL(join(platform, 'dist/modules/webhooks/webhook-events.service.js'))
      );
      const { WebhookWorkerService } = await import(
        pathToFileURL(join(platform, 'dist/modules/webhooks/webhook-worker.service.js'))
      );
      events = platformApp.get(WebhookEventsService);
      worker = platformApp.get(WebhookWorkerService);
      storeId = randomUUID();
    });
    after(async () => {
      if (cfmsApp) await cfmsApp.close();
      if (cfmsDb) await cfmsDb.$disconnect();
      if (platformApp) await platformApp.close();
      try {
        execFileSync('docker', ['rm', '-f', containerName], { stdio: 'pipe' });
      } catch {
        /* Already removed. */
      }
    });
    it('opens hosted ByteCraft registration for the native PKCE client', async () => {
      const issuer = await platformApp.getUrl();
      const discovery = await (await globalThis.fetch(`${issuer}/.well-known/openid-configuration`)).json();
      const url = new URL(discovery.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: 'com.cfms.mobile:/oauth2redirect',
        scope: 'openid profile email offline_access platform',
        prompt: 'login consent',
        state: randomBytes(24).toString('base64url'),
        nonce: randomBytes(24).toString('base64url'),
        code_challenge: createHash('sha256').update(randomBytes(32)).digest('base64url'),
        code_challenge_method: 'S256',
        screen_hint: 'signup',
      }).toString();
      const authorization = await globalThis.fetch(url, { redirect: 'manual' });
      assert.equal(authorization.status, 303);
      const destination = new URL(authorization.headers.get('location'), issuer);
      assert.equal(destination.origin, issuer);
      assert.ok(destination.pathname.startsWith('/interaction/'));
      const cookie = authorization.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const page = await globalThis.fetch(destination, { headers: { cookie }, redirect: 'manual' });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<details open><summary>Create a ByteCraft account/);
    });
    it('accepts real Platform identity, has no local password login, and denies Free business APIs', async () => {
      assert.equal((await request('/v1/auth/bytecraft/me')).status, 200);
      const free = await request('/v1/platform/access');
      assert.equal(free.status, 200);
      assert.equal(free.body.tier, 'Free');
      assert.equal(free.body.canSync, false);
      assert.equal((await request('/v1/stores')).status, 402);
      assert.equal(await cfmsDb.store.count(), 0);
      assert.equal(
        (
          await request('/v1/auth/sign-in', 'POST', {
            email: 'x',
            password: 'x',
          })
        ).status,
        404,
      );
    });
    it('receives a real signed paid webhook and uploads a local shop without seeded replacement data', async () => {
      const plan = await platformDb.plan.findUniqueOrThrow({
        where: { id: planId },
      });
      subscription = await platformDb.subscription.create({
        data: {
          tenantId,
          applicationId: plan.applicationId,
          planId,
          status: 'ACTIVE',
          startsAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
          entitlements: plan.entitlements,
        },
      });
      await platformDb.$transaction((tx) => events.create(tx, subscription));
      await worker.tick();
      const access = await request('/v1/platform/access');
      assert.equal(access.body.canSync, true);
      assert.equal(access.body.tier, 'CFMS Pro');
      const uploaded = await request('/v1/stores', 'POST', {
        id: storeId,
        name: 'Preserved local shop',
        deviceId: 'test-device',
        offlineBootstrap: true,
      });
      assert.equal(uploaded.status, 200);
      assert.equal(uploaded.body.categories.length, 0);
      assert.equal(uploaded.body.accounts.length, 0);
      assert.equal(uploaded.body.lastSequence, 0);
    });
    it('enforces paid resource limits against direct API calls', async () => {
      for (let i = 0; i < 3; i++) {
        const response = await request('/v1/commands', 'POST', {
          commands: [
            {
              id: randomUUID(),
              storeId,
              deviceId: 'test-device',
              type: 'category.create',
              payload: {
                id: randomUUID(),
                kind: 'ITEM',
                name: `Category ${i}`,
                description: '',
              },
            },
          ],
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.results[0].status, 'accepted');
      }
      const fourth = await request('/v1/commands', 'POST', {
        commands: [
          {
            id: randomUUID(),
            storeId,
            deviceId: 'test-device',
            type: 'category.create',
            payload: {
              id: randomUUID(),
              kind: 'ITEM',
              name: 'Fourth',
              description: '',
            },
          },
        ],
      });
      assert.equal(fourth.status, 402);
      assert.equal(await cfmsDb.category.count(), 3);
    });
    it('denies revoked cloud permission even when no webhook has arrived', async () => {
      await platformDb.subscription.update({
        where: { id: subscription.id },
        data: { entitlements: { ...subscription.entitlements, cloud_sync: false }, version: { increment: 1 } },
      });
      // A caller cannot keep syncing by avoiding /v1/platform/access.
      assert.equal((await request('/v1/stores')).status, 402);
      await platformDb.subscription.update({
        where: { id: subscription.id },
        data: { entitlements: subscription.entitlements, version: { increment: 1 } },
      });
      assert.equal((await request('/v1/stores')).status, 200);
    });
    it('schedules cancellation once, retaining expiry, entitlements and sync access', async () => {
      const issuer = process.env.OIDC_ISSUER;
      const cancel = () =>
        globalThis.fetch(`${issuer}/api/v1/subscriptions/me/cancel`, {
          method: 'POST',
          headers: { ...auth(), 'Content-Type': 'application/json' },
          body: '{}',
        });
      const first = await cancel();
      assert.equal(first.status, 200);
      const body = await first.json();
      assert.equal(body.subscription.cancelAtPeriodEnd, true);
      assert.equal(new Date(body.subscription.expiresAt).getTime(), subscription.expiresAt.getTime());
      const second = await cancel();
      assert.equal((await second.json()).subscription.version, body.subscription.version);
      const resumed = await globalThis.fetch(`${issuer}/api/v1/subscriptions/me/resume`, {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(resumed.status, 200);
      const resumedBody = await resumed.json();
      assert.equal(resumedBody.subscription.cancelAtPeriodEnd, false);
      assert.equal(resumedBody.subscription.version, body.subscription.version + 1);
      assert.equal(new Date(resumedBody.subscription.expiresAt).getTime(), subscription.expiresAt.getTime());
      assert.equal((await cancel()).status, 200);
      await worker.tick();
      const access = await request('/v1/platform/access');
      assert.equal(access.body.canSync, true);
      assert.equal(access.body.cancelAtPeriodEnd, true);
    });
    it('rejects tampered signatures and accepts duplicate events without changing state', async () => {
      const previous = await cfmsDb.platformSubscription.findUniqueOrThrow({
        where: { tenantId },
      });
      const payload = JSON.stringify({
        event: 'subscription.updated',
        event_id: randomUUID(),
        data: {
          tenant_id: tenantId,
          app_client_id: clientId,
          plan_tier: 'hacked',
          status: 'active',
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          entitlements: {},
          version: 999,
        },
      });
      const response = await globalThis.fetch(`${receiverUrl}/v1/platform/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ByteCraft-Signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
        },
        body: payload,
      });
      assert.equal(response.status, 401);
      assert.equal(
        (
          await cfmsDb.platformSubscription.findUniqueOrThrow({
            where: { tenantId },
          })
        ).version,
        previous.version,
      );
      const event = await cfmsDb.platformWebhookEvent.findFirstOrThrow();
      const timestamp = Math.floor(Date.now() / 1000);
      const duplicate = JSON.stringify({
        event: 'subscription.updated',
        event_id: event.eventId,
        data: {
          tenant_id: tenantId,
          app_client_id: clientId,
          plan_tier: 'old',
          status: 'active',
          expires_at: subscription.expiresAt.toISOString(),
          entitlements: {},
          version: 1,
        },
      });
      const signature = `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${duplicate}`).digest('hex')}`;
      const replay = await globalThis.fetch(`${receiverUrl}/v1/platform/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ByteCraft-Signature': signature,
          'X-ByteCraft-Event-ID': event.eventId,
        },
        body: duplicate,
      });
      assert.equal(replay.status, 204);
      assert.equal(
        (
          await cfmsDb.platformSubscription.findUniqueOrThrow({
            where: { tenantId },
          })
        ).version,
        previous.version,
      );
    });
    it('returns to Free after the paid period and preserves existing cloud records', async () => {
      await platformDb.subscription.update({
        where: { id: subscription.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await worker.tick();
      const access = await request('/v1/platform/access');
      assert.equal(access.body.tier, 'Free');
      assert.equal(access.body.canSync, false);
      assert.equal((await request('/v1/stores')).status, 402);
      assert.equal(await cfmsDb.store.count(), 1);
      assert.equal(await cfmsDb.category.count(), 3);
      assert.equal(
        (
          await platformDb.subscription.findUniqueOrThrow({
            where: { id: subscription.id },
          })
        ).status,
        'CANCELLED',
      );
    });
  },
);

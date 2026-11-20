import process from 'node:process';
import console from 'node:console';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { URL, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
const root = process.cwd();
const cfmsSettings = dotenv.parse(readFileSync(join(root, '.env')));
const cfmsPort = Number(process.env.PORT ?? cfmsSettings.PORT ?? 4000);
if (!Number.isInteger(cfmsPort) || cfmsPort < 1 || cfmsPort > 65535)
  throw new Error('Set PORT to a valid local CFMS API port.');
const webhookUrl = `http://localhost:${cfmsPort}/v1/platform/webhook`;
const platform = resolve(process.env.BYTECRAFT_PLATFORM_DIR ?? '../../ByteCraft-Platform/bytecraft-platform-backend');
const settings = dotenv.parse(readFileSync(join(platform, '.env')));
if (settings.NODE_ENV === 'production' || !['localhost', '127.0.0.1'].includes(new URL(settings.DATABASE_URL).hostname))
  throw new Error('This helper is only for an operator-controlled local development platform.');
const requirePlatform = createRequire(join(platform, 'package.json'));
const { ConfigService } = requirePlatform('@nestjs/config');
const { PrismaClient } = await import(pathToFileURL(join(platform, 'dist/generated/prisma/client.js')));
const { SecretsService } = await import(
  pathToFileURL(join(platform, 'dist/infrastructure/security/secrets.service.js'))
);
const secrets = new SecretsService(new ConfigService(settings));
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: settings.DATABASE_URL }),
});
const redirect = 'com.cfms.mobile:/oauth2redirect';
try {
  const configuration = await db.$transaction(async (tx) => {
    const app = await tx.application.upsert({
      where: { code: 'cfms' },
      update: {},
      create: {
        code: 'cfms',
        name: 'CFMS',
        description: 'Cash Flow Management System',
      },
    });
    if (!app.isActive) throw new Error('Activate the existing CFMS app before configuring integration.');
    const clients = [];
    for (const suffix of ['android', 'ios']) {
      let client = await tx.oAuthClient.findFirst({
        where: {
          applicationId: app.id,
          applicationType: 'native',
          isPublic: true,
          clientId: { startsWith: `bc_cfms_${suffix}_` },
        },
      });
      if (!client)
        client = await tx.oAuthClient.create({
          data: {
            applicationId: app.id,
            clientId: `bc_cfms_${suffix}_${randomBytes(12).toString('hex')}`,
            isPublic: true,
            applicationType: 'native',
            redirectUris: [redirect],
            allowedScopes: ['openid', 'profile', 'email', 'offline_access', 'platform'],
          },
        });
      clients.push(client);
    }
    let endpoint = await tx.webhookEndpoint.findFirst({
      where: {
        applicationId: app.id,
        oauthClientId: clients[0].id,
        url: { in: [webhookUrl, 'http://localhost:4000/v1/platform/webhook'] },
      },
    });
    if (!endpoint) {
      const id = randomUUID(),
        secret = randomBytes(32).toString('base64url');
      endpoint = await tx.webhookEndpoint.create({
        data: {
          id,
          applicationId: app.id,
          oauthClientId: clients[0].id,
          url: webhookUrl,
          encryptedSecret: secrets.encrypt(secret, 'webhook', id),
        },
      });
    }
    if (endpoint.url !== webhookUrl) {
      endpoint = await tx.webhookEndpoint.update({ where: { id: endpoint.id }, data: { url: webhookUrl } });
    }
    await tx.auditLog.create({
      data: {
        action: 'cfms_local_integration_configured',
        entityType: 'Application',
        entityId: app.id,
        metadata: {
          source: 'offline-local-operator',
          clients: clients.map((c) => c.clientId),
          endpointId: endpoint.id,
          webhookUrl,
        },
      },
    });
    return {
      BYTECRAFT_ISSUER: settings.OIDC_ISSUER ?? 'http://localhost:3000',
      BYTECRAFT_APP_CODE: 'cfms',
      BYTECRAFT_CLIENT_IDS: clients.map((c) => c.clientId).join(','),
      BYTECRAFT_ANDROID_CLIENT_ID: clients[0].clientId,
      BYTECRAFT_IOS_CLIENT_ID: clients[1].clientId,
      BYTECRAFT_REDIRECT_URI: redirect,
      BYTECRAFT_WEBHOOK_CLIENT_ID: clients[0].clientId,
      BYTECRAFT_WEBHOOK_SECRET: secrets.decrypt(endpoint.encryptedSecret, 'webhook', endpoint.id),
    };
  });
  function update(file, values) {
    let text = readFileSync(file, 'utf8');
    for (const [key, value] of Object.entries(values)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      text = regex.test(text) ? text.replace(regex, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
    }
    writeFileSync(file, text, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  update(join(root, '.env'), { ...configuration, PORT: String(cfmsPort) });
  update(join(platform, '.env'), { WEBHOOK_ALLOW_PRIVATE: 'true' });
  console.info(
    'CFMS native OAuth clients and signed webhook destination configured. Secrets saved to local .env only. No plans, prices, payment accounts or staff were invented. Restart both backends.',
  );
} finally {
  await db.$disconnect();
}

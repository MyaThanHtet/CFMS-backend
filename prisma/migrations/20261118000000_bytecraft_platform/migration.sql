ALTER TABLE users ADD COLUMN "bytecraftSubject" text UNIQUE;
CREATE TABLE platform_bindings ("userId" text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT, "platformUserId" text NOT NULL, "tenantId" text NOT NULL UNIQUE, "clientId" text NOT NULL, "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE platform_subscriptions ("tenantId" text PRIMARY KEY, status text NOT NULL, "expiresAt" timestamp(3), "graceUntil" timestamp(3), "planCode" text NOT NULL, "planName" text NOT NULL, entitlements jsonb NOT NULL, version integer NOT NULL CHECK(version>=0), "cancelAtPeriodEnd" boolean NOT NULL DEFAULT false, "updatedAt" timestamp(3) NOT NULL);
CREATE TABLE platform_webhook_events ("eventId" text PRIMARY KEY, "receivedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);

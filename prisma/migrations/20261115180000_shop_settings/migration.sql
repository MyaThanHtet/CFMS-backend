ALTER TABLE "stores" ADD COLUMN "currencySymbol" TEXT NOT NULL DEFAULT 'Ks';
ALTER TABLE "stores" ADD COLUMN "taxName" TEXT NOT NULL DEFAULT 'Commercial tax';
ALTER TABLE "stores" ADD COLUMN "taxRatePercent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "stores" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "commands" ADD COLUMN "resultShop" JSONB;

CREATE TABLE "payment_methods" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payment_methods_storeId_idx" ON "payment_methods"("storeId");

ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "payment_methods" ("id", "storeId", "name", "normalizedName", "accountId", "isDefault", "isActive", "revision", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, account."storeId", 'Cash', 'cash', account."id", true, true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "cash_accounts" account
WHERE account."name" = 'Cash drawer'
  AND account."isActive" = true
  AND NOT EXISTS (
    SELECT 1 FROM "payment_methods" method WHERE method."storeId" = account."storeId"
  );

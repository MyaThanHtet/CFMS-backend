-- CreateTable
CREATE TABLE "cash_accounts" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "openingMinor" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "sourceReference" TEXT NOT NULL DEFAULT '',
    "occurredAt" TEXT NOT NULL,
    "effectiveDate" TEXT NOT NULL,
    "categoryId" TEXT,
    "categoryName" TEXT,
    "paymentMethodName" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "linkedExpenseId" TEXT,
    "transferGroupId" TEXT,
    "status" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_reconciliations" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "cutoffAt" TEXT NOT NULL,
    "systemBalanceMinor" INTEGER NOT NULL,
    "countedMinor" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "revision" INTEGER NOT NULL,
    "createdBy" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_reconciliations_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "commands" ADD COLUMN "resultCash" JSONB;

-- CreateIndex
CREATE INDEX "cash_accounts_storeId_normalizedName_idx" ON "cash_accounts"("storeId", "normalizedName");

-- CreateIndex
CREATE INDEX "cash_movements_storeId_accountId_idx" ON "cash_movements"("storeId", "accountId");

-- CreateIndex
CREATE INDEX "cash_reconciliations_storeId_accountId_idx" ON "cash_reconciliations"("storeId", "accountId");

-- AddForeignKey
ALTER TABLE "cash_accounts" ADD CONSTRAINT "cash_accounts_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

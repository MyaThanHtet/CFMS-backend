ALTER TABLE "commands" ADD COLUMN "resultPurchase" JSONB;

CREATE TABLE "purchase_documents" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "normalizedNumber" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "effectiveDate" TEXT NOT NULL,
    "occurredAt" TEXT NOT NULL,
    "grossMinor" INTEGER NOT NULL,
    "discountMinor" INTEGER NOT NULL,
    "taxMinor" INTEGER NOT NULL,
    "shippingMinor" INTEGER NOT NULL,
    "netMinor" INTEGER NOT NULL,
    "paidMinor" INTEGER NOT NULL,
    "dueMinor" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "payments" JSONB NOT NULL,
    "returns" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_documents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "purchase_documents_storeId_normalizedNumber_idx" ON "purchase_documents"("storeId", "normalizedNumber");

ALTER TABLE "purchase_documents" ADD CONSTRAINT "purchase_documents_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "commands" ADD COLUMN "resultSale" JSONB;

CREATE TABLE "sale_documents" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "normalizedNumber" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "effectiveDate" TEXT NOT NULL,
    "occurredAt" TEXT NOT NULL,
    "grossMinor" INTEGER NOT NULL,
    "discountMinor" INTEGER NOT NULL,
    "taxMinor" INTEGER NOT NULL,
    "deliveryMinor" INTEGER NOT NULL,
    "netMinor" INTEGER NOT NULL,
    "costMinor" INTEGER NOT NULL,
    "receivedMinor" INTEGER NOT NULL,
    "dueMinor" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "payments" JSONB NOT NULL,
    "returns" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sale_documents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sale_documents_storeId_normalizedNumber_idx" ON "sale_documents"("storeId", "normalizedNumber");

ALTER TABLE "sale_documents" ADD CONSTRAINT "sale_documents_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

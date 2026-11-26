ALTER TABLE "items" ADD COLUMN "quickSaleRank" INTEGER;

ALTER TABLE "commands" ADD COLUMN "resultHeld" JSONB;

CREATE TABLE "held_sales" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "wholesale" BOOLEAN NOT NULL,
    "discountMode" TEXT NOT NULL,
    "discountValue" INTEGER NOT NULL,
    "taxMode" TEXT NOT NULL,
    "taxValue" INTEGER NOT NULL,
    "deliveryMinor" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "lines" JSONB NOT NULL,
    "revision" INTEGER NOT NULL,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "held_sales_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "held_sales_storeId_idx" ON "held_sales"("storeId");

ALTER TABLE "held_sales" ADD CONSTRAINT "held_sales_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

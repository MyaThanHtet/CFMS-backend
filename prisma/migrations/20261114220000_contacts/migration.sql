ALTER TABLE "commands" ADD COLUMN "resultContact" JSONB;

CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "contactType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "categoryId" TEXT,
    "categoryName" TEXT,
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "openingReceivableMinor" INTEGER NOT NULL DEFAULT 0,
    "openingPayableMinor" INTEGER NOT NULL DEFAULT 0,
    "collectedMinor" INTEGER NOT NULL DEFAULT 0,
    "paidMinor" INTEGER NOT NULL DEFAULT 0,
    "receivableMinor" INTEGER NOT NULL DEFAULT 0,
    "payableMinor" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contacts_storeId_contactType_isActive_idx" ON "contacts"("storeId", "contactType", "isActive");

ALTER TABLE "contacts" ADD CONSTRAINT "contacts_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

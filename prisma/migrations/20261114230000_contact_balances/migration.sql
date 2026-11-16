ALTER TABLE "contacts" ADD COLUMN "receivableAsOf" TEXT;
ALTER TABLE "contacts" ADD COLUMN "receivableNote" TEXT NOT NULL DEFAULT '';
ALTER TABLE "contacts" ADD COLUMN "payableAsOf" TEXT;
ALTER TABLE "contacts" ADD COLUMN "payableNote" TEXT NOT NULL DEFAULT '';
ALTER TABLE "contacts" ADD COLUMN "settlements" JSONB NOT NULL DEFAULT '[]';

-- Optional per-customer credit ceiling. Zero means no limit.
ALTER TABLE "contacts" ADD COLUMN "creditLimitMinor" INTEGER NOT NULL DEFAULT 0;

-- Optional compressed receipt photo stored with the expense.
ALTER TABLE "expenses" ADD COLUMN "receiptImage" TEXT NOT NULL DEFAULT '';

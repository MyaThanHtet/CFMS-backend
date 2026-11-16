#!/bin/sh
set -eu

./node_modules/.bin/prisma migrate deploy
exec ./node_modules/.bin/tsx src/main.ts

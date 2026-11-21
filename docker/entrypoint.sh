#!/bin/sh
set -eu

deploy_log=$(mktemp)
set +e
./node_modules/.bin/prisma migrate deploy >"$deploy_log" 2>&1
status=$?
set -e
cat "$deploy_log"

if [ "$status" -ne 0 ]; then
  if grep -q "P3009" "$deploy_log" && grep -q "20261114160000_auth" "$deploy_log"; then
    users=$(node --input-type=module <<'EOF'
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const result = await client.query("SELECT to_regclass('public.users') AS name");
process.stdout.write(result.rows[0].name ?? '');
await client.end();
EOF
)
    if [ -n "$users" ]; then
      echo "Migration 20261114160000_auth failed after creating users. Reset the Railway database, then redeploy."
      rm -f "$deploy_log"
      exit "$status"
    fi
    echo "Migration 20261114160000_auth failed before creating tables. Marking it rolled back and retrying."
    ./node_modules/.bin/prisma migrate resolve --rolled-back 20261114160000_auth
    ./node_modules/.bin/prisma migrate deploy
  else
    rm -f "$deploy_log"
    exit "$status"
  fi
fi

rm -f "$deploy_log"
exec ./node_modules/.bin/tsx src/main.ts

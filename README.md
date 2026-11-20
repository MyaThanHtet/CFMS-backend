# CFMS Backend

Fastify / TypeScript / PostgreSQL API for CFMS. Customer authentication uses ByteCraft Platform accounts through native Authorization Code + PKCE. Free accounts use local mobile storage; business sync requires a current paid cloud entitlement.

See [ByteCraft integration and complete local run guide](docs/bytecraft-integration.md) for database setup, native OAuth clients, webhooks, plans, payments, cancellation, and existing-account migration.

```bash
npm ci
npm run prisma:generate
docker compose up -d --wait postgres
npm run db:migrate
npm run platform:configure:local
npm run dev
```

Prepare `.env` and the sibling Platform backend first as described in the guide. API defaults to port 4000. Existing standalone CFMS credential routes are not mounted by the production container.

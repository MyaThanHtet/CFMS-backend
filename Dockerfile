FROM node:22-bookworm-slim

# Install OpenSSL before Prisma's postinstall. Bookworm slim has none, so Prisma
# otherwise downloads the OpenSSL 1.1 engine and migrations fail at startup.
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

ENV DATABASE_URL=postgresql://cfms:cfms@localhost:5432/cfms
RUN npx prisma generate

EXPOSE 3000

CMD ["sh", "docker/entrypoint.sh"]

FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

ENV DATABASE_URL=postgresql://cfms:cfms@localhost:5432/cfms
RUN npx prisma generate

EXPOSE 3000

CMD ["sh", "docker/entrypoint.sh"]

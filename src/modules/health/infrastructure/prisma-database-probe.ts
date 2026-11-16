import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { DatabaseProbe } from '../application/ports/database-probe.js';

export class PrismaDatabaseProbe implements DatabaseProbe {
  constructor(private readonly prisma: PrismaClient) {}

  async ping(): Promise<boolean> {
    await this.prisma.$queryRaw`SELECT 1`;
    return true;
  }
}

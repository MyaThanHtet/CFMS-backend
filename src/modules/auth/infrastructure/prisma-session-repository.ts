import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { NewSession, SessionRepository, StoredSession } from '../application/ports.js';

export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(session: NewSession): Promise<void> {
    await this.prisma.session.create({ data: session });
  }

  async findByHash(refreshTokenHash: string): Promise<StoredSession | null> {
    const session = await this.prisma.session.findUnique({ where: { refreshTokenHash } });
    if (!session) {
      return null;
    }
    return {
      id: session.id,
      userId: session.userId,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
    };
  }

  async revoke(id: string, revokedAt: Date): Promise<void> {
    await this.prisma.session.update({
      where: { id },
      data: { revokedAt },
    });
  }
}

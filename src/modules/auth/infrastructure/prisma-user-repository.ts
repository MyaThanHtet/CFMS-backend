import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { UserRepository } from '../application/ports.js';
import type { AuthUser } from '../domain/auth-types.js';

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByEmail(email: string): Promise<AuthUser | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findById(id: string): Promise<AuthUser | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findByGoogleSubject(subject: string): Promise<AuthUser | null> {
    return this.prisma.user.findUnique({ where: { googleSubject: subject } });
  }

  async create(user: AuthUser): Promise<AuthUser> {
    return this.prisma.user.create({
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        passwordHash: user.passwordHash,
        googleSubject: user.googleSubject,
      },
    });
  }

  async linkGoogle(userId: string, googleSubject: string): Promise<AuthUser> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { googleSubject },
    });
  }
}

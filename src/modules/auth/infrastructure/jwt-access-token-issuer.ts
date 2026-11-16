import { SignJWT } from 'jose';
import type { AccessTokenIssuer } from '../application/ports.js';
import type { PublicUser } from '../domain/auth-types.js';

const accessTtl = '15m';

export class JwtAccessTokenIssuer implements AccessTokenIssuer {
  constructor(private readonly secret: string) {}

  async issue(user: PublicUser): Promise<string> {
    return new SignJWT({ email: user.email, name: user.name })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(accessTtl)
      .sign(new TextEncoder().encode(this.secret));
  }
}

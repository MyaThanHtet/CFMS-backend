import { jwtVerify } from 'jose';
import { AuthError } from '../domain/auth-error.js';

export type AccessTokenVerifier = {
  verify(token: string): Promise<string>;
};

export class JwtAccessTokenVerifier implements AccessTokenVerifier {
  constructor(private readonly secret: string) {}

  async verify(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(this.secret));
      if (!payload.sub) {
        throw new Error('missing subject');
      }
      return payload.sub;
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }
      throw new AuthError('unauthenticated', 'Sign in again.', 401);
    }
  }
}

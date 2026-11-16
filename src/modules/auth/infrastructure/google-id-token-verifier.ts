import { OAuth2Client } from 'google-auth-library';
import type { GoogleIdentityVerifier } from '../application/ports.js';
import { AuthError } from '../domain/auth-error.js';
import type { GoogleIdentity } from '../domain/auth-types.js';

export class GoogleIdTokenVerifier implements GoogleIdentityVerifier {
  private readonly client = new OAuth2Client();

  constructor(private readonly clientIds: readonly string[]) {}

  async verify(idToken: string): Promise<GoogleIdentity> {
    if (this.clientIds.length === 0) {
      throw new AuthError('google_not_configured', 'Google sign-in is not configured.', 503);
    }

    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: [...this.clientIds],
      });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email) {
        throw new AuthError('invalid_google_token', 'Google sign-in could not be verified.', 401);
      }
      return {
        subject: payload.sub,
        email: payload.email.trim().toLowerCase(),
        emailVerified: payload.email_verified === true,
        name: payload.name ?? null,
      };
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }
      throw new AuthError('invalid_google_token', 'Google sign-in could not be verified.', 401);
    }
  }
}

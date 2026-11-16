import type { AuthUser, GoogleIdentity, PublicUser } from '../domain/auth-types.js';

export type StoredSession = {
  id: string;
  userId: string;
  deviceId: string;
  deviceName: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type NewSession = {
  id: string;
  userId: string;
  refreshTokenHash: string;
  deviceId: string;
  deviceName: string | null;
  expiresAt: Date;
};

export interface UserRepository {
  findByEmail(email: string): Promise<AuthUser | null>;
  findById(id: string): Promise<AuthUser | null>;
  findByGoogleSubject(subject: string): Promise<AuthUser | null>;
  create(user: AuthUser): Promise<AuthUser>;
  linkGoogle(userId: string, googleSubject: string): Promise<AuthUser>;
}

export interface SessionRepository {
  create(session: NewSession): Promise<void>;
  findByHash(refreshTokenHash: string): Promise<StoredSession | null>;
  revoke(id: string, revokedAt: Date): Promise<void>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encodedHash: string): Promise<boolean>;
  consumeVerificationWork(): Promise<void>;
}

export interface AccessTokenIssuer {
  issue(user: PublicUser): Promise<string>;
}

export interface GoogleIdentityVerifier {
  verify(idToken: string): Promise<GoogleIdentity>;
}

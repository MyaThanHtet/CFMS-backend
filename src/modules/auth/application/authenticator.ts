import type {
  AccessTokenIssuer,
  GoogleIdentityVerifier,
  PasswordHasher,
  SessionRepository,
  UserRepository,
} from './ports.js';
import { AuthError } from '../domain/auth-error.js';
import type { AuthUser, DeviceContext, IssuedSession } from '../domain/auth-types.js';
import { hashRefreshToken, newId, newRefreshToken } from './token.js';

const accessTtlSeconds = 15 * 60;
const refreshTtlMs = 30 * 24 * 60 * 60 * 1000;

type AuthenticatorDependencies = {
  users: UserRepository;
  sessions: SessionRepository;
  passwords: PasswordHasher;
  tokens: AccessTokenIssuer;
  google: GoogleIdentityVerifier;
  now?: () => Date;
};

type PasswordCredentials = DeviceContext & {
  email: string;
  password: string;
};

type SignUpCredentials = PasswordCredentials & {
  name: string;
};

export class Authenticator {
  constructor(private readonly deps: AuthenticatorDependencies) {}

  async signUp(input: SignUpCredentials): Promise<IssuedSession> {
    const email = normalizeEmail(input.email);
    const name = input.name.trim();
    const passwordHash = await this.deps.passwords.hash(input.password);
    const user: AuthUser = {
      id: newId(),
      email,
      name,
      passwordHash,
      googleSubject: null,
    };

    try {
      await this.deps.users.create(user);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AuthError('email_taken', 'An account with this email already exists.', 409);
      }
      throw error;
    }

    return this.issue(user, input.deviceId, input.deviceName);
  }

  async signIn(input: PasswordCredentials): Promise<IssuedSession> {
    const email = normalizeEmail(input.email);
    const user = await this.deps.users.findByEmail(email);
    if (!user?.passwordHash) {
      await this.deps.passwords.consumeVerificationWork();
      throw invalidCredentials();
    }

    const matches = await this.deps.passwords.verify(input.password, user.passwordHash);
    if (!matches) {
      throw invalidCredentials();
    }

    return this.issue(user, input.deviceId, input.deviceName);
  }

  async signInWithGoogle(input: DeviceContext & { idToken: string }): Promise<IssuedSession> {
    const identity = await this.deps.google.verify(input.idToken);
    if (!identity.emailVerified || !identity.email) {
      throw new AuthError('invalid_google_token', 'Google sign-in could not be verified.', 401);
    }

    const linked = await this.deps.users.findByGoogleSubject(identity.subject);
    if (linked) {
      return this.issue(linked, input.deviceId, input.deviceName);
    }

    const existing = await this.deps.users.findByEmail(identity.email);
    if (existing) {
      if (existing.googleSubject && existing.googleSubject !== identity.subject) {
        throw new AuthError(
          'email_taken',
          'This email is already linked to another Google account.',
          409,
        );
      }
      const user = existing.googleSubject
        ? existing
        : await this.linkOrReject(existing.id, identity.subject);
      return this.issue(user, input.deviceId, input.deviceName);
    }

    const user: AuthUser = {
      id: newId(),
      email: identity.email,
      name: displayName(identity.name, identity.email),
      passwordHash: null,
      googleSubject: identity.subject,
    };

    try {
      await this.deps.users.create(user);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AuthError('email_taken', 'An account with this email already exists.', 409);
      }
      throw error;
    }

    return this.issue(user, input.deviceId, input.deviceName);
  }

  async refresh(input: { refreshToken: string }): Promise<IssuedSession> {
    const current = await this.findActiveSession(input.refreshToken);
    const user = await this.deps.users.findById(current.userId);
    if (!user) {
      throw sessionExpired();
    }
    const issued = await this.issue(user, current.deviceId, current.deviceName);
    await this.deps.sessions.revoke(current.id, this.now());
    return issued;
  }

  async signOut(input: { refreshToken: string }): Promise<void> {
    const current = await this.deps.sessions.findByHash(hashRefreshToken(input.refreshToken));
    if (!current || current.revokedAt) {
      return;
    }
    await this.deps.sessions.revoke(current.id, this.now());
  }

  private async linkOrReject(userId: string, googleSubject: string): Promise<AuthUser> {
    try {
      return await this.deps.users.linkGoogle(userId, googleSubject);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AuthError(
          'email_taken',
          'This email is already linked to another Google account.',
          409,
        );
      }
      throw error;
    }
  }

  private async findActiveSession(refreshToken: string) {
    const current = await this.deps.sessions.findByHash(hashRefreshToken(refreshToken));
    if (!current || current.revokedAt || current.expiresAt.getTime() <= this.now().getTime()) {
      throw sessionExpired();
    }
    return current;
  }

  private async issue(
    user: AuthUser,
    deviceId: string,
    deviceName: string | null,
  ): Promise<IssuedSession> {
    const refreshToken = newRefreshToken();
    await this.deps.sessions.create({
      id: newId(),
      userId: user.id,
      refreshTokenHash: hashRefreshToken(refreshToken),
      deviceId,
      deviceName,
      expiresAt: new Date(this.now().getTime() + refreshTtlMs),
    });
    const accessToken = await this.deps.tokens.issue({
      id: user.id,
      email: user.email,
      name: user.name,
    });
    return {
      accessToken,
      refreshToken,
      expiresInSeconds: accessTtlSeconds,
      user: { id: user.id, email: user.email, name: user.name },
    };
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function displayName(name: string | null, email: string): string {
  const trimmed = name?.trim();
  if (trimmed) {
    return trimmed.slice(0, 80);
  }
  const localPart = email.split('@')[0]?.trim();
  return localPart && localPart.length > 0 ? localPart.slice(0, 80) : 'Shop user';
}

function invalidCredentials(): AuthError {
  return new AuthError('invalid_credentials', 'Email or password is incorrect.', 401);
}

function sessionExpired(): AuthError {
  return new AuthError('session_expired', 'Sign in again.', 401);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

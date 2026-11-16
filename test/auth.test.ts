import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CheckHealth } from '../src/modules/health/application/check-health.js';
import { Authenticator } from '../src/modules/auth/application/authenticator.js';
import type {
  AccessTokenIssuer,
  GoogleIdentityVerifier,
  PasswordHasher,
  SessionRepository,
  StoredSession,
  UserRepository,
} from '../src/modules/auth/application/ports.js';
import { AuthError } from '../src/modules/auth/domain/auth-error.js';
import type { AuthUser, GoogleIdentity, PublicUser } from '../src/modules/auth/domain/auth-types.js';
import { GoogleIdTokenVerifier } from '../src/modules/auth/infrastructure/google-id-token-verifier.js';
import { createApp } from '../src/infrastructure/http/create-app.js';

const device = { deviceId: 'device-1', deviceName: 'Android device' };

describe('authentication', () => {
  it('signs up, signs in, rotates refresh, and signs out', async () => {
    const { app } = buildApp();

    const created = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      payload: {
        name: 'Aung Min',
        email: 'Owner@Shop.com',
        password: 'password12',
        ...device,
      },
    });
    assert.equal(created.statusCode, 201);
    const createdBody = created.json();
    assert.equal(createdBody.user.email, 'owner@shop.com');
    assert.equal(createdBody.user.name, 'Aung Min');
    assert.equal(createdBody.expiresInSeconds, 900);
    assert.equal(typeof createdBody.accessToken, 'string');
    assert.equal(typeof createdBody.refreshToken, 'string');

    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      payload: {
        name: 'Aung Min',
        email: 'owner@shop.com',
        password: 'password12',
        ...device,
      },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error.code, 'email_taken');

    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email: 'owner@shop.com', password: 'wrong-password', ...device },
    });
    assert.equal(rejected.statusCode, 401);
    assert.equal(rejected.json().error.code, 'invalid_credentials');

    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email: 'missing@shop.com', password: 'password12', ...device },
    });
    assert.equal(unknown.statusCode, 401);
    assert.equal(unknown.json().error.code, 'invalid_credentials');

    const signedIn = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email: 'owner@shop.com', password: 'password12', ...device },
    });
    assert.equal(signedIn.statusCode, 200);
    const signedInBody = signedIn.json();

    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: signedInBody.refreshToken },
    });
    assert.equal(refreshed.statusCode, 200);
    assert.notEqual(refreshed.json().refreshToken, signedInBody.refreshToken);

    const reused = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: signedInBody.refreshToken },
    });
    assert.equal(reused.statusCode, 401);
    assert.equal(reused.json().error.code, 'session_expired');

    const signedOut = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-out',
      payload: { refreshToken: refreshed.json().refreshToken },
    });
    assert.equal(signedOut.statusCode, 204);

    const afterSignOut = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: refreshed.json().refreshToken },
    });
    assert.equal(afterSignOut.statusCode, 401);

    const unknownSignOut = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-out',
      payload: { refreshToken: 'not-a-session' },
    });
    assert.equal(unknownSignOut.statusCode, 204);

    await app.close();
  });

  it('rejects an incomplete sign-up', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      payload: { name: 'Aung', email: 'not-an-email', password: 'short', deviceId: 'device-1' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'validation_error');
    await app.close();
  });

  it('links google to the password account with the same email', async () => {
    const google = new FakeGoogle();
    const { app, users } = buildApp(google);
    await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-up',
      payload: { name: 'Aung Min', email: 'owner@shop.com', password: 'password12', ...device },
    });

    google.identity = {
      subject: 'google-subject-1',
      email: 'owner@shop.com',
      emailVerified: true,
      name: 'Aung Min',
    };
    const linked = await app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { idToken: 'google-token', ...device },
    });
    assert.equal(linked.statusCode, 200);
    assert.equal(users.records.size, 1);
    assert.equal([...users.records.values()][0]?.googleSubject, 'google-subject-1');

    const again = await app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { idToken: 'google-token', ...device },
    });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().user.id, linked.json().user.id);
    assert.equal(users.records.size, 1);
    await app.close();
  });

  it('creates a google-only account and rejects password sign-in for it', async () => {
    const google = new FakeGoogle();
    const { app } = buildApp(google);
    google.identity = {
      subject: 'google-subject-2',
      email: 'ma.hla@shop.com',
      emailVerified: true,
      name: 'Ma Hla',
    };
    const created = await app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { idToken: 'google-token', ...device },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().user.email, 'ma.hla@shop.com');

    const password = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      payload: { email: 'ma.hla@shop.com', password: 'password12', ...device },
    });
    assert.equal(password.statusCode, 401);
    assert.equal(password.json().error.code, 'invalid_credentials');
    await app.close();
  });

  it('rejects an unverified google email and a conflicting google subject', async () => {
    const google = new FakeGoogle();
    const { app } = buildApp(google);
    google.identity = {
      subject: 'google-subject-1',
      email: 'owner@shop.com',
      emailVerified: false,
      name: 'Aung Min',
    };
    const unverified = await app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { idToken: 'google-token', ...device },
    });
    assert.equal(unverified.statusCode, 401);
    assert.equal(unverified.json().error.code, 'invalid_google_token');

    google.identity = { ...google.identity, emailVerified: true };
    await app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { idToken: 'google-token', ...device },
    });
    google.identity = { ...google.identity, subject: 'google-subject-2' };
    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { idToken: 'other-token', ...device },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, 'email_taken');
    await app.close();
  });

  it('reports that google is not configured', async () => {
    const verifier = new GoogleIdTokenVerifier([]);
    await assert.rejects(
      () => verifier.verify('token'),
      (error: unknown) => error instanceof AuthError && error.code === 'google_not_configured',
    );
  });

  it('rejects an expired refresh token', async () => {
    let current = new Date('2026-01-01T00:00:00Z');
    const { authenticator } = buildAuthenticator({ now: () => current });
    const session = await authenticator.signUp({
      name: 'Aung Min',
      email: 'owner@shop.com',
      password: 'password12',
      ...device,
    });
    current = new Date('2026-03-01T00:00:00Z');
    await assert.rejects(
      () => authenticator.refresh({ refreshToken: session.refreshToken }),
      (error: unknown) => error instanceof AuthError && error.code === 'session_expired',
    );
  });
});

function buildApp(google: GoogleIdentityVerifier = new FakeGoogle()) {
  const built = buildAuthenticator({ google });
  const app = createApp(
    {
      checkHealth: new CheckHealth({ ping: async () => true }),
      authenticator: built.authenticator,
      disconnect: async () => {},
    },
    { logger: false },
  );
  return { app, users: built.users };
}

function buildAuthenticator(options: { google?: GoogleIdentityVerifier; now?: () => Date } = {}) {
  const users = new MemoryUsers();
  const sessions = new MemorySessions();
  const authenticator = new Authenticator({
    users,
    sessions,
    passwords: new FakeHasher(),
    tokens: new FakeTokens(),
    google: options.google ?? new FakeGoogle(),
    ...(options.now ? { now: options.now } : {}),
  });
  return { authenticator, users };
}

class MemoryUsers implements UserRepository {
  readonly records = new Map<string, AuthUser>();

  async findByEmail(email: string): Promise<AuthUser | null> {
    return [...this.records.values()].find((user) => user.email === email) ?? null;
  }

  async findById(id: string): Promise<AuthUser | null> {
    return this.records.get(id) ?? null;
  }

  async findByGoogleSubject(subject: string): Promise<AuthUser | null> {
    return [...this.records.values()].find((user) => user.googleSubject === subject) ?? null;
  }

  async create(user: AuthUser): Promise<AuthUser> {
    if ([...this.records.values()].some((item) => item.email === user.email)) {
      throw uniqueViolation();
    }
    if (
      user.googleSubject &&
      [...this.records.values()].some((item) => item.googleSubject === user.googleSubject)
    ) {
      throw uniqueViolation();
    }
    this.records.set(user.id, { ...user });
    return { ...user };
  }

  async linkGoogle(userId: string, googleSubject: string): Promise<AuthUser> {
    const user = this.records.get(userId);
    if (!user) {
      throw new Error('missing user');
    }
    if ([...this.records.values()].some((item) => item.googleSubject === googleSubject)) {
      throw uniqueViolation();
    }
    const linked = { ...user, googleSubject };
    this.records.set(userId, linked);
    return linked;
  }
}

class MemorySessions implements SessionRepository {
  private readonly records = new Map<string, StoredSession & { refreshTokenHash: string }>();

  async create(session: {
    id: string;
    userId: string;
    refreshTokenHash: string;
    deviceId: string;
    deviceName: string | null;
    expiresAt: Date;
  }): Promise<void> {
    this.records.set(session.refreshTokenHash, { ...session, revokedAt: null });
  }

  async findByHash(refreshTokenHash: string): Promise<StoredSession | null> {
    const session = this.records.get(refreshTokenHash);
    if (!session) {
      return null;
    }
    return { ...session };
  }

  async revoke(id: string, revokedAt: Date): Promise<void> {
    for (const session of this.records.values()) {
      if (session.id === id) {
        session.revokedAt = revokedAt;
      }
    }
  }
}

class FakeHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return `hash:${password}`;
  }

  async verify(password: string, encodedHash: string): Promise<boolean> {
    return encodedHash === `hash:${password}`;
  }

  async consumeVerificationWork(): Promise<void> {}
}

class FakeTokens implements AccessTokenIssuer {
  async issue(user: PublicUser): Promise<string> {
    return `access:${user.id}`;
  }
}

class FakeGoogle implements GoogleIdentityVerifier {
  identity: GoogleIdentity | null = null;

  async verify(): Promise<GoogleIdentity> {
    if (!this.identity) {
      throw new AuthError('invalid_google_token', 'Google sign-in could not be verified.', 401);
    }
    return this.identity;
  }
}

function uniqueViolation(): Error {
  return Object.assign(new Error('unique'), { code: 'P2002' });
}

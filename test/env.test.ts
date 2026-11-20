import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadEnv } from '../src/config/env.js';

describe('loadEnv', () => {
  it('reads the runtime configuration', () => {
    const env = loadEnv({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '4300',
      DATABASE_URL: 'postgresql://cfms:cfms@localhost:5432/cfms',
      JWT_ACCESS_SECRET: 'test-secret-with-32-characters-min',
      GOOGLE_CLIENT_IDS: 'web-client.apps.googleusercontent.com, ios-client.apps.googleusercontent.com',
    });

    assert.equal(env.NODE_ENV, 'test');
    assert.equal(env.HOST, '127.0.0.1');
    assert.equal(env.PORT, 4300);
    assert.equal(env.DATABASE_URL, 'postgresql://cfms:cfms@localhost:5432/cfms');
    assert.equal(env.JWT_ACCESS_SECRET, 'test-secret-with-32-characters-min');
    assert.deepEqual(env.GOOGLE_CLIENT_IDS, [
      'web-client.apps.googleusercontent.com',
      'ios-client.apps.googleusercontent.com',
    ]);
  });

  it('treats a missing google client list as unconfigured', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://cfms:cfms@localhost:5432/cfms',
      JWT_ACCESS_SECRET: 'test-secret-with-32-characters-min',
    });

    assert.deepEqual(env.GOOGLE_CLIENT_IDS, []);
  });

  it('rejects a missing database url', () => {
    assert.throws(() => loadEnv({ NODE_ENV: 'test' }), /DATABASE_URL/);
  });

  it('rejects a short access-token secret', () => {
    assert.throws(
      () =>
        loadEnv({
          DATABASE_URL: 'postgresql://cfms:cfms@localhost:5432/cfms',
          JWT_ACCESS_SECRET: 'too-short',
        }),
      /JWT_ACCESS_SECRET/,
    );
  });
  it('uses central authentication without a standalone CFMS JWT secret', () => {
    const env = loadEnv({ DATABASE_URL: 'postgresql://cfms:cfms@localhost:5432/cfms' });
    assert.equal(env.JWT_ACCESS_SECRET, undefined);
    assert.equal(env.PORT, 4000);
  });
  it('requires HTTPS for the production ByteCraft issuer', () => {
    assert.throws(
      () =>
        loadEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://localhost/cfms',
          BYTECRAFT_ISSUER: 'http://localhost:3000',
        }),
      /HTTPS/,
    );
  });
});

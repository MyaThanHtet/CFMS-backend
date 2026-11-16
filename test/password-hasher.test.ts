import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Argon2PasswordHasher } from '../src/modules/auth/infrastructure/argon2-password-hasher.js';

describe('Argon2PasswordHasher', () => {
  it('stores an argon2id hash that verifies only the same password', async () => {
    const hasher = new Argon2PasswordHasher();
    const encoded = await hasher.hash('password12');

    assert.match(encoded, /^\$argon2id\$/);
    assert.equal(await hasher.verify('password12', encoded), true);
    assert.equal(await hasher.verify('other-password', encoded), false);
  });
});

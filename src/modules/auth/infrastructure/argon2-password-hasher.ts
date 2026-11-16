import { randomBytes } from 'node:crypto';
import { argon2Verify, argon2id } from 'hash-wasm';
import type { PasswordHasher } from '../application/ports.js';

const memorySizeKib = 19 * 1024;
const iterations = 2;
const parallelism = 1;
const hashLength = 32;

export class Argon2PasswordHasher implements PasswordHasher {
  private dummyHash: string | null = null;

  async hash(password: string): Promise<string> {
    return argon2id({
      password,
      salt: randomBytes(16),
      iterations,
      parallelism,
      memorySize: memorySizeKib,
      hashLength,
      outputType: 'encoded',
    });
  }

  async verify(password: string, encodedHash: string): Promise<boolean> {
    return argon2Verify({ password, hash: encodedHash });
  }

  async consumeVerificationWork(): Promise<void> {
    this.dummyHash ??= await this.hash('dummy-password');
    await this.verify('dummy-password', this.dummyHash);
  }
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CheckHealth } from '../src/modules/health/application/check-health.js';
import { createApp } from '../src/infrastructure/http/create-app.js';

describe('GET /health', () => {
  it('returns 200 when the database is up', async () => {
    const app = createApp(
      {
        checkHealth: new CheckHealth({ ping: async () => true }),
        disconnect: async () => {},
      },
      { logger: false },
    );

    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: 'ok',
      service: 'cfms-backend',
      checks: { database: 'up' },
    });
    await app.close();
  });

  it('returns 503 when the database is down', async () => {
    const app = createApp(
      {
        checkHealth: new CheckHealth({ ping: async () => false }),
        disconnect: async () => {},
      },
      { logger: false },
    );

    const response = await app.inject({ method: 'GET', url: '/health' });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().status, 'degraded');
    assert.equal(response.json().checks.database, 'down');
    await app.close();
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CheckHealth } from '../src/modules/health/application/check-health.js';
import type { DatabaseProbe } from '../src/modules/health/application/ports/database-probe.js';

describe('CheckHealth', () => {
  it('reports ok when the database answers', async () => {
    const status = await new CheckHealth(probe(async () => true)).execute();

    assert.equal(status.status, 'ok');
    assert.equal(status.service, 'cfms-backend');
    assert.equal(status.checks.database, 'up');
  });

  it('reports degraded when the database probe fails', async () => {
    const status = await new CheckHealth(
      probe(async () => {
        throw new Error('connection refused');
      }),
    ).execute();

    assert.equal(status.status, 'degraded');
    assert.equal(status.checks.database, 'down');
  });

  it('reports degraded when the probe returns false', async () => {
    const status = await new CheckHealth(probe(async () => false)).execute();

    assert.equal(status.status, 'degraded');
    assert.equal(status.checks.database, 'down');
  });
});

function probe(ping: DatabaseProbe['ping']): DatabaseProbe {
  return { ping };
}

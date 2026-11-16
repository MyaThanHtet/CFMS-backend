import type { DatabaseProbe } from './ports/database-probe.js';
import type { HealthStatus } from '../domain/health-status.js';

export class CheckHealth {
  constructor(private readonly database: DatabaseProbe) {}

  async execute(): Promise<HealthStatus> {
    const databaseUp = await this.isDatabaseUp();
    return {
      status: databaseUp ? 'ok' : 'degraded',
      service: 'cfms-backend',
      checks: {
        database: databaseUp ? 'up' : 'down',
      },
    };
  }

  private async isDatabaseUp(): Promise<boolean> {
    try {
      return await this.database.ping();
    } catch {
      return false;
    }
  }
}

export type HealthStatus = {
  status: 'ok' | 'degraded';
  service: 'cfms-backend';
  checks: {
    database: 'up' | 'down';
  };
};

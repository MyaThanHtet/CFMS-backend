import type { FastifyInstance } from 'fastify';
import type { CheckHealth } from '../application/check-health.js';

export function registerHealthRoutes(app: FastifyInstance, checkHealth: CheckHealth): void {
  app.get('/health', async (_request, reply) => {
    const status = await checkHealth.execute();
    const code = status.status === 'ok' ? 200 : 503;
    return reply.code(code).send(status);
  });
}

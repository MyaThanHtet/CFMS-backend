import 'dotenv/config';
import { loadEnv } from './config/env.js';
import { createContainer } from './infrastructure/composition/container.js';
import { createApp } from './infrastructure/http/create-app.js';

const env = loadEnv(process.env);
const container = createContainer(env);
const app = createApp(container, { logger: env.NODE_ENV !== 'test' });

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exit(1);
}

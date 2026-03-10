import { createServer } from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { checkDatabaseConnection } from './config/database';

async function bootstrap() {
  await checkDatabaseConnection();

  const app = createApp();
  const server = createServer(app);

  server.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Envenflow backend running on port ${env.PORT}`);
  });
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server', error);
  process.exit(1);
});

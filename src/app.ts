import cors from 'cors';
import express, { Request } from 'express';
import helmet from 'helmet';
import { corsOptions } from './config/cors';
import { httpLogger } from './config/logger';
import { rateLimitMiddleware } from './core/middleware/rateLimit.middleware';
import { errorMiddleware } from './core/middleware/error.middleware';
import { router } from './routes/index.js';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors(corsOptions));
  app.use(
    express.json({
      limit: '2mb',
      verify: (request: Request, _response, buffer) => {
        // Keep raw payload for signed webhooks (FedaPay signature validation).
        (request as Request & { rawBody?: string }).rawBody = buffer.toString('utf8');
      }
    })
  );
  app.use(httpLogger);
  app.use(rateLimitMiddleware());

  app.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  app.use('/api', router);
  app.use(errorMiddleware);

  return app;
}

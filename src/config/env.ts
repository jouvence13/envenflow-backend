import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  LOG_LEVEL: z.string().default('info'),
  FEDAPAY_ENV: z.enum(['sandbox', 'test', 'live', 'production', 'development', 'dev']).default('live'),
  FEDAPAY_SECRET_KEY: z.string().optional(),
  FEDAPAY_PUBLIC_KEY: z.string().optional(),
  FEDAPAY_ACCOUNT_ID: z.string().optional(),
  FEDAPAY_WEBHOOK_SECRET: z.string().optional(),
  FEDAPAY_CALLBACK_URL: z.string().url().optional()
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const message = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('; ');
  throw new Error(`Invalid environment variables: ${message}`);
}

export const env = parsed.data;

import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1),
  ADMIN_API_KEY: z.string().min(8),
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('roviq-core'),
  JWT_AUDIENCE: z.string().default('roviq-apps'),
  ALLOW_DEV_HEADERS: z.enum(['true','false']).default('false').transform(v => v === 'true'),
  REQUIRED_MIGRATION: z.string().default('016_service_plan_commerce.sql')
});

export const env = schema.parse(process.env);

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
  // Off by default: routing still requires an active routing_policies row to do anything (fails
  // closed the same way auto-dispatch already does), but flipping this on is a deliberate
  // operational decision, not something a fresh deploy or the existing test fixtures should
  // suddenly start doing. Turn on once a real routing policy has been configured and reviewed.
  AUTO_ROUTE_NEW_DEMANDS: z.enum(['true','false']).default('false').transform(v => v === 'true')
});

export const env = schema.parse(process.env);

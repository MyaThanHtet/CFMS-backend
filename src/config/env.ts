import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1),
    // Legacy test modules only; production uses ByteCraft RS256 access tokens.
    JWT_ACCESS_SECRET: z.string().min(32).optional(),
    BYTECRAFT_ISSUER: z
      .string()
      .default('')
      .refine((v) => !v || (URL.canParse(v) && new URL(v).origin === v && /^https?:/.test(v))),
    BYTECRAFT_APP_CODE: z.string().default('cfms'),
    BYTECRAFT_CLIENT_IDS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    BYTECRAFT_ANDROID_CLIENT_ID: z.string().default(''),
    BYTECRAFT_IOS_CLIENT_ID: z.string().default(''),
    BYTECRAFT_REDIRECT_URI: z.string().default('com.cfms.mobile:/oauth2redirect'),
    BYTECRAFT_WEBHOOK_CLIENT_ID: z.string().default(''),
    BYTECRAFT_WEBHOOK_SECRET: z.string().default(''),
    GOOGLE_CLIENT_IDS: z
      .string()
      .optional()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      ),
  })
  .superRefine((env, context) => {
    if (env.NODE_ENV === 'production' && !env.BYTECRAFT_ISSUER.startsWith('https://')) {
      context.addIssue({
        code: 'custom',
        path: ['BYTECRAFT_ISSUER'],
        message: 'Production requires an HTTPS ByteCraft issuer.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment: ${message}`);
  }
  return parsed.data;
}

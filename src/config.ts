import { z } from 'zod';

export type Config = { issuer: string; resource: URL; jwksUri: URL; port: number };

const envSchema = z.object({
  ISSUER: z.url(),
  RESOURCE_URL: z.url(),
  JWKS_URI: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid environment: ${problems.join('; ')}`);
  }
  const { ISSUER, RESOURCE_URL, JWKS_URI, PORT } = parsed.data;
  // The issuer stays a string: tokens are matched against it byte for byte, so it must not be normalised.
  return {
    issuer: ISSUER,
    resource: new URL(RESOURCE_URL),
    jwksUri: new URL(JWKS_URI),
    port: PORT,
  };
}

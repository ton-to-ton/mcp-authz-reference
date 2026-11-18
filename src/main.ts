import { createRemoteJWKSet } from 'jose';
import { z } from 'zod';
import { createApp } from './app.js';
import { createVerifier } from './auth/verify.js';
import { loadConfig, type Config } from './config.js';
import { createTicketStore } from './itsm/store.js';

// Imperative shell: reads the environment, touches the network, starts listening.
// Decisions live in app.ts and the modules it composes.

const jwksSchema = z.object({ keys: z.array(z.unknown()).min(1) });

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// fetch() reports network failures as a bare "fetch failed"; the useful part is in `cause`.
function reason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
}

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  die(reason(err));
}

// Fetch the key set once so a wrong JWKS_URI fails at startup instead of on the first request.
try {
  const res = await fetch(config.jwksUri);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  jwksSchema.parse(await res.json());
} catch (err) {
  die(`cannot load JWKS from ${config.jwksUri.href}: ${reason(err)}`);
}

const verifier = createVerifier({
  issuer: config.issuer,
  resource: config.resource,
  jwks: createRemoteJWKSet(config.jwksUri),
});
const app = createApp({ config, verifier, store: createTicketStore() });

app.listen(config.port, () => {
  process.stdout.write(`itsm-mcp listening on :${config.port}\n`);
});

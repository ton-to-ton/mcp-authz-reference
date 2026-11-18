import { existsSync } from 'node:fs';
import { z } from 'zod';

// Test-only passwords: .env when present, otherwise the committed .env.example (same values
// docker compose and keycloak/setup-realm.sh use).
const envFile = existsSync('.env') ? '.env' : '.env.example';
process.loadEnvFile(envFile);

const TOKEN_URL = 'http://localhost:8080/realms/itsm-lab/protocol/openid-connect/token';

const PASSWORD_VAR = { alice: 'ALICE_PASSWORD', bob: 'BOB_PASSWORD' } as const;
export type TestUser = keyof typeof PASSWORD_VAR;

const tokenResponse = z.object({ access_token: z.string() });

// Resource Owner Password Credentials on the test-only client `lab-tester`. OAuth 2.1 removes
// this grant; it exists here only so tests can obtain tokens without a browser.
export async function getToken(user: TestUser, scopes: string[]): Promise<string> {
  const password = process.env[PASSWORD_VAR[user]];
  if (password === undefined) throw new Error(`${PASSWORD_VAR[user]} is not set in ${envFile}`);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'lab-tester',
      username: user,
      password,
      scope: scopes.join(' '),
    }),
  });
  const body = await res.text();
  if (res.status !== 200) {
    throw new Error(`token request for ${user} failed: HTTP ${res.status} ${body}`);
  }
  return tokenResponse.parse(JSON.parse(body)).access_token;
}

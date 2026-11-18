// Probes how Keycloak treats the RFC 8707 `resource` parameter. Run it against a running stack:
//   node scripts/probe-resource-indicators.ts <label>      (label only titles the output)
// Flag off: docker compose up -d --wait. Flag on: add -f compose.resource-indicators.yaml and run
// keycloak/setup-resource-indicators.sh. See docs/verification/2026-11-18-resource-indicators.md.
import { existsSync } from 'node:fs';
import { decodeJwt } from 'jose';
import { authorizationCodeToken } from './authcode.ts';

const envFile = existsSync('.env') ? '.env' : '.env.example';
process.loadEnvFile(envFile);
const PASSWORD = process.env['ALICE_PASSWORD'];
if (PASSWORD === undefined) throw new Error(`ALICE_PASSWORD is not set in ${envFile}`);

const MCP_URL = 'http://localhost:3000/mcp';
const OTHER_URL = 'http://localhost:3001/mcp';
const UNKNOWN_URL = 'http://localhost:9999/mcp';

// Same request shape as test/e2e: the server is stateless, one POST per call.
async function mcpStatus(
  token: string,
): Promise<{ status: number; wwwAuthenticate: string | null }> {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return { status: res.status, wwwAuthenticate: res.headers.get('www-authenticate') };
}

type Probe = {
  name: string;
  scope: string;
  authResource?: string;
  tokenResource?: string;
};

const PROBES: Probe[] = [
  { name: '0. no resource (baseline)', scope: 'itsm:read' },
  {
    name: '1. resource=3000 on both requests',
    scope: 'itsm:read',
    authResource: MCP_URL,
    tokenResource: MCP_URL,
  },
  {
    name: '2a. unknown resource on the authorization request',
    scope: 'itsm:read',
    authResource: UNKNOWN_URL,
  },
  {
    name: '2b. unknown resource on the token request only',
    scope: 'itsm:read',
    authResource: MCP_URL,
    tokenResource: UNKNOWN_URL,
  },
  {
    name: '2c. unknown resource on both requests',
    scope: 'itsm:read',
    authResource: UNKNOWN_URL,
    tokenResource: UNKNOWN_URL,
  },
  {
    name: '3. resource differs: authorization=3000, token=3001',
    scope: 'itsm:read',
    authResource: MCP_URL,
    tokenResource: OTHER_URL,
  },
  {
    name: '4. resource=3001 with scope itsm:read (is the resource honoured or ignored?)',
    scope: 'itsm:read',
    authResource: OTHER_URL,
    tokenResource: OTHER_URL,
  },
  { name: '5a. shared:read, no resource', scope: 'shared:read' },
  {
    name: '5b. shared:read, resource=3001',
    scope: 'shared:read',
    authResource: OTHER_URL,
    tokenResource: OTHER_URL,
  },
];

const label = process.argv[2] ?? 'unlabelled';
console.log(`=== probe-resource-indicators: ${label} (${new Date().toISOString()}) ===`);

for (const probe of PROBES) {
  console.log(`\n--- ${probe.name}`);
  console.log(
    `request: scope=${probe.scope} auth resource=${probe.authResource ?? '-'} token resource=${probe.tokenResource ?? '-'}`,
  );
  const { status, body } = await authorizationCodeToken({
    user: 'alice',
    password: PASSWORD,
    ...probe,
  });
  const token =
    status === 200 && typeof body === 'object' && body !== null && 'access_token' in body
      ? String(body.access_token)
      : undefined;
  if (token === undefined) {
    console.log(`result: HTTP ${status} ${JSON.stringify(body)}`);
    continue;
  }
  const claims = decodeJwt(token);
  console.log(`result: HTTP ${status} token issued`);
  console.log(
    `claims: ${JSON.stringify({ iss: claims.iss, azp: claims['azp'], aud: claims.aud, scope: claims['scope'] })}`,
  );
  const mcp = await mcpStatus(token);
  console.log(`MCP ${MCP_URL} tools/list: HTTP ${mcp.status}`);
}

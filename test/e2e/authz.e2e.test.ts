import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import { getToken } from './token.js';

const ISSUER = 'http://localhost:8080/realms/itsm-lab';
const MCP_URL = 'http://localhost:3000/mcp';
const BASE_URL = 'http://localhost:3000';
const PROTOCOL_VERSION = '2025-11-25';

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

// The server is stateless, so every call is an independent POST with its own headers.
async function rpc(token: string, method: string, params?: object): Promise<Response> {
  return fetch(MCP_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function resultOf<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: T };
  return body.result;
}

async function toolNames(token: string): Promise<string[]> {
  const result = await resultOf<{ tools: { name: string }[] }>(await rpc(token, 'tools/list'));
  return result.tools.map((t) => t.name);
}

const callTool = async (token: string, name: string, args: object): Promise<ToolResult> =>
  resultOf<ToolResult>(await rpc(token, 'tools/call', { name, arguments: args }));

// The in-memory store lives as long as the itsm-mcp container, so the tests that change tickets
// use distinct ones (INC-0002 is closed, INC-0003 is commented on) and assert what must hold on
// a re-run against the same stack too.
describe('authorization against Keycloak and the containerised MCP server', () => {
  it('alice with read scope: search works, close is not listed', async () => {
    const token = await getToken('alice', ['itsm:read']);
    expect(await toolNames(token)).toEqual(['search_tickets', 'get_ticket']);
    const found = await callTool(token, 'search_tickets', { query: '' });
    expect(found.isError).toBeUndefined();
    expect(JSON.parse(found.content[0]?.text ?? '')).toHaveLength(5);
  });

  it('alice with all itsm scopes can close INC-0002', async () => {
    const token = await getToken('alice', ['itsm:read', 'itsm:write', 'itsm:close']);
    expect(await toolNames(token)).toEqual([
      'search_tickets',
      'get_ticket',
      'add_comment',
      'close_ticket',
    ]);
    const closed = await callTool(token, 'close_ticket', { id: 'INC-0002' });
    expect(closed.isError).toBeUndefined();
    const ticket = await callTool(token, 'get_ticket', { id: 'INC-0002' });
    expect(JSON.parse(ticket.content[0]?.text ?? '')).toMatchObject({ status: 'closed' });
  });

  it('bob requesting all itsm scopes still gets read tools only', async () => {
    const token = await getToken('bob', ['itsm:read', 'itsm:write', 'itsm:close']);
    expect(await toolNames(token)).toEqual(['search_tickets', 'get_ticket']);
    const refused = await callTool(token, 'close_ticket', { id: 'INC-0004' });
    expect(refused.isError).toBe(true);
    const ticket = await callTool(token, 'get_ticket', { id: 'INC-0004' });
    expect(JSON.parse(ticket.content[0]?.text ?? '')).toMatchObject({ status: 'open' });
  });

  it('alice with read+write can comment on INC-0003 but not close it', async () => {
    const token = await getToken('alice', ['itsm:read', 'itsm:write']);
    expect(await toolNames(token)).toEqual(['search_tickets', 'get_ticket', 'add_comment']);
    const commented = await callTool(token, 'add_comment', { id: 'INC-0003', text: 'looking' });
    expect(commented.isError).toBeUndefined();
    const refused = await callTool(token, 'close_ticket', { id: 'INC-0003' });
    expect(refused.isError).toBe(true);
    const ticket = await callTool(token, 'get_ticket', { id: 'INC-0003' });
    expect(JSON.parse(ticket.content[0]?.text ?? '')).toMatchObject({ status: 'open' });
  });

  it('token for other:read (aud localhost:3001) is rejected with 401', async () => {
    const token = await getToken('alice', ['other:read']);
    const res = await rpc(token, 'tools/list');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('token iss is localhost while the MCP container fetched keys via keycloak:8080', async () => {
    const token = await getToken('alice', ['itsm:read']);
    expect(decodeJwt(token).iss).toBe(ISSUER);
    const res = await rpc(token, 'tools/list');
    expect(res.status).toBe(200);
  });

  it('token carries the claims the server relies on', async () => {
    const claims = decodeJwt(await getToken('alice', ['itsm:read']));
    expect(claims.sub).toBeTruthy();
    expect(claims.azp).toBe('lab-tester');
    expect(String(claims.scope)).toContain('itsm:read');
    expect(claims.roles).toContain('itsm-operator');
  });

  it('nothing the MCP server serves to clients mentions keycloak:8080', async () => {
    const served = [
      await fetch(`${BASE_URL}/.well-known/oauth-protected-resource/mcp`),
      await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`),
      await fetch(MCP_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    ];
    const unauthorized = served[2];
    expect(unauthorized?.status).toBe(401);
    expect(unauthorized?.headers.get('www-authenticate')).toContain('resource_metadata=');
    const everything = await Promise.all(
      served.map(async (res) => `${[...res.headers].join('\n')}\n${await res.text()}`),
    );
    for (const text of everything) {
      expect(text).not.toContain('keycloak:8080');
    }
  });
});

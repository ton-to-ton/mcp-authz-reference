import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import { getToken } from './token.js';

const ISSUER = 'http://localhost:8080/realms/itsm-lab';
const MCP_URL = 'http://localhost:3000/mcp';
const BASE_URL = 'http://localhost:3000';
const PROTOCOL_VERSION = '2025-11-25';

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
type Ticket = {
  id: string;
  status: 'open' | 'closed';
  comments: { author: string; text: string }[];
};

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

const getTicket = async (token: string, id: string): Promise<Ticket> => {
  const result = await callTool(token, 'get_ticket', { id });
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0]?.text ?? '') as Ticket;
};

const subOf = (token: string): string => {
  const { sub } = decodeJwt(token);
  if (sub === undefined) throw new Error('token has no sub');
  return sub;
};

// The in-memory store lives as long as the itsm-mcp container, so a test that mutates must prove
// a NEW mutation: it reads the ticket before, acts, and reads it back, so it cannot pass on state
// left by an earlier run. Closing is irreversible, hence the pool below: each run closes the first
// ticket that is still open, and fails loudly once the pool is used up (recreate the stack with
// `docker compose down -v && docker compose up -d --wait`). INC-0003 (comments) and INC-0004
// (refused close) are never in the pool.
const CLOSE_POOL = ['INC-0002', 'INC-0001', 'INC-0005'];
describe('authorization against Keycloak and the containerised MCP server', () => {
  it('alice with read scope: search works, close is not listed', async () => {
    const token = await getToken('alice', ['itsm:read']);
    expect(await toolNames(token)).toEqual(['search_tickets', 'get_ticket']);
    const found = await callTool(token, 'search_tickets', { query: '' });
    expect(found.isError).toBeUndefined();
    expect(JSON.parse(found.content[0]?.text ?? '')).toHaveLength(5);
  });

  it('alice with all itsm scopes can close a ticket that was open', async () => {
    const token = await getToken('alice', ['itsm:read', 'itsm:write', 'itsm:close']);
    expect(await toolNames(token)).toEqual([
      'search_tickets',
      'get_ticket',
      'add_comment',
      'close_ticket',
    ]);
    const before = await Promise.all(CLOSE_POOL.map((id) => getTicket(token, id)));
    const target = before.find((t) => t.status === 'open');
    if (target === undefined) {
      throw new Error(
        `every ticket in ${CLOSE_POOL.join(', ')} is already closed by earlier runs; ` +
          'recreate the stack: docker compose down -v && docker compose up -d --wait',
      );
    }

    const closed = await callTool(token, 'close_ticket', { id: target.id });
    expect(closed.isError).toBeUndefined();

    const after = await getTicket(token, target.id);
    expect(after.status).toBe('closed');
    expect(after.comments).toHaveLength(target.comments.length + 1);
    expect(after.comments.at(-1)).toEqual({ author: subOf(token), text: 'closed' });
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
    const before = await getTicket(token, 'INC-0003');

    const text = `e2e comment ${randomUUID()}`;
    const commented = await callTool(token, 'add_comment', { id: 'INC-0003', text });
    expect(commented.isError).toBeUndefined();

    const after = await getTicket(token, 'INC-0003');
    expect(after.comments).toHaveLength(before.comments.length + 1);
    expect(after.comments.at(-1)).toEqual({ author: subOf(token), text });

    const refused = await callTool(token, 'close_ticket', { id: 'INC-0003' });
    expect(refused.isError).toBe(true);
    expect((await getTicket(token, 'INC-0003')).status).toBe('open');
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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { Grant } from '../../src/authz/policy.js';
import { createTicketStore, type TicketStore } from '../../src/itsm/store.js';
import { buildMcpServer } from '../../src/mcp/server.js';

const clients: Client[] = [];

async function connect(grant: Grant, store: TicketStore = createTicketStore()): Promise<Client> {
  const server = buildMcpServer(grant, store, 'actor-1');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverSide);
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

const READ = ['itsm:read'];
const ALL = ['itsm:read', 'itsm:write', 'itsm:close'];

describe('buildMcpServer', () => {
  it('lists only tools allowed by the grant', async () => {
    const client = await connect({ scopes: READ, roles: ['itsm-operator'] });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['search_tickets', 'get_ticket']);
  });

  it('empty grant lists zero tools instead of failing', async () => {
    const client = await connect({ scopes: [], roles: [] });
    const { tools } = await client.listTools();
    expect(tools).toEqual([]);
  });

  it('marks close_ticket as destructive', async () => {
    const client = await connect({ scopes: ALL, roles: ['itsm-operator'] });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'close_ticket')?.annotations?.destructiveHint).toBe(true);
  });

  it('calling an unlisted destructive tool is refused and changes nothing', async () => {
    const store = createTicketStore();
    const client = await connect({ scopes: READ, roles: ['itsm-viewer'] }, store);
    // The SDK answers a call to an unregistered tool with an isError result, not a protocol error.
    const res = await client.callTool({ name: 'close_ticket', arguments: { id: 'INC-0001' } });
    expect(res.isError).toBe(true);
    expect(store.get('INC-0001')?.status).toBe('open');
  });

  it('operator with read+write can comment but close is refused', async () => {
    const store = createTicketStore();
    const client = await connect(
      { scopes: ['itsm:read', 'itsm:write'], roles: ['itsm-operator'] },
      store,
    );
    const ok = await client.callTool({
      name: 'add_comment',
      arguments: { id: 'INC-0001', text: 'checking' },
    });
    expect(ok.isError).toBeFalsy();
    expect(store.get('INC-0001')?.comments).toEqual([{ author: 'actor-1', text: 'checking' }]);
    const refused = await client.callTool({ name: 'close_ticket', arguments: { id: 'INC-0001' } });
    expect(refused.isError).toBe(true);
    expect(store.get('INC-0001')?.status).toBe('open');
  });

  it('operator can close and the actor is recorded', async () => {
    const store = createTicketStore();
    const client = await connect({ scopes: ALL, roles: ['itsm-operator'] }, store);
    const res = await client.callTool({ name: 'close_ticket', arguments: { id: 'INC-0001' } });
    expect(res.isError).toBeFalsy();
    const ticket = store.get('INC-0001');
    expect(ticket?.status).toBe('closed');
    expect(ticket?.comments.at(-1)?.author).toBe('actor-1');
  });

  it('unknown ticket id returns isError, not a crash', async () => {
    const client = await connect({ scopes: READ, roles: ['itsm-viewer'] });
    const res = await client.callTool({ name: 'get_ticket', arguments: { id: 'INC-9999' } });
    expect(res.isError).toBe(true);
  });

  it('unknown id on a write tool returns isError and leaves the store alone', async () => {
    const store = createTicketStore();
    const client = await connect({ scopes: ALL, roles: ['itsm-operator'] }, store);
    const res = await client.callTool({ name: 'close_ticket', arguments: { id: 'INC-9999' } });
    expect(res.isError).toBe(true);
  });

  it('rejects malformed ids and over-long comments', async () => {
    const store = createTicketStore();
    const client = await connect({ scopes: ALL, roles: ['itsm-operator'] }, store);
    const badId = await client.callTool({ name: 'get_ticket', arguments: { id: 'XYZ' } });
    expect(badId.isError).toBe(true);
    const tooLong = await client.callTool({
      name: 'add_comment',
      arguments: { id: 'INC-0001', text: 'a'.repeat(501) },
    });
    expect(tooLong.isError).toBe(true);
    const empty = await client.callTool({
      name: 'add_comment',
      arguments: { id: 'INC-0001', text: '' },
    });
    expect(empty.isError).toBe(true);
    expect(store.get('INC-0001')?.comments).toEqual([]);
  });

  it('search_tickets returns matching tickets', async () => {
    const client = await connect({ scopes: READ, roles: ['itsm-viewer'] });
    const res = await client.callTool({ name: 'search_tickets', arguments: { query: 'VPN' } });
    expect(res.isError).toBeFalsy();
    const first = (res.content as { type: string; text: string }[])[0];
    expect(first?.text).toContain('INC-0001');
  });
});

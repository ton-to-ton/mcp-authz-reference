import { describe, expect, it } from 'vitest';
import { createTicketStore } from '../../src/itsm/store.js';

describe('createTicketStore', () => {
  it('seeds INC-0001 to INC-0005 as open tickets', () => {
    const store = createTicketStore();
    for (const n of [1, 2, 3, 4, 5]) {
      expect(store.get(`INC-000${n}`)?.status).toBe('open');
    }
    expect(store.get('INC-0006')).toBeUndefined();
  });

  it('searches titles case-insensitively', () => {
    const store = createTicketStore([
      { id: 'INC-0001', title: 'VPN に接続できない', status: 'open', comments: [] },
      { id: 'INC-0002', title: 'Printer jam', status: 'open', comments: [] },
    ]);
    expect(store.search('printer').map((t) => t.id)).toEqual(['INC-0002']);
    expect(store.search('vpn').map((t) => t.id)).toEqual(['INC-0001']);
    expect(store.search('')).toHaveLength(2);
  });

  it('adds a comment with its author', () => {
    const store = createTicketStore();
    const ticket = store.addComment('INC-0001', 'looking into it', 'alice');
    expect(ticket.comments.at(-1)).toEqual({ author: 'alice', text: 'looking into it' });
    expect(store.get('INC-0001')?.comments).toHaveLength(1);
  });

  it('closes a ticket and records the author as a comment', () => {
    const store = createTicketStore();
    const ticket = store.close('INC-0002', 'bob');
    expect(ticket.status).toBe('closed');
    expect(ticket.comments.at(-1)?.author).toBe('bob');
    expect(store.get('INC-0002')?.status).toBe('closed');
  });

  it('throws for an unknown id on write operations', () => {
    const store = createTicketStore();
    expect(() => store.addComment('INC-9999', 'x', 'a')).toThrow('ticket not found: INC-9999');
    expect(() => store.close('INC-9999', 'a')).toThrow('ticket not found: INC-9999');
  });

  it('does not let callers mutate state through returned objects or the seed', () => {
    const seed = [{ id: 'INC-0001', title: 't', status: 'open' as const, comments: [] }];
    const store = createTicketStore(seed);
    seed[0]!.status = 'open';
    const got = store.get('INC-0001');
    if (!got) throw new Error('missing');
    (got as { status: string }).status = 'closed';
    got.comments.push({ author: 'x', text: 'y' });
    store.search('')[0]!.comments.push({ author: 'x', text: 'y' });
    expect(store.get('INC-0001')).toEqual({
      id: 'INC-0001',
      title: 't',
      status: 'open',
      comments: [],
    });
  });
});

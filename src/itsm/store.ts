export type Ticket = {
  id: string;
  title: string;
  status: 'open' | 'closed';
  comments: { author: string; text: string }[];
};

export interface TicketStore {
  search(query: string): Ticket[];
  get(id: string): Ticket | undefined;
  addComment(id: string, text: string, author: string): Ticket;
  close(id: string, author: string): Ticket;
}

const DEFAULT_SEED: readonly Ticket[] = [
  { id: 'INC-0001', title: 'VPN に接続できない', status: 'open', comments: [] },
  { id: 'INC-0002', title: 'メールが送信できない', status: 'open', comments: [] },
  { id: 'INC-0003', title: '共有フォルダにアクセスできない', status: 'open', comments: [] },
  { id: 'INC-0004', title: 'パスワードの有効期限が切れた', status: 'open', comments: [] },
  { id: 'INC-0005', title: 'プリンターが印刷できない', status: 'open', comments: [] },
];

// Callers get copies, so the only way to change a ticket is through the store's methods.
const copy = (ticket: Ticket): Ticket => structuredClone(ticket);

export function createTicketStore(seed: readonly Ticket[] = DEFAULT_SEED): TicketStore {
  const tickets = new Map(seed.map((t) => [t.id, copy(t)]));

  const mustGet = (id: string): Ticket => {
    const ticket = tickets.get(id);
    if (!ticket) throw new Error(`ticket not found: ${id}`);
    return ticket;
  };

  return {
    search(query) {
      const needle = query.toLowerCase();
      return [...tickets.values()].filter((t) => t.title.toLowerCase().includes(needle)).map(copy);
    },
    get(id) {
      const ticket = tickets.get(id);
      return ticket && copy(ticket);
    },
    addComment(id, text, author) {
      const ticket = mustGet(id);
      ticket.comments.push({ author, text });
      return copy(ticket);
    },
    close(id, author) {
      const ticket = mustGet(id);
      ticket.status = 'closed';
      ticket.comments.push({ author, text: 'closed' });
      return copy(ticket);
    },
  };
}

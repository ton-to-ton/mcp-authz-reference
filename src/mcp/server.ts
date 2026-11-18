import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type Grant, type ToolName, isAllowed } from '../authz/policy.js';
import type { TicketStore } from '../itsm/store.js';

const ticketId = z.string().regex(/^INC-\d{4}$/);
const commentText = z.string().min(1).max(500);

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
const fail = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

export function buildMcpServer(grant: Grant, store: TicketStore, actor: string): McpServer {
  // Declared up front: the SDK only announces `tools` once a tool is registered, and a client
  // holding an empty grant must still get an empty tools/list instead of "method not found".
  const server = new McpServer(
    { name: 'itsm-lab', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // Registration filters tools/list; the handler check is the second line of defence.
  const guarded = (tool: ToolName, run: () => CallToolResult): CallToolResult => {
    if (!isAllowed(tool, grant)) return fail(`not permitted: ${tool}`);
    try {
      return run();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  if (isAllowed('search_tickets', grant)) {
    server.registerTool(
      'search_tickets',
      {
        description: 'Search tickets by title. An empty query returns all tickets.',
        inputSchema: { query: z.string().max(200) },
      },
      ({ query }) => guarded('search_tickets', () => ok(store.search(query))),
    );
  }

  if (isAllowed('get_ticket', grant)) {
    server.registerTool(
      'get_ticket',
      { description: 'Get one ticket by id.', inputSchema: { id: ticketId } },
      ({ id }) =>
        guarded('get_ticket', () => {
          const ticket = store.get(id);
          return ticket ? ok(ticket) : fail(`ticket not found: ${id}`);
        }),
    );
  }

  if (isAllowed('add_comment', grant)) {
    server.registerTool(
      'add_comment',
      {
        description: 'Add a comment to a ticket.',
        inputSchema: { id: ticketId, text: commentText },
      },
      ({ id, text }) => guarded('add_comment', () => ok(store.addComment(id, text, actor))),
    );
  }

  if (isAllowed('close_ticket', grant)) {
    server.registerTool(
      'close_ticket',
      {
        description: 'Close a ticket. This cannot be undone.',
        inputSchema: { id: ticketId },
        annotations: { destructiveHint: true },
      },
      ({ id }) => guarded('close_ticket', () => ok(store.close(id, actor))),
    );
  }

  return server;
}

import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { grantFromAuth } from './auth/verify.js';
import type { Config } from './config.js';
import type { TicketStore } from './itsm/store.js';
import { buildMcpServer } from './mcp/server.js';

export type AppDeps = {
  config: Config;
  verifier: OAuthTokenVerifier;
  store: TicketStore;
  // Receives one JSON line per MCP message. Injectable so tests can capture it.
  log?: (line: string) => void;
};

const SCOPES_SUPPORTED = ['itsm:read', 'itsm:write', 'itsm:close'];

const actorSchema = z.object({ sub: z.string() });

// Only the fields worth logging; anything else in the message is ignored.
const messageSchema = z.object({
  method: z.string().optional(),
  params: z.object({ name: z.string().optional() }).optional(),
});

const stdoutLine = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: '2.0',
  error: { code, message },
  id: null,
});

// body-parser reports its failures as http-errors with a 4xx status and `expose: true`.
const bodyParserStatus = (err: unknown): number | undefined => {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, expose } = err as { status?: unknown; expose?: unknown };
  return expose === true && typeof status === 'number' && status >= 400 && status < 500
    ? status
    : undefined;
};

// Fixed text per status: the library's own message is never sent to the client.
const bodyErrorResponse = (status: number): ReturnType<typeof jsonRpcError> => {
  if (status === 400) return jsonRpcError(-32700, 'Parse error');
  if (status === 413) return jsonRpcError(-32600, 'Payload too large');
  return jsonRpcError(-32600, 'Invalid request');
};

export function createApp(deps: AppDeps): express.Express {
  const { config, verifier, store, log = stdoutLine } = deps;
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(config.resource);

  const app = express();
  app.disable('x-powered-by');

  // One hand-written route instead of the SDK's mcpAuthMetadataRouter: that router also serves
  // /.well-known/oauth-authorization-server, which would publish whatever host this server uses
  // internally. Clients fetch authorization server metadata from the issuer directly.
  app.get(new URL(resourceMetadataUrl).pathname, (_req, res) => {
    res.json({
      resource: config.resource.href,
      authorization_servers: [config.issuer],
      scopes_supported: SCOPES_SUPPORTED,
      resource_name: 'ITSM lab',
    });
  });

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.set('Allow', 'POST').status(405).json(jsonRpcError(-32000, 'Method not allowed.'));
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  app.post(
    '/mcp',
    requireBearerAuth({
      verifier,
      resourceMetadataUrl,
      expectedResource: config.resource,
    }),
    express.json(),
    async (req: Request & { auth?: AuthInfo }, res: Response) => {
      const { auth } = req;
      if (auth === undefined) {
        throw new Error('requireBearerAuth did not set req.auth');
      }
      const grant = grantFromAuth(auth);
      const { sub } = actorSchema.parse(auth.extra);

      // Batched messages (older protocol versions) are logged one line each, so a tools/call
      // cannot hide behind another message.
      const body: unknown = req.body;
      for (const raw of Array.isArray(body) ? body : [body]) {
        const message = messageSchema.safeParse(raw);
        const method = message.success ? message.data.method : undefined;
        const tool = method === 'tools/call' ? message.data?.params?.name : undefined;
        log(JSON.stringify({ sub, azp: auth.clientId, scopes: auth.scopes, method, tool }));
      }

      const server = buildMcpServer(grant, store, sub);
      // Stateless: a fresh server and transport per request. JSON responses (no SSE) because
      // nothing here streams or pushes.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        server.close().catch((err: unknown) => {
          process.stderr.write(`failed to close MCP server: ${String(err)}\n`);
        });
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );

  // Express 5 forwards rejected async handlers here. Details go to stderr, never to the client.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const status = bodyParserStatus(err);
    if (status !== undefined) {
      res.status(status).json(bodyErrorResponse(status));
      return;
    }
    process.stderr.write(`unhandled error: ${err instanceof Error ? err.stack : String(err)}\n`);
    res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
  });

  return app;
}

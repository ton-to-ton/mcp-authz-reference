import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { CryptoKey, JWK } from 'jose';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { createVerifier } from '../src/auth/verify.js';
import type { Config } from '../src/config.js';
import { createTicketStore, type TicketStore } from '../src/itsm/store.js';

const ISSUER = 'http://localhost:8080/realms/itsm-lab';
const RESOURCE = 'http://localhost:3000/mcp';
const KID = 'test-key';
const PROTOCOL_VERSION = '2025-11-25';

// jwksUri deliberately uses the container-internal host: nothing the server publishes may contain it.
const config: Config = {
  issuer: ISSUER,
  resource: new URL(RESOURCE),
  jwksUri: new URL('http://keycloak:8080/realms/itsm-lab/protocol/openid-connect/certs'),
  port: 3000,
};

const initRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  },
};
const listRequest = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const callRequest = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('HTTP app', () => {
  let privateKey: CryptoKey;
  let foreignPrivateKey: CryptoKey;
  let jwks: ReturnType<typeof createLocalJWKSet>;

  let store: TicketStore;
  let logLines: string[];
  let app: Express;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    foreignPrivateKey = (await generateKeyPair('RS256')).privateKey;
    const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256' };
    jwks = createLocalJWKSet({ keys: [publicJwk] });
  });

  beforeEach(() => {
    store = createTicketStore();
    logLines = [];
    app = createApp({
      config,
      verifier: createVerifier({ issuer: ISSUER, resource: config.resource, jwks }),
      store,
      log: (line) => logLines.push(line),
    });
  });

  const now = (): number => Math.floor(Date.now() / 1000);

  const sign = (
    overrides: Record<string, unknown> = {},
    key: CryptoKey = privateKey,
  ): Promise<string> =>
    new SignJWT({
      iss: ISSUER,
      aud: RESOURCE,
      sub: 'user-1',
      azp: 'claude-code',
      scope: 'itsm:read',
      roles: ['itsm-viewer'],
      exp: now() + 300,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .sign(key);

  const viewerToken = (): Promise<string> => sign();
  const operatorToken = (): Promise<string> =>
    sign({ scope: 'itsm:read itsm:write itsm:close', roles: ['itsm-operator'] });

  // Each POST is independent (stateless transport), so the Accept header and protocol version go on every call.
  const post = (token: string | undefined, body: object) => {
    const req = request(app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-protocol-version', PROTOCOL_VERSION);
    return (token === undefined ? req : req.set('Authorization', `Bearer ${token}`)).send(body);
  };

  it('401 without token and points to protected resource metadata', async () => {
    const res = await post(undefined, initRequest);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      'resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('serves protected resource metadata naming the issuer', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      resource: RESOURCE,
      authorization_servers: [ISSUER],
      scopes_supported: ['itsm:read', 'itsm:write', 'itsm:close'],
      resource_name: 'ITSM lab',
    });
  });

  it('does not serve authorization server metadata', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(404);
  });

  it('never exposes the internal Keycloak host in metadata or 401 responses', async () => {
    const metadata = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    const unauthorized = await post(undefined, initRequest);
    const everything = JSON.stringify([
      metadata.text,
      unauthorized.text,
      unauthorized.headers['www-authenticate'],
    ]);
    expect(everything).not.toContain('keycloak:8080');
  });

  it('401 for token issued to another resource', async () => {
    const res = await post(await sign({ aud: 'http://localhost:3001/mcp' }), initRequest);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('401 (not 500) for an expired token', async () => {
    const res = await post(await sign({ exp: now() - 60 }), initRequest);
    expect(res.status).toBe(401);
  });

  it('401 (not 500) for a token signed with a foreign key', async () => {
    const res = await post(await sign({}, foreignPrivateKey), initRequest);
    expect(res.status).toBe(401);
  });

  // Claim-shape failures once put multiline zod text into WWW-Authenticate, which Node rejects (500).
  it.each([
    ['missing azp', { azp: undefined }],
    ['roles as a string', { roles: 'itsm-operator' }],
  ])(
    '401 with WWW-Authenticate for a correctly signed token with %s, store unchanged',
    async (_name, claims) => {
      const token = await sign({
        scope: 'itsm:read itsm:write itsm:close',
        roles: ['itsm-operator'],
        ...claims,
      });
      const res = await post(token, callRequest('close_ticket', { id: 'INC-0001' }));
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
      expect(res.headers['www-authenticate']).toContain('resource_metadata=');
      expect(store.get('INC-0001')?.status).toBe('open');
    },
  );

  describe('when the JWKS endpoint is down', () => {
    afterEach(() => vi.restoreAllMocks());

    it('answers 500 without details, not 401, and does not change the store', async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const brokenApp = createApp({
        config,
        verifier: createVerifier({
          issuer: ISSUER,
          resource: config.resource,
          jwks: () => Promise.reject(new errors.JOSEError('Expected 200 OK from keycloak:8080')),
        }),
        store,
        log: (line) => logLines.push(line),
      });
      const token = await sign({
        scope: 'itsm:read itsm:write itsm:close',
        roles: ['itsm-operator'],
      });
      const res = await request(brokenApp)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Authorization', `Bearer ${token}`)
        .send(callRequest('close_ticket', { id: 'INC-0001' }));
      expect(res.status).toBe(500);
      expect(res.headers['www-authenticate']).toBeUndefined();
      expect(res.text).not.toContain('keycloak');
      expect(res.text).not.toContain('Expected 200 OK');
      expect(store.get('INC-0001')?.status).toBe('open');
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain(
        'Expected 200 OK',
      );
    });
  });

  it('accepts a token whose aud array contains the resource', async () => {
    const res = await post(await sign({ aud: ['account', RESOURCE] }), initRequest);
    expect(res.status).toBe(200);
    expect(res.body.result.serverInfo.name).toBe('itsm-lab');
  });

  it('tools/list over HTTP is filtered by grant', async () => {
    const token = await viewerToken();
    const init = await post(token, initRequest);
    expect(init.status).toBe(200);
    const list = await post(token, listRequest);
    expect(list.status).toBe(200);
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'search_tickets',
      'get_ticket',
    ]);
  });

  it('tools/list for an operator shows all four tools', async () => {
    const list = await post(await operatorToken(), listRequest);
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'search_tickets',
      'get_ticket',
      'add_comment',
      'close_ticket',
    ]);
  });

  it('direct tools/call of close_ticket with a viewer token is refused and the ticket stays open', async () => {
    const res = await post(await viewerToken(), callRequest('close_ticket', { id: 'INC-0001' }));
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(store.get('INC-0001')?.status).toBe('open');
  });

  it('tools/call of close_ticket with an operator token closes the ticket as the token subject', async () => {
    const token = await sign({
      sub: 'operator-1',
      scope: 'itsm:read itsm:write itsm:close',
      roles: ['itsm-operator'],
    });
    const res = await post(token, callRequest('close_ticket', { id: 'INC-0001' }));
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeUndefined();
    expect(store.get('INC-0001')).toMatchObject({
      status: 'closed',
      comments: [{ author: 'operator-1', text: 'closed' }],
    });
  });

  it('answers GET and DELETE /mcp with 405', async () => {
    const token = await viewerToken();
    const get = await request(app).get('/mcp').set('Authorization', `Bearer ${token}`);
    const del = await request(app).delete('/mcp').set('Authorization', `Bearer ${token}`);
    expect(get.status).toBe(405);
    expect(del.status).toBe(405);
  });

  it('answers malformed JSON with a 400 JSON-RPC parse error', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${await viewerToken()}`)
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32700);
  });

  it('answers an oversized body with a 413 JSON-RPC error and no details', async () => {
    const res = await post(await viewerToken(), {
      ...initRequest,
      params: { ...initRequest.params, padding: 'x'.repeat(200_000) },
    });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Payload too large' },
      id: null,
    });
    expect(logLines).toEqual([]);
  });

  it('answers an unsupported charset with 415, not 500', async () => {
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${await viewerToken()}`)
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json; charset=x-bogus')
      .send('{}');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe(-32600);
  });

  describe('request log', () => {
    it('writes one JSON line per request with sub, azp, scopes and method', async () => {
      await post(await viewerToken(), listRequest);
      expect(logLines).toHaveLength(1);
      expect(JSON.parse(logLines[0] ?? '')).toEqual({
        sub: 'user-1',
        azp: 'claude-code',
        scopes: ['itsm:read'],
        method: 'tools/list',
      });
    });

    it('records the tool name only for tools/call', async () => {
      await post(await operatorToken(), callRequest('get_ticket', { id: 'INC-0001' }));
      expect(JSON.parse(logLines[0] ?? '')).toMatchObject({
        method: 'tools/call',
        tool: 'get_ticket',
      });
    });

    it('never contains the token value', async () => {
      const token = await operatorToken();
      await post(token, initRequest);
      await post(token, callRequest('close_ticket', { id: 'INC-0002' }));
      expect(logLines.length).toBeGreaterThan(0);
      const [header, payload, signature] = token.split('.');
      for (const line of logLines) {
        expect(line).not.toContain(token);
        for (const part of [header, payload, signature]) {
          expect(line).not.toContain(part);
        }
      }
    });

    it('writes nothing for a rejected request', async () => {
      await post(undefined, initRequest);
      expect(logLines).toEqual([]);
    });
  });
});

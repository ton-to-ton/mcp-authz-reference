import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from 'jose';
import type { CryptoKey, JWK, JWTVerifyGetKey } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createVerifier, grantFromAuth } from '../../src/auth/verify.js';

const ISSUER = 'http://localhost:8080/realms/itsm-lab';
const RESOURCE = 'http://localhost:3000/mcp';
const KID = 'test-key';

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('createVerifier', () => {
  let privateKey: CryptoKey;
  let foreignPrivateKey: CryptoKey;
  let verifier: ReturnType<typeof createVerifier>;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    foreignPrivateKey = (await generateKeyPair('RS256')).privateKey;
    const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256' };
    verifier = createVerifier({
      issuer: ISSUER,
      resource: new URL(RESOURCE),
      jwks: createLocalJWKSet({ keys: [publicJwk] }),
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

  it('accepts aud array that contains the resource and reports it', async () => {
    const token = await sign({ aud: ['account', RESOURCE] });
    const info = await verifier.verifyAccessToken(token);
    expect(info.token).toBe(token);
    expect(info.clientId).toBe('claude-code');
    expect(info.resource?.href).toBe(RESOURCE);
    expect(info.scopes).toEqual(['itsm:read']);
    expect(info.expiresAt).toBeTypeOf('number');
    expect(info.extra).toEqual({ sub: 'user-1', roles: ['itsm-viewer'] });
    expect(grantFromAuth(info)).toEqual({ scopes: ['itsm:read'], roles: ['itsm-viewer'] });
  });

  it('rejects token for another resource', async () => {
    await expect(
      verifier.verifyAccessToken(await sign({ aud: 'http://localhost:3001/mcp' })),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  describe('rejects with InvalidTokenError', () => {
    it('wrong issuer', async () => {
      await expect(
        verifier.verifyAccessToken(await sign({ iss: 'http://evil.example/realms/itsm-lab' })),
      ).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('expired token', async () => {
      await expect(
        verifier.verifyAccessToken(await sign({ exp: now() - 60 })),
      ).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('token signed with a foreign key', async () => {
      await expect(
        verifier.verifyAccessToken(await sign({}, foreignPrivateKey)),
      ).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('alg none', async () => {
      const unsigned = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({
        iss: ISSUER,
        aud: RESOURCE,
        sub: 'user-1',
        azp: 'claude-code',
        scope: 'itsm:read itsm:close',
        roles: ['itsm-operator'],
        exp: now() + 300,
      })}.`;
      await expect(verifier.verifyAccessToken(unsigned)).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('malformed claims (scope is not a string)', async () => {
      await expect(
        verifier.verifyAccessToken(await sign({ scope: ['itsm:read'] })),
      ).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('not a JWT at all', async () => {
      await expect(verifier.verifyAccessToken('garbage')).rejects.toBeInstanceOf(InvalidTokenError);
    });
  });

  // The SDK copies the message into the WWW-Authenticate header, where a newline or a quote makes
  // Node reject the header (500 instead of 401). Messages must be fixed, header-safe strings.
  describe('InvalidTokenError messages are header-safe', () => {
    const headerSafe = /^[A-Za-z0-9 ,.:_-]+$/;
    const cases: [string, () => Promise<string>][] = [
      ['missing azp claim', () => sign({ azp: undefined })],
      ['roles is a string', () => sign({ roles: 'itsm-operator' })],
      ['scope is not a string', () => sign({ scope: ['itsm:read'] })],
      ['expired token', () => sign({ exp: now() - 60 })],
      ['foreign key', () => sign({}, foreignPrivateKey)],
      ['garbage', () => Promise.resolve('garbage')],
    ];
    it.each(cases)('%s', async (_name, makeToken) => {
      const err: unknown = await verifier.verifyAccessToken(await makeToken()).catch((e) => e);
      expect(err).toBeInstanceOf(InvalidTokenError);
      expect((err as InvalidTokenError).message).toMatch(headerSafe);
    });
  });

  // Only token problems are the caller's fault. A broken or unreachable key source is ours:
  // it must surface (the SDK turns it into a 500) instead of telling clients their token is bad.
  describe('key source failures are not reported as invalid tokens', () => {
    afterEach(() => vi.restoreAllMocks());

    const failing =
      (err: Error): JWTVerifyGetKey =>
      () =>
        Promise.reject(err);
    const cases: [string, Error][] = [
      ['JWKSTimeout', new errors.JWKSTimeout()],
      ['JWKSInvalid', new errors.JWKSInvalid('JSON Web Key Set malformed')],
      ['JOSEError (non-200 JWKS response)', new errors.JOSEError('Expected 200 OK')],
      ['fetch failure', new TypeError('fetch failed')],
    ];
    it.each(cases)('%s propagates', async (_name, err) => {
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const broken = createVerifier({
        issuer: ISSUER,
        resource: new URL(RESOURCE),
        jwks: failing(err),
      });
      const rejection: unknown = await broken.verifyAccessToken(await sign()).catch((e) => e);
      expect(rejection).toBe(err);
      expect(rejection).not.toBeInstanceOf(InvalidTokenError);
    });

    it('a remote JWKS endpoint answering 503 propagates, and the failure is logged without the token', async () => {
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const server = createServer((_req, res) => res.writeHead(503).end());
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = server.address() as AddressInfo;
        const broken = createVerifier({
          issuer: ISSUER,
          resource: new URL(RESOURCE),
          jwks: createRemoteJWKSet(new URL(`http://127.0.0.1:${port}/certs`)),
        });
        const token = await sign();
        const rejection: unknown = await broken.verifyAccessToken(token).catch((e) => e);
        expect(rejection).toBeInstanceOf(errors.JOSEError);
        expect(rejection).not.toBeInstanceOf(InvalidTokenError);
        const logged = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
        expect(logged).toContain('Expected 200 OK');
        expect(logged).not.toContain(token);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  it('missing scope and roles claims give empty arrays', async () => {
    const info = await verifier.verifyAccessToken(
      await sign({ scope: undefined, roles: undefined }),
    );
    expect(grantFromAuth(info)).toEqual({ scopes: [], roles: [] });
  });

  it('ignores Keycloak-specific realm_access', async () => {
    const info = await verifier.verifyAccessToken(
      await sign({ roles: undefined, realm_access: { roles: ['itsm-operator'] } }),
    );
    expect(grantFromAuth(info).roles).toEqual([]);
  });
});

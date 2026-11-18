import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { CryptoKey, JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
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

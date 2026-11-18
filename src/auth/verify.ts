import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { errors, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { Grant } from '../authz/policy.js';

// Only standard claims plus a top-level `roles` array. IdP-specific shapes
// (e.g. Keycloak's realm_access) are deliberately not read.
const claimsSchema = z.object({
  sub: z.string(),
  azp: z.string(),
  exp: z.number(),
  aud: z.union([z.string(), z.array(z.string())]),
  scope: z.string().optional(),
  roles: z.array(z.string()).optional(),
});

const extraSchema = z.object({ sub: z.string(), roles: z.array(z.string()) });

export function createVerifier(opts: {
  issuer: string;
  resource: URL;
  jwks: JWTVerifyGetKey;
}): OAuthTokenVerifier {
  const { issuer, resource, jwks } = opts;
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, jwks, {
          issuer,
          audience: resource.href,
          algorithms: ['RS256'],
        }));
      } catch (cause) {
        // Only token problems become 401. Anything else (a bug, a JWKS fetch
        // failure that is not a JOSE error) must surface instead of masquerading
        // as an invalid token.
        if (cause instanceof errors.JOSEError) {
          throw new InvalidTokenError(`invalid access token: ${cause.message}`);
        }
        throw cause;
      }

      const claims = claimsSchema.safeParse(payload);
      if (!claims.success) {
        throw new InvalidTokenError(`invalid access token claims: ${claims.error.message}`);
      }
      const { sub, azp, exp, aud, scope, roles } = claims.data;
      const audiences = typeof aud === 'string' ? [aud] : aud;
      const matched = audiences.find((a) => a === resource.href);
      if (matched === undefined) {
        throw new InvalidTokenError('access token audience does not include this resource');
      }

      return {
        token,
        clientId: azp,
        scopes: scope === undefined ? [] : scope.split(/\s+/).filter((s) => s.length > 0),
        expiresAt: exp,
        resource: new URL(matched),
        extra: { sub, roles: roles ?? [] },
      };
    },
  };
}

// AuthInfo always comes from createVerifier, so a malformed `extra` is a wiring bug: fail loudly
// rather than quietly treating the caller as role-less.
export function grantFromAuth(auth: AuthInfo): Grant {
  const extra = extraSchema.parse(auth.extra);
  return { scopes: auth.scopes, roles: extra.roles };
}

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

// Failures that are the token's fault. jose also throws JOSEError subclasses for a broken or
// unreachable key source (JWKSTimeout, JWKSInvalid, JWKInvalid, a bare JOSEError for a non-200 or
// non-JSON JWKS response); those are ours, so they are deliberately absent and propagate as 500.
// JOSENotSupported covers an unsupported `crit` header (token) and cannot be told apart from an
// unusable JWKS key; the former is far likelier, so it stays here.
const TOKEN_ERRORS = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWSSignatureVerificationFailed,
  errors.JWSInvalid,
  errors.JWTInvalid,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
] as const;

const isTokenError = (cause: unknown): boolean =>
  TOKEN_ERRORS.some((errorClass) => cause instanceof errorClass);

// The SDK copies InvalidTokenError messages into the WWW-Authenticate header, so they must be
// fixed, header-safe strings: library or zod text can contain quotes and newlines, which Node
// refuses to put in a header (a 500 instead of the 401).
const INVALID_TOKEN = 'invalid access token';
const INVALID_CLAIMS = 'invalid access token claims';
const WRONG_AUDIENCE = 'access token audience does not include this resource';

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
        if (isTokenError(cause)) {
          throw new InvalidTokenError(INVALID_TOKEN);
        }
        // Not the caller's fault (JWKS outage, bug). The SDK middleware turns it into a bare 500
        // and logs nothing, so the cause is logged here. It never contains the token.
        process.stderr.write(`access token verification failed: ${String(cause)}\n`);
        throw cause;
      }

      const claims = claimsSchema.safeParse(payload);
      if (!claims.success) {
        throw new InvalidTokenError(INVALID_CLAIMS);
      }
      const { sub, azp, exp, aud, scope, roles } = claims.data;
      const audiences = typeof aud === 'string' ? [aud] : aud;
      const matched = audiences.find((a) => a === resource.href);
      if (matched === undefined) {
        throw new InvalidTokenError(WRONG_AUDIENCE);
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

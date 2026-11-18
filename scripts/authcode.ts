import { createHash, randomBytes } from 'node:crypto';

const REALM_URL = 'http://localhost:8080/realms/itsm-lab/protocol/openid-connect';
const CLIENT_ID = 'claude-code';
const REDIRECT_URI = 'http://localhost:33418/callback';

export type AuthCodeOptions = {
  user: string;
  password: string;
  scope: string;
  /** RFC 8707 `resource` on the authorization request. */
  authResource?: string;
  /** RFC 8707 `resource` on the token request. */
  tokenResource?: string;
};

export type AuthCodeResult = { status: number; body: unknown };

const base64url = (buf: Buffer): string => buf.toString('base64url');

// A tiny cookie jar: Keycloak's login form is bound to cookies set while rendering it.
class CookieJar {
  readonly #cookies = new Map<string, string>();

  store(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq > 0) this.#cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }

  header(): string {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

const decodeHtml = (s: string): string =>
  s.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(jar: CookieJar, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    redirect: 'manual',
    headers: { ...(init.headers as Record<string, string> | undefined), cookie: jar.header() },
  });
  jar.store(res);
  return res;
}

// What an authorization-endpoint failure looks like: an error redirect to the client, or an HTML
// error page. Either way the caller gets the status and the evidence, not an exception.
function authorizationFailure(
  res: Response,
  location: string | null,
  text: string,
): AuthCodeResult {
  if (location?.startsWith(REDIRECT_URI)) {
    const params = Object.fromEntries(new URL(location).searchParams);
    return { status: res.status, body: { stage: 'authorization', redirect: params } };
  }
  return {
    status: res.status,
    body: { stage: 'authorization', location, page: text.slice(0, 500) },
  };
}

// Authorization Code + PKCE (S256) for the public client `claude-code`, driving Keycloak's HTML login
// form with fetch. No browser; the redirect to localhost:33418 is read from the Location header and
// never followed.
export async function authorizationCodeToken(opts: AuthCodeOptions): Promise<AuthCodeResult> {
  const jar = new CookieJar();
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(12));

  const authUrl = new URL(`${REALM_URL}/auth`);
  authUrl.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: opts.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(opts.authResource === undefined ? {} : { resource: opts.authResource }),
  }).toString();

  const loginPage = await request(jar, authUrl.toString());
  const loginHtml = await loginPage.text();
  if (loginPage.status !== 200) {
    return authorizationFailure(loginPage, loginPage.headers.get('location'), loginHtml);
  }
  const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(loginHtml)?.[1];
  if (action === undefined) {
    throw new Error(`no login form in the authorization response: ${loginHtml.slice(0, 300)}`);
  }

  const submitted = await request(jar, decodeHtml(action), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: opts.user, password: opts.password, credentialId: '' }),
  });
  const location = submitted.headers.get('location');
  if (submitted.status !== 302 || location === null || !location.startsWith(REDIRECT_URI)) {
    return authorizationFailure(submitted, location, await submitted.text());
  }
  const redirected = new URL(location).searchParams;
  if (redirected.get('state') !== state)
    throw new Error('state mismatch in the authorization response');
  const code = redirected.get('code');
  if (code === null) return authorizationFailure(submitted, location, '');

  const tokenRes = await fetch(`${REALM_URL}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      ...(opts.tokenResource === undefined ? {} : { resource: opts.tokenResource }),
    }),
  });
  return { status: tokenRes.status, body: parseBody(await tokenRes.text()) };
}

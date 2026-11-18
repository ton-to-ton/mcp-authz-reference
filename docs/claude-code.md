# Connecting Claude Code

This walks through connecting Claude Code to the lab server and checking that the tools you see
depend on the scopes you request and on the user who logs in.

Status: the configuration below was checked to be accepted by Claude Code 2.1.319 (see "What was
verified"). The full walkthrough, including the tool counts, has not been run by hand yet. The
"Verified on" table in the [README](../README.md) tracks that.

## Prerequisites

```sh
docker compose up -d --wait
```

Keycloak is at `http://localhost:8080` and the MCP server at `http://localhost:3000/mcp`. The login
users are `alice` (operator) and `bob` (viewer). Their test-only passwords are in `.env.example`.

## Connect with a pre-registered client

The realm has a public client `claude-code` with PKCE (S256) and the redirect URI
`http://localhost:33418/callback`.

```sh
claude mcp add --transport http itsm http://localhost:3000/mcp \
  --client-id claude-code --callback-port 33418
```

Then start `claude`, run `/mcp`, and authenticate the `itsm` server. A browser opens on the Keycloak
login page.

This form does not set the scopes to request. `claude mcp add` has no scope option for OAuth (its
`--scope` flag is the configuration scope: local, user or project). Pin the OAuth scopes with the
`oauth.scopes` setting instead.

## Request scopes explicitly

Claude Code's documentation section
["Restrict OAuth scopes"](https://code.claude.com/docs/en/mcp#restrict-oauth-scopes) describes
`oauth.scopes`: a single space-separated string that Claude Code requests during authorization. It
takes precedence over the scopes the server advertises. Define two entries, one per setting:

```sh
# read only
claude mcp add-json itsm-read '{"type":"http","url":"http://localhost:3000/mcp","oauth":{"clientId":"claude-code","callbackPort":33418,"scopes":"itsm:read"}}'

# everything
claude mcp add-json itsm-all '{"type":"http","url":"http://localhost:3000/mcp","oauth":{"clientId":"claude-code","callbackPort":33418,"scopes":"itsm:read itsm:write itsm:close"}}'
```

The same blocks work in `.mcp.json` under `mcpServers`. Use one of the two entries at a time (they
share the callback port), and remove the plain `itsm` entry from the previous section so it does not
confuse you:

```sh
claude mcp remove itsm
```

If you prefer a single entry, edit its `oauth.scopes` and authenticate again from `/mcp`. Per the
documentation, Claude Code requests the pinned scopes, so changing the setting without
re-authenticating leaves the old token in place.

## What you should see

Log in as `alice` or `bob` in the browser each time. To switch user, authenticate again (you may
need to log out of Keycloak in the browser first, or use a private window).

| User  | Scopes requested                  | Tools visible | Which                                                    |
| ----- | --------------------------------- | ------------- | -------------------------------------------------------- |
| alice | `itsm:read`                       | 2             | `search_tickets`, `get_ticket`                           |
| alice | `itsm:read itsm:write itsm:close` | 4             | the two above, `add_comment`, `close_ticket`             |
| bob   | `itsm:read`                       | 2             | `search_tickets`, `get_ticket`                           |
| bob   | `itsm:read itsm:write itsm:close` | 2             | `search_tickets`, `get_ticket` (the viewer role caps it) |

The server enforces this on `tools/list` and again on every `tools/call`, so a client that guesses
a tool name still gets an error. The e2e tests in `test/e2e/authz.e2e.test.ts` assert the same
counts with tokens taken directly from Keycloak.

## Requested scopes and granted scopes are different things

What Claude Code sends in the authorization request is the requested scope. What ends up in the
access token is the granted scope. Keycloak only grants the optional client scopes it knows and the
client is allowed to use, so the two can differ.

- Requested: visible in the `scope` parameter of the login URL in the browser.
- Granted: the `scope` claim of the token. The server logs it, one JSON line per MCP message:

```sh
docker compose logs itsm-mcp
```

Each line has `sub`, `azp` (the client; expect `claude-code`), `scopes` (the granted scopes),
`method` and, for tool calls, `tool`. Check the `scopes` field, not your configuration, when you
want to know what a token could do. Roles are not logged.

## Why scopes matter here

Each `itsm:*` scope has an audience mapper in Keycloak, so requesting one of them is what puts
`http://localhost:3000/mcp` into the token's `aud`. If Claude Code requests no `itsm:*` scope, the
token has no matching `aud` and every call is answered with 401.

Last-resort fallback, if a Claude Code version cannot be made to request the scopes: in the Keycloak
admin console, make the three `itsm:*` scopes Default (instead of Optional) on the `claude-code`
client. Every token then carries all three scopes and `aud`. The cost is that only the user's role
limits the tools; the scope step no longer narrows anything.

## Client registration: pre-registered now, CIMD later

Keycloak's guide for Claude Code recommends Client ID Metadata Documents (CIMD) rather than a
pre-registered client. This milestone uses a pre-registered client because it needs no extra
Keycloak feature and works with the `--client-id` and `--callback-port` options above. CIMD is left
for a later verification.

## What was verified

On 2026-11-18, with Claude Code 2.1.319:

- `claude mcp add --help` lists `--client-id` and `--callback-port` but no option for OAuth scopes.
- `claude mcp add-json` accepted
  `{"type":"http","url":"http://localhost:3000/mcp","oauth":{"clientId":"claude-code","callbackPort":33418,"scopes":"itsm:read"}}`,
  stored it, and `claude mcp get` showed the client ID and callback port. (The output does not show
  the scopes line.)
- The installed binary contains handling for `oauth.scopes`.
- The Claude Code documentation describes `oauth.scopes` as the way to pin requested scopes.

Not verified here: that Claude Code actually sends the pinned scopes to Keycloak, and the tool
counts in the table above. Both are part of the manual walkthrough still to be done.

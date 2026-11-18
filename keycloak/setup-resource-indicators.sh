#!/usr/bin/env bash
# Verification-only realm additions for docs/verification/2026-11-18-resource-indicators.md.
# Applied with kcadm to a RUNNING stack; deliberately not part of the committed realm export.
#
#   ./keycloak/setup-resource-indicators.sh [shared-scope | resource-indicators]
#
#   shared-scope         optional scope `shared:read` carrying BOTH custom audiences (3000 and 3001).
#                        The "scope-based workaround" weakness check (plan Task 6, Step 4).
#   resource-indicators  per the official guide: two resource-server clients with a `resource_url`
#                        attribute, plus Audience mappers (Included Client Audience) on claude-code.
#   (no argument)        both.
#
# Each section can be applied once per fresh realm (`docker compose down -v` resets it).
# COMPOSE_FILES picks the stack, e.g. COMPOSE_FILES="-f compose.yaml -f compose.resource-indicators.yaml".
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=.env.example
[ -f .env ] && ENV_FILE=.env
set -a
# shellcheck disable=SC1090
. "./${ENV_FILE}"
set +a

MODE=${1:-all}
case "$MODE" in all | shared-scope | resource-indicators) ;; *)
  echo "usage: $0 [shared-scope | resource-indicators]" >&2
  exit 2
  ;;
esac

COMPOSE_FILES=${COMPOSE_FILES:--f compose.yaml}
REALM=itsm-lab
MCP_URL=http://localhost:3000/mcp
OTHER_URL=http://localhost:3001/mcp

# shellcheck disable=SC2086
kc_container=$(docker compose $COMPOSE_FILES ps -q keycloak)
[ -n "$kc_container" ] || { echo "keycloak is not running; start the stack first" >&2; exit 1; }
kcadm() { docker exec "$kc_container" /opt/keycloak/bin/kcadm.sh "$@"; }

kcadm config credentials --server http://localhost:8080 --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null

client_uuid() { kcadm get clients -r "$REALM" -q "clientId=$1" --fields id --format csv --noquotes; }

add_audience_mapper() { # $1 client-scopes|clients  $2 uuid  $3 name  $4 config key  $5 audience
  kcadm create "$1/$2/protocol-mappers/models" -r "$REALM" \
    -s name="$3" -s protocol=openid-connect -s protocolMapper=oidc-audience-mapper \
    -s "config.\"$4\"=$5" \
    -s 'config."access.token.claim"=true' \
    -s 'config."id.token.claim"=false' \
    -s 'config."introspection.token.claim"=true' >/dev/null
}

if [ "$MODE" = all ] || [ "$MODE" = shared-scope ]; then
  scope_id=$(kcadm create client-scopes -r "$REALM" -i \
    -s name=shared:read -s protocol=openid-connect -s type=optional \
    -s 'attributes."include.in.token.scope"=true' \
    -s 'attributes."display.on.consent.screen"=true')
  add_audience_mapper client-scopes "$scope_id" audience-3000 included.custom.audience "$MCP_URL"
  add_audience_mapper client-scopes "$scope_id" audience-3001 included.custom.audience "$OTHER_URL"
  for client in claude-code lab-tester; do
    kcadm update "clients/$(client_uuid "$client")/optional-client-scopes/${scope_id}" -r "$REALM" -n
  done
  echo "shared:read created (audiences: $MCP_URL, $OTHER_URL)"
fi

if [ "$MODE" = all ] || [ "$MODE" = resource-indicators ]; then
  # Resource-server clients: the MCP servers as Keycloak sees them. `resource_url` is what an RFC 8707
  # `resource` parameter is matched against. Bearer-only is not needed; a plain client holds the attribute.
  for pair in "itsm-mcp-resource=$MCP_URL" "other-mcp-resource=$OTHER_URL"; do
    kcadm create clients -r "$REALM" -s clientId="${pair%%=*}" -s publicClient=false \
      -s standardFlowEnabled=false -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=false \
      -s "attributes.resource_url=${pair#*=}" >/dev/null
  done
  # The relying party (claude-code, and the ROPC test client) gets one Audience mapper per resource
  # server, using "Included Client Audience".
  for client in claude-code lab-tester; do
    uuid=$(client_uuid "$client")
    add_audience_mapper clients "$uuid" itsm-mcp-resource-audience included.client.audience itsm-mcp-resource
    add_audience_mapper clients "$uuid" other-mcp-resource-audience included.client.audience other-mcp-resource
  done
  echo "resource-server clients and Audience mappers created"
fi

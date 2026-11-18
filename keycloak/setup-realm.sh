#!/usr/bin/env bash
# Rebuilds keycloak/itsm-lab-realm.json: starts a throwaway Keycloak, configures it with kcadm.sh,
# then exports the realm with kc.sh. The JSON is generated, not hand-written, so Keycloak's built-in
# client scopes (profile, roles, ...) stay intact. Requires docker. Re-run after changing this file.
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE=.env.example
[ -f .env ] && ENV_FILE=.env
set -a
# shellcheck disable=SC1090
. "./${ENV_FILE}"
set +a

IMAGE=quay.io/keycloak/keycloak:26.8.2
NAME=itsm-lab-realm-setup
VOLUME="${NAME}-data"
REALM=itsm-lab
MCP_URL=http://localhost:3000/mcp
OTHER_URL=http://localhost:3001/mcp
OUT=keycloak/itsm-lab-realm.json

cleanup() {
  docker rm -f "$NAME" "${NAME}-export" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

kcadm() { docker exec "$NAME" /opt/keycloak/bin/kcadm.sh "$@"; }

docker volume create "$VOLUME" >/dev/null
docker run -d --name "$NAME" -v "${VOLUME}:/opt/keycloak/data" \
  -e KC_BOOTSTRAP_ADMIN_USERNAME -e KC_BOOTSTRAP_ADMIN_PASSWORD \
  "$IMAGE" start-dev >/dev/null

echo "waiting for Keycloak..."
for _ in $(seq 1 90); do
  if kcadm config credentials --server http://localhost:8080 --realm master \
    --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
[ "${ready:-0}" = 1 ] || { echo "Keycloak did not become ready" >&2; exit 1; }

kcadm create realms -s realm="$REALM" -s enabled=true

for role in itsm-viewer itsm-operator; do
  kcadm create roles -r "$REALM" -s name="$role"
done

# Test-only users. Profile fields are filled in so the login flow never asks for profile completion.
create_user() {
  local name=$1 first=$2 role=$3 password=$4
  kcadm create users -r "$REALM" -s username="$name" -s enabled=true -s emailVerified=true \
    -s email="${name}@example.test" -s firstName="$first" -s lastName=Lab
  kcadm set-password -r "$REALM" --username "$name" --new-password "$password"
  kcadm add-roles -r "$REALM" --uusername "$name" --rolename "$role"
}
create_user alice Alice itsm-operator "$ALICE_PASSWORD"
create_user bob Bob itsm-viewer "$BOB_PASSWORD"

# Optional client scope whose only job is to put one audience into the access token.
# $1 scope name, $2 audience. Prints the scope id.
create_audience_scope() {
  local id
  id=$(kcadm create client-scopes -r "$REALM" -i \
    -s name="$1" -s protocol=openid-connect -s type=optional \
    -s 'attributes."include.in.token.scope"=true' \
    -s 'attributes."display.on.consent.screen"=true')
  kcadm create "client-scopes/${id}/protocol-mappers/models" -r "$REALM" \
    -s name=audience -s protocol=openid-connect -s protocolMapper=oidc-audience-mapper \
    -s "config.\"included.custom.audience\"=$2" \
    -s 'config."access.token.claim"=true' \
    -s 'config."id.token.claim"=false' \
    -s 'config."introspection.token.claim"=true' >/dev/null
  echo "$id"
}
READ_ID=$(create_audience_scope itsm:read "$MCP_URL")
WRITE_ID=$(create_audience_scope itsm:write "$MCP_URL")
CLOSE_ID=$(create_audience_scope itsm:close "$MCP_URL")
OTHER_ID=$(create_audience_scope other:read "$OTHER_URL")

# Top-level `roles` claim (array of realm role names). A default scope, so every client gets it
# without asking. Type "default" also makes it a realm default for clients created later.
ROLES_SCOPE_ID=$(kcadm create client-scopes -r "$REALM" -i \
  -s name=itsm-roles -s protocol=openid-connect -s type=default \
  -s 'attributes."include.in.token.scope"=false' \
  -s 'attributes."display.on.consent.screen"=false')
kcadm create "client-scopes/${ROLES_SCOPE_ID}/protocol-mappers/models" -r "$REALM" \
  -s name=roles -s protocol=openid-connect -s protocolMapper=oidc-usermodel-realm-role-mapper \
  -s 'config."claim.name"=roles' \
  -s 'config."multivalued"=true' \
  -s 'config."jsonType.label"=String' \
  -s 'config."access.token.claim"=true' \
  -s 'config."id.token.claim"=false' \
  -s 'config."userinfo.token.claim"=false' \
  -s 'config."introspection.token.claim"=true' >/dev/null

# $1 clientId, remaining args: extra client settings.
create_client() {
  local client_id=$1 id
  shift
  id=$(kcadm create clients -r "$REALM" -i -s clientId="$client_id" -s publicClient=true \
    -s serviceAccountsEnabled=false -s implicitFlowEnabled=false "$@")
  for scope_id in "$READ_ID" "$WRITE_ID" "$CLOSE_ID" "$OTHER_ID"; do
    kcadm update "clients/${id}/optional-client-scopes/${scope_id}" -r "$REALM" -n
  done
  kcadm update "clients/${id}/default-client-scopes/${ROLES_SCOPE_ID}" -r "$REALM" -n
}

# The real client: browser flow with PKCE S256 only, as Claude Code uses it.
create_client claude-code -s standardFlowEnabled=true -s directAccessGrantsEnabled=false \
  -s 'attributes."pkce.code.challenge.method"=S256' \
  -s 'redirectUris=["http://localhost:33418/callback"]'
# Test-only: password grant so e2e tests can get tokens without a browser. OAuth 2.1 drops this grant.
create_client lab-tester -s standardFlowEnabled=false -s directAccessGrantsEnabled=true

# Stop the server so the export can open the database, then export from the same data volume.
docker stop "$NAME" >/dev/null
docker run --name "${NAME}-export" -v "${VOLUME}:/opt/keycloak/data" "$IMAGE" \
  export --realm "$REALM" --users realm_file --dir /tmp/export
docker cp "${NAME}-export:/tmp/export/${REALM}-realm.json" "$OUT"

# The export carries the realm's generated signing keys, private halves included. Drop them so no
# key material is committed; Keycloak generates fresh ones on every import.
node -e '
  const fs = require("node:fs");
  const realm = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  delete realm.components["org.keycloak.keys.KeyProvider"];
  fs.writeFileSync(process.argv[1], JSON.stringify(realm, null, 2) + "\n");
' "$OUT"
echo "wrote $OUT"

#!/usr/bin/env bash
set -euo pipefail

# ── Preflight ─────────────────────────────────────────
missing=()
[[ -z "${CLOUDFLARE_API_TOKEN:-}"  ]] && missing+=("CLOUDFLARE_API_TOKEN")
[[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && missing+=("CLOUDFLARE_ACCOUNT_ID")
[[ -z "${ADMIN_PASS:-}"            ]] && missing+=("ADMIN_PASS")

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "ERROR: Missing required GitHub Secrets: ${missing[*]}"
  echo ""
  echo "Go to: Settings → Secrets and variables → Actions → New repository secret"
  echo "See README.md → 一键部署 for details."
  exit 1
fi

API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}"
AUTH="Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"
echo "Account ID: ${CLOUDFLARE_ACCOUNT_ID:0:8}..."

api() {
  local method=$1 path=$2; shift 2
  local body
  body=$(curl -s -w "\n%{http_code}" -X "$method" "$API$path" -H "$AUTH" -H "Content-Type: application/json" "$@")
  local http_code=$(echo "$body" | tail -1)
  local resp=$(echo "$body" | sed '$d')
  if [[ "$http_code" -ge 400 ]]; then
    echo "API $method $path failed (HTTP $http_code):" >&2
    if echo "$resp" | jq -e . >/dev/null 2>&1; then
      echo "$resp" | jq -r '.errors[]?.message // .errors[]? // .message // .' >&2
    else
      echo "$resp" >&2
    fi
    exit 1
  fi
  echo "$resp"
}

# ── D1 ────────────────────────────────────────────────
DB_ID=$(grep 'database_id' wrangler.toml | grep -v placeholder | head -1 | sed 's/.*= *"\(.*\)"/\1/' || true)

if [[ -z "$DB_ID" || "$DB_ID" == "placeholder" ]]; then
  # Check if database already exists
  DB_ID=$(api GET /d1/database | jq -r '.result[] | select(.name=="gallery-db") | .id' 2>/dev/null || true)
  if [[ -n "$DB_ID" ]]; then
    echo "D1 database 'gallery-db' already exists: $DB_ID"
  else
    echo "Creating D1 database 'gallery-db'..."
    RES=$(api POST /d1/database -d '{"name":"gallery-db"}')
    DB_ID=$(echo "$RES" | jq -r '.result.id')
    echo "  -> $DB_ID"
  fi
else
  echo "D1 database exists: $DB_ID"
fi

sed -i.bak "s/database_id = \"placeholder\"/database_id = \"$DB_ID\"/" wrangler.toml && rm -f wrangler.toml.bak

# ── KV ────────────────────────────────────────────────
# Get all existing KV namespaces once
KV_LIST=$(api GET /storage/kv/namespaces)

declare -A KV_IDS
for NS in KV_CONFIG KV_TOKEN KV_SESSION; do
  EXISTING=$(grep -A1 "binding = \"$NS\"" wrangler.toml | grep 'id' | sed 's/.*= *"\(.*\)"/\1/' || true)

  if [[ -z "$EXISTING" || "$EXISTING" == "placeholder" ]]; then
    # Check if namespace already exists
    NS_ID=$(echo "$KV_LIST" | jq -r ".result[] | select(.title==\"gallery-$NS\") | .id" 2>/dev/null || true)
    if [[ -n "$NS_ID" ]]; then
      echo "KV namespace 'gallery-$NS' already exists: $NS_ID"
    else
      echo "Creating KV namespace 'gallery-$NS'..."
      RES=$(api POST /storage/kv/namespaces -d "{\"title\":\"gallery-$NS\"}")
      NS_ID=$(echo "$RES" | jq -r '.result.id')
      echo "  -> $NS_ID"
    fi
  else
    echo "KV namespace $NS exists: $EXISTING"
    NS_ID="$EXISTING"
  fi
  KV_IDS[$NS]="$NS_ID"
done

# Replace KV IDs in wrangler.toml using Python for reliable multi-line substitution
python3 -c "
import re
kv = {
  'KV_CONFIG':  '${KV_IDS[KV_CONFIG]}',
  'KV_TOKEN':   '${KV_IDS[KV_TOKEN]}',
  'KV_SESSION': '${KV_IDS[KV_SESSION]}',
}
txt = open('wrangler.toml').read()
for name, ns_id in kv.items():
    txt = re.sub(
        r'binding = \"' + name + r'\"[\s\S]*?id\s*=\s*\"[^\"]*\"',
        lambda m: re.sub(r'id\s*=\s*\"[^\"]*\"', 'id = \"' + ns_id + '\"', m.group()),
        txt, count=1, flags=re.DOTALL,
    )
open('wrangler.toml', 'w').write(txt)
"

# ── Migration ─────────────────────────────────────────
[[ -f src/db/schema.sql ]] || { echo 'ERROR: src/db/schema.sql not found' >&2; exit 1; }
echo "Running D1 migration..."
npx wrangler d1 execute gallery-db --remote --file=src/db/schema.sql

# ── Secrets ────────────────────────────────────────────
set_secret() {
  local name=$1 value=$2
  if [[ -n "$value" ]]; then
    echo "Setting secret: $name"
    printf '%s' "$value" | npx wrangler secret put "$name" --force
  else
    echo "Skipping secret $name (not set)"
  fi
}

set_secret "ADMIN_PASS"             "${ADMIN_PASS:-}"
set_secret "ELEVEN5_CLIENT_SECRET"  "${ELEVEN5_CLIENT_SECRET:-}"

# Non-secret vars
if [[ -n "${ELEVEN5_CLIENT_ID:-}" ]]; then
  echo "Setting var: ELEVEN5_CLIENT_ID"
  npx wrangler vars put ELEVEN5_CLIENT_ID "$ELEVEN5_CLIENT_ID"
else
  echo "Skipping var ELEVEN5_CLIENT_ID (not set)"
fi

echo "Provisioning complete."

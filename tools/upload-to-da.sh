#!/bin/bash
# Upload draft HTML files to DA (Document Authoring)
# Usage: ./tools/upload-to-da.sh [specific-file]
# If no file specified, uploads all .plain.html files in drafts/

set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true; shift ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DRAFTS_DIR="$PROJECT_DIR/drafts"

# Read env vars from .env file
DA_CLIENT_ID=$(grep "DA_CLIENT_ID" "$PROJECT_DIR/.env" | sed 's/DA_CLIENT_ID=//' | tr -d '"')
DA_CLIENT_SECRET=$(grep "DA_CLIENT_SECRET" "$PROJECT_DIR/.env" | sed 's/DA_CLIENT_SECRET=//' | tr -d '"')
DA_SERVICE_TOKEN=$(grep "DA_SERVICE_TOKEN" "$PROJECT_DIR/.env" | sed 's/DA_SERVICE_TOKEN=//' | tr -d '"')
DA_ORG=$(grep "DA_ORG" "$PROJECT_DIR/.env" | sed 's/DA_ORG=//' | tr -d '"')
DA_REPO=$(grep "DA_REPO" "$PROJECT_DIR/.env" | sed 's/DA_REPO=//' | tr -d '"')

DA_ORG="${DA_ORG:-paolomoz}"
DA_REPO="${DA_REPO:-arco}"
DA_API="https://admin.da.live/source/$DA_ORG/$DA_REPO"

ACCESS_TOKEN=""
if [ "$DRY_RUN" = false ]; then
  # Exchange IMS credentials for access token
  echo "Authenticating with Adobe IMS..."
  ACCESS_TOKEN=$(curl -s -X POST "https://ims-na1.adobelogin.com/ims/token/v3" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=authorization_code&client_id=$DA_CLIENT_ID&client_secret=$DA_CLIENT_SECRET&code=$DA_SERVICE_TOKEN" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

  if [ -z "$ACCESS_TOKEN" ]; then
    echo "ERROR: Failed to obtain IMS access token"
    exit 1
  fi
  echo "Authenticated."
  echo ""
fi

upload_file() {
  local plain_file="$1"
  local progress="${2:-}"
  local rel_path="${plain_file#$DRAFTS_DIR/}"
  local da_path="${rel_path%.plain.html}.html"
  local prefix=""
  [ -n "$progress" ] && prefix="[$progress] "

  # Convert plain HTML to DA format
  local tmp_file
  tmp_file=$(mktemp /tmp/da-upload-XXXXXX.html)
  python3 "$SCRIPT_DIR/plain-to-da.py" "$plain_file" > "$tmp_file" 2>/dev/null

  if [ ! -s "$tmp_file" ]; then
    echo "${prefix}SKIP: $rel_path (empty conversion)"
    rm -f "$tmp_file"
    return 1
  fi

  if [ "$DRY_RUN" = true ]; then
    echo "${prefix} DRY: $da_path ($(wc -c < "$tmp_file" | tr -d ' ') bytes)"
    rm -f "$tmp_file"
    return 0
  fi

  local url="$DA_API/$da_path"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -F "data=@$tmp_file;type=text/html" \
    "$url")

  rm -f "$tmp_file"

  if [ "$status" = "200" ] || [ "$status" = "201" ] || [ "$status" = "204" ]; then
    echo "${prefix}  OK: $da_path ($status)"
    return 0
  else
    echo "${prefix}FAIL: $da_path (HTTP $status)"
    return 1
  fi
}

if [ "$DRY_RUN" = true ]; then
  echo "DRY RUN — no uploads will be made"
fi
echo "Uploading to DA: $DA_API"
echo "---"

SUCCESS=0
FAIL=0

if [ -n "${1:-}" ] && [ "$1" != "--dry-run" ]; then
  # Upload single file
  upload_file "$1" && SUCCESS=$((SUCCESS+1)) || FAIL=$((FAIL+1))
else
  # Upload all drafts
  TOTAL=$(find "$DRAFTS_DIR" -name "*.plain.html" | wc -l | tr -d ' ')
  COUNT=0
  while IFS= read -r file; do
    COUNT=$((COUNT+1))
    upload_file "$file" "$COUNT/$TOTAL" && SUCCESS=$((SUCCESS+1)) || FAIL=$((FAIL+1))
    # Rate limit: small delay between uploads to avoid throttling
    if [ "$DRY_RUN" = false ]; then
      sleep 0.5
    fi
  done < <(find "$DRAFTS_DIR" -name "*.plain.html" | sort)
fi

echo "---"
echo "Done: $SUCCESS uploaded, $FAIL failed out of ${TOTAL:-1}"

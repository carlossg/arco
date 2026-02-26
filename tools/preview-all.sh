#!/bin/bash
# Preview all uploaded pages on AEM Edge Delivery
# Triggers the preview CDN to pick up content from DA

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DRAFTS_DIR="$PROJECT_DIR/drafts"
ADMIN_API="https://admin.hlx.page/preview/paolomoz/arco/main"

# Read env vars from .env file
DA_CLIENT_ID=$(grep "DA_CLIENT_ID" "$PROJECT_DIR/.env" | sed 's/DA_CLIENT_ID=//' | tr -d '"')
DA_CLIENT_SECRET=$(grep "DA_CLIENT_SECRET" "$PROJECT_DIR/.env" | sed 's/DA_CLIENT_SECRET=//' | tr -d '"')
DA_SERVICE_TOKEN=$(grep "DA_SERVICE_TOKEN" "$PROJECT_DIR/.env" | sed 's/DA_SERVICE_TOKEN=//' | tr -d '"')

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

TOTAL=$(find "$DRAFTS_DIR" -name "*.plain.html" | wc -l | tr -d ' ')
COUNT=0
SUCCESS=0
FAIL=0

echo "Previewing $TOTAL pages..."
echo "---"

while IFS= read -r file; do
  COUNT=$((COUNT+1))
  rel_path="${file#$DRAFTS_DIR/}"
  page_path="${rel_path%.plain.html}"

  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    "$ADMIN_API/$page_path")

  if [ "$status" = "200" ] || [ "$status" = "201" ] || [ "$status" = "204" ]; then
    echo "[$COUNT/$TOTAL]   OK: /$page_path ($status)"
    SUCCESS=$((SUCCESS+1))
  else
    echo "[$COUNT/$TOTAL] FAIL: /$page_path (HTTP $status)"
    FAIL=$((FAIL+1))
  fi

  sleep 0.5
done < <(find "$DRAFTS_DIR" -name "*.plain.html" | sort)

echo "---"
echo "Done: $SUCCESS previewed, $FAIL failed out of $TOTAL"

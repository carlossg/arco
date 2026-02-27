#!/bin/bash
# Copy files between DA (Document Authoring) orgs/repos.
#
# Usage:
#   ./tools/da-copy.sh <src> <dst> [path]
#
# Arguments:
#   src   Source org/repo (e.g. paolomoz/arco)
#   dst   Destination org/repo (e.g. carlossg/arco)
#   path  Optional path prefix to copy (e.g. products). Copies everything under it.
#         If omitted, lists top-level directories for you to choose.
#
# Examples:
#   ./tools/da-copy.sh paolomoz/arco carlossg/arco products/comparison
#   ./tools/da-copy.sh paolomoz/arco carlossg/arco blog
#   ./tools/da-copy.sh paolomoz/arco carlossg/arco          # interactive
#
# Requires:
#   - gcloud CLI with access to DA_TOKEN secret, OR
#   - DA_TOKEN environment variable set directly
#
# The script recursively discovers all .html files under the given path
# in the source org and copies any that are missing in the destination.

set -uo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Auth ──────────────────────────────────────────────────────────────────────

if [ -z "${DA_TOKEN:-}" ]; then
  DA_TOKEN=$(gcloud secrets versions access latest --secret=DA_TOKEN 2>/dev/null || true)
fi

if [ -z "$DA_TOKEN" ]; then
  echo -e "${RED}DA_TOKEN not set and could not be retrieved from gcloud secrets.${RESET}"
  echo "Set DA_TOKEN env var or configure gcloud secrets."
  exit 1
fi

# ── Args ──────────────────────────────────────────────────────────────────────

SRC="${1:-}"
DST="${2:-}"
PREFIX="${3:-}"

if [ -z "$SRC" ] || [ -z "$DST" ]; then
  echo "Usage: $0 <src-org/repo> <dst-org/repo> [path]"
  echo ""
  echo "Examples:"
  echo "  $0 paolomoz/arco carlossg/arco products"
  echo "  $0 paolomoz/arco carlossg/arco blog/travel"
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

# List files and directories at a DA path.
# Outputs lines like "name.html" (file) or "name/" (directory)
da_list() {
  local org_repo="$1" path="$2"
  /usr/bin/curl -s -H "Authorization: Bearer $DA_TOKEN" \
    "https://admin.da.live/list/${org_repo}${path}" | \
    python3 -c "
import sys, json
try:
  data = json.load(sys.stdin)
  for i in data:
    if 'ext' in i:
      print(i['name'] + '.' + i['ext'])
    else:
      print(i['name'] + '/')
except:
  pass
" 2>/dev/null
}

# Recursively list all .html files under a path
da_list_recursive() {
  local org_repo="$1" path="$2"
  local items
  items=$(da_list "$org_repo" "$path")

  while IFS= read -r item; do
    [ -z "$item" ] && continue
    if [[ "$item" == */ ]]; then
      # Directory — recurse
      da_list_recursive "$org_repo" "${path}/${item%/}"
    else
      # File
      echo "${path}/${item}"
    fi
  done <<< "$items"
}

# Copy a single file from src to dst
copy_file() {
  local rel_path="$1"
  local tmp=$(/usr/bin/mktemp)

  local http_code=$(/usr/bin/curl -s -o "$tmp" -w "%{http_code}" \
    -H "Authorization: Bearer $DA_TOKEN" \
    "https://admin.da.live/source/${SRC}${rel_path}")

  if [ "$http_code" != "200" ]; then
    echo -e "  ${RED}SKIP${RESET} ${rel_path} (download: ${http_code})"
    /bin/rm -f "$tmp"
    return 1
  fi

  local put_code=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" \
    -X PUT \
    -H "Authorization: Bearer $DA_TOKEN" \
    -F "data=@${tmp};type=text/html" \
    "https://admin.da.live/source/${DST}${rel_path}")

  if [ "$put_code" = "200" ] || [ "$put_code" = "201" ]; then
    echo -e "  ${GREEN}COPY${RESET} ${rel_path}"
  else
    echo -e "  ${RED}FAIL${RESET} ${rel_path} (upload: ${put_code})"
  fi

  /bin/rm -f "$tmp"
}

# ── Main ──────────────────────────────────────────────────────────────────────

if [ -z "$PREFIX" ]; then
  echo -e "${BOLD}Top-level directories in ${SRC}:${RESET}"
  da_list "$SRC" ""
  echo ""
  echo "Re-run with a path argument to copy files, e.g.:"
  echo "  $0 $SRC $DST products"
  exit 0
fi

echo -e "${BOLD}Discovering files in ${SRC}/${PREFIX}...${RESET}"

# Get all source files
src_files=$(da_list_recursive "$SRC" "/${PREFIX}")
src_count=$(echo "$src_files" | grep -c '.' || true)

if [ "$src_count" -eq 0 ]; then
  echo -e "${YELLOW}No files found in ${SRC}/${PREFIX}${RESET}"
  exit 0
fi

echo -e "${DIM}Found ${src_count} files in source${RESET}"

# Get all destination files for comparison
echo -e "${DIM}Checking destination...${RESET}"
dst_files=$(da_list_recursive "$DST" "/${PREFIX}" 2>/dev/null || true)

# Find missing files
missing=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if ! echo "$dst_files" | grep -qF "$f"; then
    missing+=("$f")
  fi
done <<< "$src_files"

if [ ${#missing[@]} -eq 0 ]; then
  echo -e "${GREEN}All ${src_count} files already exist in ${DST}/${PREFIX}${RESET}"
  exit 0
fi

echo -e "${BOLD}Copying ${#missing[@]} missing files (${src_count} total in source)...${RESET}"
echo ""

copied=0
failed=0
for f in "${missing[@]}"; do
  if copy_file "$f"; then
    ((copied++))
  else
    ((failed++))
  fi
done

echo ""
echo -e "${BOLD}Done:${RESET} ${GREEN}${copied} copied${RESET}, ${RED}${failed} skipped${RESET}, ${DIM}$((src_count - ${#missing[@]})) already existed${RESET}"

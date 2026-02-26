#!/bin/bash
# Watch recommender service logs to inspect LLM prompts and context.
#
# Usage:
#   ./tools/watch-prompts.sh              # Local dev server (default)
#   ./tools/watch-prompts.sh local        # Same as above
#   ./tools/watch-prompts.sh cloud        # Cloud Run logs via gcloud
#   ./tools/watch-prompts.sh cloud full   # Cloud Run, no truncation
#
# The LOG_PROMPTS=true env var must be set on the server for prompt logging.
# For local: set it in services/recommender/.env or export before starting.
# For Cloud Run: update the service with --set-env-vars LOG_PROMPTS=true

set -uo pipefail

MODE="${1:-local}"
FILTER="${2:-}"

CYAN='\033[0;36m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Local mode ──────────────────────────────────────────────────────────────

watch_local() {
  echo -e "${BOLD}Watching local recommender service...${RESET}"
  echo -e "${DIM}Make sure LOG_PROMPTS=true is set and the server is running.${RESET}"
  echo -e "${DIM}Start with: cd services/recommender && LOG_PROMPTS=true npm run dev${RESET}"
  echo ""

  RECOMMENDER_DIR="$(cd "$(dirname "$0")/.." && pwd)/services/recommender"

  # Check if server is running
  if ! curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/health 2>/dev/null | grep -q "200"; then
    echo -e "${YELLOW}Server not running on :8080. Starting with LOG_PROMPTS=true...${RESET}"
    cd "$RECOMMENDER_DIR"
    LOG_PROMPTS=true npx ts-node src/index-express.ts 2>&1 | while IFS= read -r line; do
      colorize "$line"
    done
  else
    echo -e "${GREEN}Server already running on :8080. Tailing logs...${RESET}"
    echo -e "${YELLOW}Note: if LOG_PROMPTS was not set at startup, restart with:${RESET}"
    echo -e "${DIM}  LOG_PROMPTS=true npx tsx src/index-express.ts${RESET}"
    echo ""
    # For an already-running server, there's no stdout to tail.
    # Suggest using the /api/generate endpoint to trigger logging.
    echo -e "${BOLD}Send a test query to see prompts:${RESET}"
    echo -e "${DIM}  curl 'http://localhost:8080/api/generate?q=best+espresso+machine'${RESET}"
    echo ""
    echo "Waiting for log output... (Ctrl+C to stop)"
    # Can't tail an already-running process; inform the user
    echo -e "${RED}Cannot attach to existing process stdout.${RESET}"
    echo -e "${YELLOW}Restart the server with this script to capture logs:${RESET}"
    echo -e "${DIM}  kill the existing server, then run: ./tools/watch-prompts.sh${RESET}"
    exit 1
  fi
}

# ── Cloud Run mode ──────────────────────────────────────────────────────────

watch_cloud() {
  echo -e "${BOLD}Watching Cloud Run logs for arco-recommender...${RESET}"
  echo -e "${DIM}Make sure LOG_PROMPTS=true is set on the Cloud Run service.${RESET}"
  echo -e "${DIM}Set it with: gcloud run services update arco-recommender --set-env-vars LOG_PROMPTS=true --region us-central1${RESET}"
  echo ""

  PROJECT=$(gcloud config get-value project 2>/dev/null)
  echo -e "${DIM}Project: ${PROJECT}${RESET}"
  echo ""

  if [ "$FILTER" = "full" ]; then
    # Stream all logs, no filtering
    gcloud logging read \
      'resource.type="cloud_run_revision" AND resource.labels.service_name="arco-recommender" AND textPayload=~"\\[LLM\\]"' \
      --project="$PROJECT" \
      --format="value(textPayload)" \
      --freshness=5m \
      --order=asc \
      --limit=500
  else
    # Stream with live tail
    gcloud beta run services logs tail arco-recommender \
      --project="$PROJECT" \
      --region=us-central1 2>&1 | while IFS= read -r line; do
      # Only show LLM log lines
      if echo "$line" | grep -q '\[LLM\]'; then
        colorize "$line"
      fi
    done
  fi
}

# ── Colorize output ─────────────────────────────────────────────────────────

colorize() {
  local line="$1"

  if echo "$line" | grep -q '═══'; then
    echo -e "${CYAN}${line}${RESET}"
  elif echo "$line" | grep -q '───'; then
    echo -e "${DIM}${line}${RESET}"
  elif echo "$line" | grep -qE '\[LLM\] (CLASSIFICATION|REASONING|CONTENT|VALIDATION)'; then
    echo -e "${BOLD}${GREEN}${line}${RESET}"
  elif echo "$line" | grep -q '\[LLM\] RESPONSE'; then
    echo -e "${BOLD}${YELLOW}${line}${RESET}"
  elif echo "$line" | grep -q '\[LLM\] SYSTEM'; then
    echo -e "${CYAN}${line}${RESET}"
  elif echo "$line" | grep -q '\[LLM\] USER'; then
    echo -e "${GREEN}${line}${RESET}"
  elif echo "$line" | grep -q '\[LLM\]'; then
    echo -e "${DIM}${line}${RESET}"
  else
    echo "$line"
  fi
}

# ── Main ────────────────────────────────────────────────────────────────────

case "$MODE" in
  local)
    watch_local
    ;;
  cloud)
    watch_cloud
    ;;
  *)
    echo "Usage: $0 [local|cloud] [full]"
    echo ""
    echo "  local   Watch local server on :8080 (default)"
    echo "  cloud   Watch Cloud Run logs via gcloud"
    echo "  full    (cloud only) Fetch recent logs without streaming"
    exit 1
    ;;
esac

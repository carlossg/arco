#!/bin/bash
# Watch recommender service logs to inspect LLM prompts, reasoning, and pipeline.
#
# Usage:
#   ./tools/watch-prompts.sh              # Live tail Cloud Run logs (default)
#   ./tools/watch-prompts.sh 10           # Fetch logs from 10 minutes ago
#   ./tools/watch-prompts.sh 30 full      # 30 minutes ago, no truncation
#   ./tools/watch-prompts.sh local        # Local dev server
#
# Shows: [LLM] prompts/responses, [reasoning-engine] block selection,
#        [orchestrator] pipeline steps, errors, and timing.
#
# The LOG_PROMPTS=true env var must be set on the server for prompt logging.
# For local: set it in services/recommender/.env or export before starting.
# For Cloud Run: already set via deploy-google-cloud.sh

set -uo pipefail

ARG1="${1:-cloud}"
ARG2="${2:-}"
ARG3="${3:-}"

CYAN='\033[0;36m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

LOG_FILTER='(\[LLM\]|\[reasoning-engine\]|\[orchestrator\])'

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
  elif echo "$line" | grep -qE '\[reasoning-engine\].*fallback'; then
    echo -e "${RED}${line}${RESET}"
  elif echo "$line" | grep -q '\[reasoning-engine\]'; then
    echo -e "${YELLOW}${line}${RESET}"
  elif echo "$line" | grep -qE '\[orchestrator\].*(failed|error)'; then
    echo -e "${RED}${line}${RESET}"
  elif echo "$line" | grep -qE '\[orchestrator\].*(complete|streamed)'; then
    echo -e "${GREEN}${line}${RESET}"
  elif echo "$line" | grep -q '\[orchestrator\]'; then
    echo -e "${CYAN}${line}${RESET}"
  elif echo "$line" | grep -q '\[LLM\]'; then
    echo -e "${DIM}${line}${RESET}"
  else
    echo "$line"
  fi
}

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
    echo -e "${BOLD}Send a test query to see prompts:${RESET}"
    echo -e "${DIM}  curl 'http://localhost:8080/api/generate?q=best+espresso+machine'${RESET}"
    echo ""
    echo -e "${RED}Cannot attach to existing process stdout.${RESET}"
    echo -e "${YELLOW}Restart the server with this script to capture logs:${RESET}"
    echo -e "${DIM}  kill the existing server, then run: ./tools/watch-prompts.sh local${RESET}"
    exit 1
  fi
}

# ── Cloud Run: live tail ───────────────────────────────────────────────────

watch_cloud_tail() {
  PROJECT=$(gcloud config get-value project 2>/dev/null)
  echo -e "${BOLD}Live-tailing Cloud Run logs for arco-recommender...${RESET}"
  echo -e "${DIM}Project: ${PROJECT}  |  Ctrl+C to stop${RESET}"
  echo ""

  gcloud beta run services logs tail arco-recommender \
    --project="$PROJECT" \
    --region=us-central1 2>&1 | while IFS= read -r line; do
    if echo "$line" | grep -qE '\[LLM\]|\[reasoning-engine\]|\[orchestrator\]'; then
      colorize "$line"
    fi
  done
}

# ── Cloud Run: fetch from N minutes ago ────────────────────────────────────

watch_cloud_history() {
  local minutes="$1"
  local mode="${2:-}"
  local limit=500

  PROJECT=$(gcloud config get-value project 2>/dev/null)
  echo -e "${BOLD}Fetching Cloud Run logs from the last ${minutes} minute(s)...${RESET}"
  echo -e "${DIM}Project: ${PROJECT}${RESET}"

  if [ "$mode" = "full" ]; then
    limit=2000
    echo -e "${DIM}Mode: full (up to ${limit} entries, no truncation)${RESET}"
  fi
  echo ""

  # Compute the UTC cutoff (N minutes ago)
  since=$(date -u -v-"${minutes}"M "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
       || date -u -d "${minutes} minutes ago" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
  echo -e "${DIM}Since: ${since}${RESET}"
  echo ""

  gcloud logging read \
    "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"arco-recommender\" AND textPayload=~\"${LOG_FILTER}\" AND timestamp>=\"${since}\"" \
    --project="$PROJECT" \
    --format="value(timestamp,textPayload)" \
    --order=asc \
    --limit="$limit" | while IFS= read -r raw; do
    # Raw format: "2026-02-26T19:31:33.870Z\ttext..."
    # Extract ISO timestamp and convert UTC → local time
    utc_ts="${raw%%	*}"
    line="${raw#*	}"
    if [ -n "$utc_ts" ]; then
      epoch=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "${utc_ts%%.*}" "+%s" 2>/dev/null)
      if [ -n "$epoch" ]; then
        local_ts=$(date -r "$epoch" "+%Y-%m-%d %H:%M:%S")
      else
        local_ts="$utc_ts"
      fi
      echo -ne "${DIM}${local_ts}${RESET} "
    fi
    colorize "$line"
  done

  # Continue with live tail
  echo ""
  echo -e "${DIM}── history end ── switching to live tail (Ctrl+C to stop) ──${RESET}"
  echo ""
  gcloud beta run services logs tail arco-recommender \
    --project="$PROJECT" \
    --region=us-central1 2>&1 | while IFS= read -r line; do
    if echo "$line" | grep -qE '\[LLM\]|\[reasoning-engine\]|\[orchestrator\]'; then
      colorize "$line"
    fi
  done
}

# ── Main ────────────────────────────────────────────────────────────────────

case "$ARG1" in
  local)
    watch_local
    ;;
  cloud)
    # "cloud 15" or "cloud 15 full" → fetch history; plain "cloud" → live tail
    if [[ "$ARG2" =~ ^[0-9]+$ ]]; then
      watch_cloud_history "$ARG2" "$ARG3"
    else
      watch_cloud_tail
    fi
    ;;
  [0-9]*)
    watch_cloud_history "$ARG1" "$ARG2"
    ;;
  -h|--help|help)
    echo "Usage: $0 [cloud] [MINUTES] [full]"
    echo ""
    echo "  (no args)       Live tail Cloud Run logs"
    echo "  cloud           Same as above"
    echo "  cloud MINUTES   Fetch Cloud Run logs from N minutes ago"
    echo "  MINUTES         Same (cloud is implied)"
    echo "  full            (after MINUTES) Fetch up to 2000 log entries"
    echo "  local           Watch local server on :8080"
    echo ""
    echo "Examples:"
    echo "  $0              # live tail"
    echo "  $0 5            # last 5 minutes"
    echo "  $0 cloud 15     # last 15 minutes"
    echo "  $0 cloud 30 full  # last 30 minutes, extended"
    echo "  $0 local        # local dev server"
    ;;
  *)
    echo -e "${RED}Unknown argument: $ARG1${RESET}"
    echo "Run $0 --help for usage."
    exit 1
    ;;
esac

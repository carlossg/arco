#!/usr/bin/env bash
# =============================================================================
# Enable Required GCP APIs for Arco Project
# =============================================================================
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Verify gcloud is available
if ! command -v gcloud &> /dev/null; then
  echo -e "${RED}Error: gcloud CLI is not installed or not in PATH${NC}"
  exit 1
fi

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
if [ -z "$PROJECT_ID" ]; then
  echo -e "${RED}Error: No GCP project set. Set GCP_PROJECT_ID or run 'gcloud config set project <id>'${NC}"
  exit 1
fi

echo -e "${BLUE}Enabling required GCP APIs for project: ${PROJECT_ID}${NC}"
echo ""

APIS=(
  "run.googleapis.com"                    # Cloud Run
  "cloudbuild.googleapis.com"             # Cloud Build
  "aiplatform.googleapis.com"             # Vertex AI
  "firestore.googleapis.com"              # Firestore
  "secretmanager.googleapis.com"          # Secret Manager
  "cloudfunctions.googleapis.com"         # Cloud Functions
  "storage.googleapis.com"               # Cloud Storage
  "monitoring.googleapis.com"             # Cloud Monitoring
  "logging.googleapis.com"               # Cloud Logging
)

for api in "${APIS[@]}"; do
  echo -ne "${YELLOW}Enabling ${api}...${NC} "
  if gcloud services enable "$api" --project="$PROJECT_ID" 2>/dev/null; then
    echo -e "${GREEN}Done${NC}"
  else
    echo -e "${RED}Failed${NC}"
    echo -e "${RED}  Could not enable ${api}. Check permissions and billing.${NC}"
  fi
done

echo ""
echo -e "${GREEN}API enablement complete.${NC}"
echo -e "${BLUE}Verifying enabled APIs...${NC}"
echo ""

gcloud services list --enabled --project="$PROJECT_ID" --filter="config.name:( $(IFS=', '; echo "${APIS[*]}") )" --format="table(config.name, config.title)" 2>/dev/null || true

echo ""
echo -e "${GREEN}All required APIs have been processed.${NC}"

#!/usr/bin/env bash
# =============================================================================
# Setup Service Accounts for Arco Cloud Run Services
# =============================================================================
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
if [ -z "$PROJECT_ID" ]; then
  echo -e "${RED}Error: No GCP project set. Set GCP_PROJECT_ID or run 'gcloud config set project <id>'${NC}"
  exit 1
fi

echo -e "${BLUE}Setting up service accounts for project: ${PROJECT_ID}${NC}"
echo ""

# Service accounts to create
declare -A SERVICE_ACCOUNTS=(
  ["arco-recommender-sa"]="Arco Recommender Service Account"
  ["arco-analytics-sa"]="Arco Analytics Service Account"
  ["arco-embeddings-sa"]="Arco Embeddings Service Account"
)

# IAM roles to grant to all service accounts
COMMON_ROLES=(
  "roles/aiplatform.user"
  "roles/datastore.user"
  "roles/secretmanager.secretAccessor"
  "roles/storage.objectViewer"
  "roles/monitoring.metricWriter"
  "roles/logging.logWriter"
)

# Create service accounts
for sa_name in "${!SERVICE_ACCOUNTS[@]}"; do
  sa_display="${SERVICE_ACCOUNTS[$sa_name]}"
  sa_email="${sa_name}@${PROJECT_ID}.iam.gserviceaccount.com"

  echo -ne "${YELLOW}Creating service account ${sa_name}...${NC} "
  if gcloud iam service-accounts describe "$sa_email" --project="$PROJECT_ID" &>/dev/null; then
    echo -e "${GREEN}Already exists${NC}"
  else
    if gcloud iam service-accounts create "$sa_name" \
      --display-name="$sa_display" \
      --project="$PROJECT_ID" 2>/dev/null; then
      echo -e "${GREEN}Created${NC}"
    else
      echo -e "${RED}Failed${NC}"
      continue
    fi
  fi

  # Grant IAM roles
  for role in "${COMMON_ROLES[@]}"; do
    echo -ne "  ${YELLOW}Granting ${role}...${NC} "
    if gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:${sa_email}" \
      --role="$role" \
      --condition=None \
      --quiet 2>/dev/null; then
      echo -e "${GREEN}Done${NC}"
    else
      echo -e "${RED}Failed${NC}"
    fi
  done
  echo ""
done

echo -e "${GREEN}Service account setup complete.${NC}"
echo ""
echo -e "${BLUE}Summary of service accounts:${NC}"
gcloud iam service-accounts list --project="$PROJECT_ID" \
  --filter="email:arco-" \
  --format="table(email, displayName, disabled)" 2>/dev/null || true

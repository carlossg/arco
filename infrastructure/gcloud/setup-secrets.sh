#!/usr/bin/env bash
# =============================================================================
# Setup Secret Manager Secrets for Arco Project
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

echo -e "${BLUE}Setting up secrets for project: ${PROJECT_ID}${NC}"
echo ""

# List of secrets to create
SECRETS=(
  "DA_TOKEN"
)

for secret_name in "${SECRETS[@]}"; do
  echo -ne "${YELLOW}Checking secret ${secret_name}...${NC} "

  # Check if secret already exists
  if gcloud secrets describe "$secret_name" --project="$PROJECT_ID" &>/dev/null; then
    echo -e "${GREEN}Already exists${NC}"

    # Check if it has any versions
    VERSION_COUNT=$(gcloud secrets versions list "$secret_name" \
      --project="$PROJECT_ID" \
      --filter="state=ENABLED" \
      --format="value(name)" 2>/dev/null | wc -l | tr -d ' ')

    if [ "$VERSION_COUNT" -eq 0 ]; then
      echo -e "  ${YELLOW}Warning: Secret exists but has no enabled versions.${NC}"
      echo -e "  ${YELLOW}Add a value with:${NC}"
      echo -e "  ${BLUE}echo -n 'YOUR_TOKEN' | gcloud secrets versions add ${secret_name} --data-file=- --project=${PROJECT_ID}${NC}"
    else
      echo -e "  ${GREEN}Has ${VERSION_COUNT} enabled version(s)${NC}"
    fi
  else
    echo -e "${YELLOW}Creating...${NC}"
    if gcloud secrets create "$secret_name" \
      --project="$PROJECT_ID" \
      --replication-policy="automatic" 2>/dev/null; then
      echo -e "  ${GREEN}Secret created${NC}"
      echo -e "  ${YELLOW}Add a value with:${NC}"
      echo -e "  ${BLUE}echo -n 'YOUR_TOKEN' | gcloud secrets versions add ${secret_name} --data-file=- --project=${PROJECT_ID}${NC}"
    else
      echo -e "  ${RED}Failed to create secret${NC}"
    fi
  fi
  echo ""
done

# Grant access to service accounts
echo -e "${BLUE}Granting secret access to service accounts...${NC}"
echo ""

SERVICE_ACCOUNTS=(
  "arco-recommender-sa@${PROJECT_ID}.iam.gserviceaccount.com"
)

for sa_email in "${SERVICE_ACCOUNTS[@]}"; do
  for secret_name in "${SECRETS[@]}"; do
    echo -ne "  ${YELLOW}Granting ${sa_email} access to ${secret_name}...${NC} "
    if gcloud secrets add-iam-policy-binding "$secret_name" \
      --project="$PROJECT_ID" \
      --member="serviceAccount:${sa_email}" \
      --role="roles/secretmanager.secretAccessor" \
      --quiet 2>/dev/null; then
      echo -e "${GREEN}Done${NC}"
    else
      echo -e "${RED}Failed (service account may not exist yet)${NC}"
    fi
  done
done

echo ""
echo -e "${GREEN}Secret setup complete.${NC}"

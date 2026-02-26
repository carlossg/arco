#!/usr/bin/env bash
# =============================================================================
# Setup Firestore Database for Arco Project
# =============================================================================
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${GCP_REGION:-us-central1}"

if [ -z "$PROJECT_ID" ]; then
  echo -e "${RED}Error: No GCP project set. Set GCP_PROJECT_ID or run 'gcloud config set project <id>'${NC}"
  exit 1
fi

echo -e "${BLUE}Setting up Firestore for project: ${PROJECT_ID}${NC}"
echo -e "${BLUE}Region: ${REGION}${NC}"
echo ""

# Check if Firestore database already exists
echo -ne "${YELLOW}Checking for existing Firestore database...${NC} "
EXISTING_DB=$(gcloud firestore databases list --project="$PROJECT_ID" --format="value(name)" 2>/dev/null || true)

if [ -n "$EXISTING_DB" ]; then
  echo -e "${GREEN}Database already exists${NC}"
  echo -e "${BLUE}Existing database: ${EXISTING_DB}${NC}"
else
  echo -e "${YELLOW}Not found${NC}"
  echo -ne "${YELLOW}Creating Firestore database in native mode...${NC} "
  if gcloud firestore databases create \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --type=firestore-native 2>/dev/null; then
    echo -e "${GREEN}Created${NC}"
  else
    echo -e "${RED}Failed${NC}"
    echo -e "${RED}  Could not create Firestore database. It may already exist in a different mode.${NC}"
    exit 1
  fi
fi

# Deploy indexes if the indexes file exists
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INDEXES_FILE="${SCRIPT_DIR}/../firestore/indexes.json"

if [ -f "$INDEXES_FILE" ]; then
  echo ""
  echo -ne "${YELLOW}Deploying Firestore indexes...${NC} "
  if gcloud firestore indexes composite create \
    --project="$PROJECT_ID" \
    --file="$INDEXES_FILE" 2>/dev/null; then
    echo -e "${GREEN}Done${NC}"
  else
    echo -e "${YELLOW}Indexes may need to be deployed individually or may already exist${NC}"
  fi
else
  echo -e "${YELLOW}No indexes file found at ${INDEXES_FILE}. Skipping index deployment.${NC}"
fi

# Deploy security rules if the rules file exists
RULES_FILE="${SCRIPT_DIR}/../firestore/firestore.rules"

if [ -f "$RULES_FILE" ]; then
  echo ""
  echo -e "${BLUE}Firestore security rules file found at: ${RULES_FILE}${NC}"
  echo -e "${YELLOW}Note: Security rules must be deployed via Firebase CLI:${NC}"
  echo -e "${YELLOW}  firebase deploy --only firestore:rules --project=${PROJECT_ID}${NC}"
fi

echo ""
echo -e "${GREEN}Firestore setup complete.${NC}"

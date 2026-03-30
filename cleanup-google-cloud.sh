#!/usr/bin/env bash
# =============================================================================
# Arco - Google Cloud Cleanup Script
# =============================================================================
# This script deletes resources created by deploy-google-cloud.sh to stop costs.
#
# Usage:
#   ./cleanup-google-cloud.sh [--project PROJECT_ID] [--region REGION] [--force]
# =============================================================================
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }

# Default Config
PROJECT_ID=$(gcloud config get-value project 2>/dev/null || echo "")
REGION="us-central1"
FORCE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --project) PROJECT_ID="$2"; shift 2 ;;
    --region)  REGION="$2"; shift 2 ;;
    --force)   FORCE=true; shift ;;
    *) error "Unknown option: $1"; exit 1 ;;
  esac
done

if [ -z "$PROJECT_ID" ]; then
  error "No project ID found. Use --project <id>"
  exit 1
fi

echo -e "${BOLD}${RED}!!! WARNING: THIS WILL DELETE CLOUD RESOURCES !!!${NC}"
echo -e "Project: ${BOLD}${PROJECT_ID}${NC}"
echo -e "Region:  ${BOLD}${REGION}${NC}"
echo ""

if [ "$FORCE" = false ]; then
  read -r -p "Are you sure you want to proceed? [y/N] " response
  if [[ ! "$response" =~ ^[Yy]$ ]]; then
    info "Cleanup cancelled."
    exit 0
  fi
fi

# 1. Cloud Run
info "Deleting Cloud Run service: arco-recommender..."
gcloud run services delete arco-recommender --region="$REGION" --project="$PROJECT_ID" --quiet || warn "Cloud Run service not found."

# 2. Cloud Functions
info "Deleting Cloud Functions..."
for func in "arco-analytics" "arco-embeddings"; do
  gcloud functions delete "$func" --region="$REGION" --project="$PROJECT_ID" --gen2 --quiet || warn "Function $func not found."
done

# 3. Secrets
info "Deleting secrets..."
gcloud secrets delete DA_TOKEN --project="$PROJECT_ID" --quiet || warn "Secret DA_TOKEN not found."

# 4. Monitoring Alerts
info "Deleting Monitoring Alert Policies..."
# Get IDs of policies created for this app
POLICIES=$(gcloud alpha monitoring policies list --project="$PROJECT_ID" --filter="displayName:Arco" --format="value(name)" 2>/dev/null || true)
if [ -n "$POLICIES" ]; then
  for policy in $POLICIES; do
    gcloud alpha monitoring policies delete "$policy" --project="$PROJECT_ID" --quiet && info "Deleted policy: $policy"
  done
fi

# 5. Service Accounts
info "Deleting Service Accounts..."
SAs=("arco-recommender-sa" "arco-analytics-sa" "arco-embeddings-sa")
for sa in "${SAs[@]}"; do
  EMAIL="${sa}@${PROJECT_ID}.iam.gserviceaccount.com"
  gcloud iam service-accounts delete "$EMAIL" --project="$PROJECT_ID" --quiet || warn "Service account $sa not found."
done

# 6. Container Images (GCR/Artifact Registry)
info "Deleting container images..."
gcloud container images delete "gcr.io/${PROJECT_ID}/arco-recommender:latest" --force-delete-tags --quiet || warn "Image not found."

echo ""
success "Cleanup complete. Most active costs have been removed."
warn "Note: Firestore databases and Storage buckets were NOT deleted to prevent data loss."
warn "To delete Firestore, run: gcloud firestore databases delete --database='(default)'"

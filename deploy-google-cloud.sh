#!/usr/bin/env bash
# =============================================================================
# Arco - Google Cloud Deployment Script
# =============================================================================
# Comprehensive deployment script for the Arco coffee equipment recommender
# service on Google Cloud Platform.
#
# Usage:
#   ./deploy-google-cloud.sh [--project PROJECT_ID] [--region REGION] [--skip-build]
#
# Environment Variables:
#   GCP_PROJECT_ID    - Google Cloud project ID (or use --project flag)
#   GCP_REGION        - Google Cloud region (default: us-central1)
#   NOTIFICATION_EMAIL - Email for monitoring alerts (optional)
# =============================================================================
set -euo pipefail

# =============================================================================
# Color Output Helpers
# =============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }
step()    { echo -e "\n${BOLD}${MAGENTA}=== $* ===${NC}\n"; }

# =============================================================================
# Parse Arguments
# =============================================================================
SKIP_BUILD=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --project)
      GCP_PROJECT_ID="$2"
      shift 2
      ;;
    --region)
      GCP_REGION="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--project PROJECT_ID] [--region REGION] [--skip-build]"
      echo ""
      echo "Options:"
      echo "  --project PROJECT_ID   Google Cloud project ID"
      echo "  --region REGION        Google Cloud region (default: us-central1)"
      echo "  --skip-build           Skip Docker build and push"
      echo "  --help, -h             Show this help message"
      exit 0
      ;;
    *)
      error "Unknown option: $1"
      exit 1
      ;;
  esac
done

# =============================================================================
# Configuration
# =============================================================================
PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${GCP_REGION:-us-central1}"
NOTIFICATION_EMAIL="${NOTIFICATION_EMAIL:-}"
DA_ORG="${DA_ORG:-$(grep '^DA_ORG' "$SCRIPT_DIR/.env" 2>/dev/null | sed 's/DA_ORG=//' | tr -d '"')}"
DA_REPO="${DA_REPO:-$(grep '^DA_REPO' "$SCRIPT_DIR/.env" 2>/dev/null | sed 's/DA_REPO=//' | tr -d '"')}"
DA_ORG="${DA_ORG:?DA_ORG must be set in environment or .env}"
DA_REPO="${DA_REPO:?DA_REPO must be set in environment or .env}"
SERVICE_NAME="arco-recommender"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

# Service accounts
SA_RECOMMENDER="arco-recommender-sa"
SA_ANALYTICS="arco-analytics-sa"
SA_EMBEDDINGS="arco-embeddings-sa"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# =============================================================================
# Preflight Checks
# =============================================================================
step "Preflight Checks"

if [ -z "$PROJECT_ID" ]; then
  error "No GCP project set. Use --project flag or set GCP_PROJECT_ID environment variable."
  exit 1
fi

if ! command -v gcloud &> /dev/null; then
  error "gcloud CLI is not installed. Install from https://cloud.google.com/sdk/docs/install"
  exit 1
fi

if ! command -v docker &> /dev/null; then
  warn "Docker is not installed. Build steps will be skipped."
  SKIP_BUILD=true
fi

info "Project:  ${PROJECT_ID}"
info "Region:   ${REGION}"
info "Service:  ${SERVICE_NAME}"
info "Image:    ${IMAGE_NAME}"
if [ -n "$NOTIFICATION_EMAIL" ]; then
  info "Alerts:   ${NOTIFICATION_EMAIL}"
fi
echo ""

# Confirm
read -r -p "Continue with deployment? [y/N] " response
if [[ ! "$response" =~ ^[Yy]$ ]]; then
  info "Deployment cancelled."
  exit 0
fi

# =============================================================================
# Step 1: Enable Required GCP APIs
# =============================================================================
step "Step 1: Enable Required GCP APIs"

APIS=(
  "run.googleapis.com"
  "cloudbuild.googleapis.com"
  "aiplatform.googleapis.com"
  "firestore.googleapis.com"
  "secretmanager.googleapis.com"
  "cloudfunctions.googleapis.com"
  "storage.googleapis.com"
  "monitoring.googleapis.com"
  "logging.googleapis.com"
)

for api in "${APIS[@]}"; do
  echo -ne "  ${YELLOW}Enabling ${api}...${NC} "
  if gcloud services enable "$api" --project="$PROJECT_ID" 2>/dev/null; then
    echo -e "${GREEN}Done${NC}"
  else
    echo -e "${RED}Failed${NC}"
    warn "Could not enable ${api}. Check permissions and billing."
  fi
done

success "API enablement complete."

# =============================================================================
# Step 2: Create Service Accounts
# =============================================================================
step "Step 2: Create Service Accounts"

declare -A SERVICE_ACCOUNTS=(
  ["${SA_RECOMMENDER}"]="Arco Recommender Service Account"
  ["${SA_ANALYTICS}"]="Arco Analytics Service Account"
  ["${SA_EMBEDDINGS}"]="Arco Embeddings Service Account"
)

COMMON_ROLES=(
  "roles/aiplatform.user"
  "roles/datastore.user"
  "roles/secretmanager.secretAccessor"
  "roles/storage.objectViewer"
  "roles/monitoring.metricWriter"
  "roles/logging.logWriter"
)

for sa_name in "${!SERVICE_ACCOUNTS[@]}"; do
  sa_display="${SERVICE_ACCOUNTS[$sa_name]}"
  sa_email="${sa_name}@${PROJECT_ID}.iam.gserviceaccount.com"

  echo -ne "  ${YELLOW}Creating ${sa_name}...${NC} "
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
done

# =============================================================================
# Step 3: Setup IAM Roles
# =============================================================================
step "Step 3: Setup IAM Roles"

for sa_name in "${!SERVICE_ACCOUNTS[@]}"; do
  sa_email="${sa_name}@${PROJECT_ID}.iam.gserviceaccount.com"
  info "Granting roles to ${sa_name}..."

  for role in "${COMMON_ROLES[@]}"; do
    echo -ne "    ${YELLOW}${role}...${NC} "
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

success "IAM roles configured."

# =============================================================================
# Step 4: Setup Firestore (Native Mode)
# =============================================================================
step "Step 4: Setup Firestore"

echo -ne "  ${YELLOW}Checking for existing Firestore database...${NC} "
EXISTING_DB=$(gcloud firestore databases list --project="$PROJECT_ID" --format="value(name)" 2>/dev/null || true)

if [ -n "$EXISTING_DB" ]; then
  echo -e "${GREEN}Database already exists${NC}"
else
  echo -e "${YELLOW}Not found${NC}"
  echo -ne "  ${YELLOW}Creating Firestore database in native mode...${NC} "
  if gcloud firestore databases create \
    --project="$PROJECT_ID" \
    --location="$REGION" \
    --type=firestore-native 2>/dev/null; then
    echo -e "${GREEN}Created${NC}"
  else
    echo -e "${RED}Failed${NC}"
    warn "Could not create Firestore database. It may already exist in a different mode."
  fi
fi

success "Firestore setup complete."

# =============================================================================
# Step 5: Create Cloud Storage Bucket
# =============================================================================
step "Step 5: Setup Cloud Storage"

BUCKET_NAME="${PROJECT_ID}-arco-data"

echo -ne "  ${YELLOW}Creating bucket gs://${BUCKET_NAME}...${NC} "
if gsutil ls "gs://${BUCKET_NAME}" &>/dev/null; then
  echo -e "${GREEN}Already exists${NC}"
else
  if gsutil mb -p "$PROJECT_ID" -l "$REGION" -b on "gs://${BUCKET_NAME}" 2>/dev/null; then
    echo -e "${GREEN}Created${NC}"
  else
    echo -e "${RED}Failed${NC}"
    warn "Could not create bucket. It may already exist or the name may be taken."
  fi
fi

# Apply labels to bucket
echo -ne "  ${YELLOW}Setting labels on bucket...${NC} "
if gsutil label ch -l "app:arco" -l "component:data" "gs://${BUCKET_NAME}" 2>/dev/null; then
  echo -e "${GREEN}Done${NC}"
else
  echo -e "${YELLOW}Skipped (label may already be set)${NC}"
fi

success "Cloud Storage setup complete."

# =============================================================================
# Step 6: Setup Secrets (DA_TOKEN)
# =============================================================================
step "Step 6: Setup Secrets"

SECRETS=("DA_TOKEN")

for secret_name in "${SECRETS[@]}"; do
  echo -ne "  ${YELLOW}Checking secret ${secret_name}...${NC} "

  if gcloud secrets describe "$secret_name" --project="$PROJECT_ID" &>/dev/null; then
    echo -e "${GREEN}Already exists${NC}"

    VERSION_COUNT=$(gcloud secrets versions list "$secret_name" \
      --project="$PROJECT_ID" \
      --filter="state=ENABLED" \
      --format="value(name)" 2>/dev/null | wc -l | tr -d ' ')

    if [ "$VERSION_COUNT" -eq 0 ]; then
      warn "Secret exists but has no enabled versions."
      warn "Add a value: echo -n 'TOKEN' | gcloud secrets versions add ${secret_name} --data-file=- --project=${PROJECT_ID}"
    else
      info "  Has ${VERSION_COUNT} enabled version(s)"
    fi
  else
    echo -e "${YELLOW}Not found — creating...${NC}"
    if gcloud secrets create "$secret_name" \
      --project="$PROJECT_ID" \
      --replication-policy="automatic" \
      --labels="app=arco" 2>/dev/null; then
      success "Secret created"
      warn "Add a value: echo -n 'TOKEN' | gcloud secrets versions add ${secret_name} --data-file=- --project=${PROJECT_ID}"
    else
      error "Failed to create secret"
    fi
  fi

  # Ensure labels are set (for pre-existing secrets)
  echo -ne "    ${YELLOW}Setting labels...${NC} "
  if gcloud secrets update "$secret_name" \
    --project="$PROJECT_ID" \
    --update-labels="app=arco" \
    --quiet 2>/dev/null; then
    echo -e "${GREEN}Done${NC}"
  else
    echo -e "${YELLOW}Skipped${NC}"
  fi

  # Grant access to recommender service account
  sa_email="${SA_RECOMMENDER}@${PROJECT_ID}.iam.gserviceaccount.com"
  echo -ne "    ${YELLOW}Granting ${SA_RECOMMENDER} access...${NC} "
  if gcloud secrets add-iam-policy-binding "$secret_name" \
    --project="$PROJECT_ID" \
    --member="serviceAccount:${sa_email}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet 2>/dev/null; then
    echo -e "${GREEN}Done${NC}"
  else
    echo -e "${RED}Failed${NC}"
  fi
done

success "Secrets setup complete."

# =============================================================================
# Step 7: Verify Vertex AI Models
# =============================================================================
step "Step 7: Verify Vertex AI Models"

declare -A MODELS=(
  ["gemini-3-pro-preview"]="Google Gemini 3 Pro"
  ["gemini-3-flash-preview"]="Google Gemini 3 Flash"
  ["gemini-2.5-pro"]="Google Gemini 2.5 Pro"
  ["gemini-2.5-flash"]="Google Gemini 2.5 Flash"
  ["gemini-2.5-flash-lite"]="Google Gemini 2.5 Flash Lite"
  ["gemini-2.0-flash"]="Google Gemini 2.0 Flash"
  ["gemini-2.0-flash-lite"]="Google Gemini 2.0 Flash Lite"
)

PASS_COUNT=0
FAIL_COUNT=0

for model_id in "${!MODELS[@]}"; do
  model_name="${MODELS[$model_id]}"
  echo -ne "  ${YELLOW}Checking ${model_name}...${NC} "

  RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $(gcloud auth print-access-token 2>/dev/null)" \
    "https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${model_id}" \
    2>/dev/null || echo "000")

  if [ "$RESPONSE" = "200" ]; then
    echo -e "${GREEN}Available${NC}"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo -e "${YELLOW}Not verified (HTTP ${RESPONSE})${NC}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done

info "Results: ${PASS_COUNT} available, ${FAIL_COUNT} need attention"

if [ "$FAIL_COUNT" -gt 0 ]; then
  warn "Visit https://console.cloud.google.com/vertex-ai/model-garden?project=${PROJECT_ID} to enable models"
fi

success "Vertex AI verification complete."

# =============================================================================
# Step 8: Build and Deploy Cloud Run
# =============================================================================
step "Step 8: Build and Deploy Cloud Run"

if [ "$SKIP_BUILD" = true ]; then
  warn "Skipping Docker build (--skip-build flag set or Docker not available)"
else
  info "Building Docker image..."
  docker build \
    --platform linux/amd64 \
    -t "${IMAGE_NAME}:latest" \
    -t "${IMAGE_NAME}:$(git rev-parse --short HEAD 2>/dev/null || echo 'manual')" \
    --label "app=arco" \
    --label "component=recommender" \
    "${SCRIPT_DIR}"

  info "Pushing Docker image..."
  docker push "${IMAGE_NAME}" --all-tags

  success "Docker image built and pushed."
fi

info "Deploying to Cloud Run..."
SA_EMAIL="${SA_RECOMMENDER}@${PROJECT_ID}.iam.gserviceaccount.com"

if gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE_NAME}:latest" \
  --region="$REGION" \
  --platform=managed \
  --service-account="${SA_EMAIL}" \
  --cpu=2 \
  --memory=2Gi \
  --max-instances=10 \
  --timeout=3600 \
  --allow-unauthenticated \
  --labels="app=arco,component=recommender" \
  --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},GCP_LOCATION=${REGION},MODEL_PRESET=production,DA_ORG=${DA_ORG},DA_REPO=${DA_REPO},LOG_PROMPTS=true" \
  --set-secrets="DA_TOKEN=DA_TOKEN:latest" \
  --project="$PROJECT_ID" 2>/dev/null; then
  success "Cloud Run deployment complete."
else
  error "Cloud Run deployment failed. Ensure the Docker image exists and secrets are configured."
fi

# =============================================================================
# Step 9: Deploy Cloud Functions (if they exist)
# =============================================================================
step "Step 9: Deploy Cloud Functions"

FUNCTIONS_DIR="${SCRIPT_DIR}/functions"
if [ -d "$FUNCTIONS_DIR" ]; then
  # Map function directories to their entry points and service accounts
  declare -A FUNC_ENTRY_POINTS=(
    ["analytics"]="trackEvent"
    ["embeddings"]="searchBrewGuides"
  )
  declare -A FUNC_SERVICE_ACCOUNTS=(
    ["analytics"]="${SA_ANALYTICS}"
    ["embeddings"]="${SA_EMBEDDINGS}"
  )

  for func_dir in "${FUNCTIONS_DIR}"/*/; do
    if [ -d "$func_dir" ] && [ -f "${func_dir}package.json" ]; then
      func_name=$(basename "$func_dir")
      entry_point="${FUNC_ENTRY_POINTS[$func_name]:-$func_name}"
      sa_name="${FUNC_SERVICE_ACCOUNTS[$func_name]:-$SA_ANALYTICS}"
      sa_email="${sa_name}@${PROJECT_ID}.iam.gserviceaccount.com"

      # Build TypeScript before deploying
      echo -ne "  ${YELLOW}Building ${func_name}...${NC} "
      if (cd "$func_dir" && npm ci --quiet 2>/dev/null && npm run build 2>/dev/null); then
        echo -e "${GREEN}Built${NC}"
      else
        echo -e "${RED}Build failed${NC}"
        continue
      fi

      echo -ne "  ${YELLOW}Deploying ${func_name} (entry: ${entry_point})...${NC} "
      if gcloud functions deploy "arco-${func_name}" \
        --gen2 \
        --region="$REGION" \
        --runtime=nodejs20 \
        --source="$func_dir" \
        --entry-point="$entry_point" \
        --trigger-http \
        --allow-unauthenticated \
        --service-account="${sa_email}" \
        --set-env-vars="GCP_PROJECT_ID=${PROJECT_ID},GCP_LOCATION=${REGION}" \
        --update-labels="app=arco,component=${func_name}" \
        --project="$PROJECT_ID" 2>/dev/null; then
        echo -e "${GREEN}Deployed${NC}"
      else
        echo -e "${RED}Failed${NC}"
        warn "Function deployment failed. You can deploy manually: cd ${func_dir} && gcloud functions deploy arco-${func_name} ..."
      fi
    fi
  done
  success "Cloud Functions deployment complete."
else
  info "No Cloud Functions directory found at ${FUNCTIONS_DIR}. Skipping."
fi

# =============================================================================
# Step 10: Setup Monitoring
# =============================================================================
step "Step 10: Setup Monitoring"

if [ -f "${SCRIPT_DIR}/infrastructure/monitoring/setup-monitoring.sh" ]; then
  info "Running monitoring setup script..."
  export GCP_PROJECT_ID="$PROJECT_ID"
  export GCP_REGION="$REGION"
  bash "${SCRIPT_DIR}/infrastructure/monitoring/setup-monitoring.sh"
  success "Monitoring setup complete."
else
  warn "Monitoring setup script not found. Skipping."
fi

# =============================================================================
# Deployment Summary
# =============================================================================
step "Deployment Summary"

echo -e "${BOLD}${CYAN}Project:${NC}  ${PROJECT_ID}"
echo -e "${BOLD}${CYAN}Region:${NC}   ${REGION}"
echo ""

# Get Cloud Run URL
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format="value(status.url)" 2>/dev/null || echo "N/A")

echo -e "${BOLD}${CYAN}Service URLs:${NC}"
echo -e "  Recommender API:     ${GREEN}${SERVICE_URL}${NC}"
echo -e "  Health Check:        ${GREEN}${SERVICE_URL}/health${NC}"
echo ""

echo -e "${BOLD}${CYAN}Console URLs:${NC}"
echo -e "  Cloud Run:           https://console.cloud.google.com/run/detail/${REGION}/${SERVICE_NAME}?project=${PROJECT_ID}"
echo -e "  Firestore:           https://console.cloud.google.com/firestore?project=${PROJECT_ID}"
echo -e "  Secret Manager:      https://console.cloud.google.com/security/secret-manager?project=${PROJECT_ID}"
echo -e "  Vertex AI:           https://console.cloud.google.com/vertex-ai?project=${PROJECT_ID}"
echo -e "  Monitoring:          https://console.cloud.google.com/monitoring?project=${PROJECT_ID}"
echo -e "  Cloud Build:         https://console.cloud.google.com/cloud-build?project=${PROJECT_ID}"
echo -e "  Logs:                https://console.cloud.google.com/logs?project=${PROJECT_ID}"
echo ""

echo -e "${BOLD}${CYAN}Service Accounts:${NC}"
for sa_name in "${!SERVICE_ACCOUNTS[@]}"; do
  echo -e "  ${sa_name}@${PROJECT_ID}.iam.gserviceaccount.com"
done
echo ""

echo -e "${BOLD}${GREEN}Deployment complete!${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo -e "  1. Add DA_TOKEN secret value if not already set:"
echo -e "     ${BLUE}echo -n 'YOUR_TOKEN' | gcloud secrets versions add DA_TOKEN --data-file=- --project=${PROJECT_ID}${NC}"
echo -e "  2. Test the health endpoint:"
echo -e "     ${BLUE}curl ${SERVICE_URL}/health${NC}"
echo -e "  3. Configure Cloud Build trigger for CI/CD:"
echo -e "     ${BLUE}gcloud builds triggers create github --repo-owner=${DA_ORG} --repo-name=${DA_REPO} --branch-pattern='^main$' --build-config=cloudbuild.yaml --project=${PROJECT_ID}${NC}"
echo ""

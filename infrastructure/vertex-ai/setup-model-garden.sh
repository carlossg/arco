#!/usr/bin/env bash
# =============================================================================
# Verify Vertex AI Model Garden Access for Arco Project
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

echo -e "${BLUE}Verifying Vertex AI Model Garden access for project: ${PROJECT_ID}${NC}"
echo -e "${BLUE}Region: ${REGION}${NC}"
echo ""

# Verify Vertex AI API is enabled
echo -ne "${YELLOW}Checking Vertex AI API...${NC} "
if gcloud services list --enabled --project="$PROJECT_ID" --filter="config.name:aiplatform.googleapis.com" --format="value(config.name)" 2>/dev/null | grep -q "aiplatform"; then
  echo -e "${GREEN}Enabled${NC}"
else
  echo -e "${RED}Not enabled${NC}"
  echo -e "${YELLOW}Enabling Vertex AI API...${NC}"
  gcloud services enable aiplatform.googleapis.com --project="$PROJECT_ID"
  echo -e "${GREEN}Enabled${NC}"
fi

echo ""
echo -e "${BLUE}Verifying access to required models...${NC}"
echo ""

# Models to verify
declare -A MODELS=(
  ["gemini-2.0-flash"]="Google Gemini 2.0 Flash"
  ["gemini-2.0-flash-lite"]="Google Gemini 2.0 Flash Lite"
  ["gemini-2.5-pro-preview-05-06"]="Google Gemini 2.5 Pro"
  ["llama-3.1-405b-instruct-maas"]="Meta Llama 3.1 405B"
  ["mistral-large-2411"]="Mistral Large 24.11"
)

PASS_COUNT=0
FAIL_COUNT=0

for model_id in "${!MODELS[@]}"; do
  model_name="${MODELS[$model_id]}"
  echo -ne "  ${YELLOW}Checking ${model_name} (${model_id})...${NC} "

  # Try to get model info via the Vertex AI API
  RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $(gcloud auth print-access-token 2>/dev/null)" \
    "https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/${model_id}" \
    2>/dev/null || echo "000")

  if [ "$RESPONSE" = "200" ]; then
    echo -e "${GREEN}Available${NC}"
    PASS_COUNT=$((PASS_COUNT + 1))
  elif [ "$RESPONSE" = "404" ]; then
    # Try third-party publisher endpoints for non-Google models
    for publisher in "meta" "mistralai"; do
      RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "Authorization: Bearer $(gcloud auth print-access-token 2>/dev/null)" \
        "https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/${publisher}/models/${model_id}" \
        2>/dev/null || echo "000")
      if [ "$RESPONSE" = "200" ]; then
        break
      fi
    done

    if [ "$RESPONSE" = "200" ]; then
      echo -e "${GREEN}Available${NC}"
      PASS_COUNT=$((PASS_COUNT + 1))
    else
      echo -e "${YELLOW}Not found (may require Model Garden enablement)${NC}"
      FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
  else
    echo -e "${YELLOW}Unable to verify (HTTP ${RESPONSE})${NC}"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done

echo ""
echo -e "${BLUE}Results: ${GREEN}${PASS_COUNT} available${NC}, ${YELLOW}${FAIL_COUNT} need attention${NC}"
echo ""

if [ "$FAIL_COUNT" -gt 0 ]; then
  echo -e "${YELLOW}For models that could not be verified:${NC}"
  echo -e "  1. Visit https://console.cloud.google.com/vertex-ai/model-garden?project=${PROJECT_ID}"
  echo -e "  2. Search for the model and enable it"
  echo -e "  3. For third-party models (Llama, Mistral), you may need to accept terms of service"
  echo ""
fi

echo -e "${GREEN}Vertex AI Model Garden verification complete.${NC}"

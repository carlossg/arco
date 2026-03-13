#!/bin/bash
# Validates DA_TOKEN from .env and updates it in Google Cloud Secret Manager

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env file not found at $ENV_FILE"
  exit 1
fi

source "$ENV_FILE"

if [ -z "$DA_TOKEN" ]; then
  echo "ERROR: DA_TOKEN is not set in .env"
  exit 1
fi

PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [ -z "$PROJECT_ID" ]; then
  echo "ERROR: No GCP project set. Set GCP_PROJECT_ID in .env or configure gcloud."
  exit 1
fi

REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="arco-recommender"

echo "Validating DA_TOKEN..."

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $DA_TOKEN" \
  "https://admin.da.live/list/carlossg/arco")

if [ "$HTTP_STATUS" != "200" ]; then
  echo "FAILED: Token is invalid or expired (HTTP $HTTP_STATUS)"
  exit 1
fi

echo "OK: Token is valid (HTTP $HTTP_STATUS)"
echo "Updating DA_TOKEN secret in GCP project '$PROJECT_ID'..."

echo -n "$DA_TOKEN" | gcloud secrets versions add DA_TOKEN \
  --data-file=- \
  --project="$PROJECT_ID"

echo "Done: DA_TOKEN updated in Google Cloud Secret Manager."

echo "Redeploying Cloud Run service '$SERVICE_NAME' to pick up new secret..."

gcloud run services update "$SERVICE_NAME" \
  --region="$REGION" \
  --project="$PROJECT_ID"

echo "Done: Cloud Run service updated."

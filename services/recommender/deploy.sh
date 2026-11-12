#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
PROJECT="${GOOGLE_CLOUD_PROJECT:-api-project-642841493686}"
REGION="${GOOGLE_CLOUD_REGION:-us-central1}"
GENERATION_MODEL="${GEMINI_MODEL:-gemini-3.5-flash-lite}"
JUDGE_MODEL="${GEMINI_JUDGE_MODEL:-gemini-3.8-flash}"
GENERATION_LOCATION="${GEMINI_LOCATION:-global}"
SERVICE=arco-recommender-gcp
ACCOUNT="${SERVICE}@${PROJECT}.iam.gserviceaccount.com"
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
URL="$(gcloud run services list --project="$PROJECT" --region="$REGION" \
  --filter="metadata.name=$SERVICE" --format='value(status.url)')"
if [[ -z "$URL" ]]; then
  URL="https://${SERVICE}-${NUMBER}.${REGION}.run.app"
fi
TAG="$(git rev-parse --short HEAD)-$(date -u +%Y%m%d-%H%M%S)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/arco-gcp/recommender:$TAG"

SECRETS="ADMIN_TOKEN=arco-gcp-admin-token:latest"
DECISIONS_SECRET="${GEMINI_API_KEY_SECRET:-arco-gcp-gemini-api-key}"
DEFAULT_DECISIONS_MODE=off
DEFAULT_LAYOUT_PROVIDER=jev
DECISIONS_SECRET_NAME="$(gcloud secrets list --project="$PROJECT" \
  --filter="name:$DECISIONS_SECRET" --format='value(name)')"
if [[ -n "$DECISIONS_SECRET_NAME" ]]; then
  SECRETS="${SECRETS},GEMINI_API_KEY=${DECISIONS_SECRET}:latest"
  DEFAULT_DECISIONS_MODE=on
  DEFAULT_LAYOUT_PROVIDER=gemini
else
  printf '%s\n' 'WARNING: Gemini Decisions key is absent; preserving local rules and optional Jev layout.' >&2
fi
CLASSIFICATION_MODE="${DECISIONS_CLASSIFICATION_MODE:-$DEFAULT_DECISIONS_MODE}"
LAYOUT_MODE="${DECISIONS_LAYOUT_MODE:-$DEFAULT_DECISIONS_MODE}"
DECISION_JUDGE_MODE="${DECISIONS_JUDGE_MODE:-$DEFAULT_DECISIONS_MODE}"
LAYOUT_PROVIDER="${LAYOUT_DECISION_PROVIDER:-$DEFAULT_LAYOUT_PROVIDER}"
CONFIDENCE_THRESHOLD="${DECISIONS_CONFIDENCE_THRESHOLD:-0.7}"
DECISION_TIMEOUT="${DECISIONS_TIMEOUT_MS:-2000}"
DECISION_JUDGE_TIMEOUT="${DECISIONS_JUDGE_TIMEOUT_MS:-5000}"
JEV_SECRET="${TYPESAFE_API_KEY_SECRET:-arco-gcp-typesafe-api-key}"
JEV_SECRET_NAME="$(gcloud secrets list --project="$PROJECT" \
  --filter="name:$JEV_SECRET" --format='value(name)')"
if [[ -n "$JEV_SECRET_NAME" ]]; then
  SECRETS="${SECRETS},TYPESAFE_API_KEY=${JEV_SECRET}:latest"
fi
DECISIONS_CLASSIFICATION_MODE="$CLASSIFICATION_MODE" DECISIONS_LAYOUT_MODE="$LAYOUT_MODE" \
DECISIONS_JUDGE_MODE="$DECISION_JUDGE_MODE" LAYOUT_DECISION_PROVIDER="$LAYOUT_PROVIDER" \
DECISIONS_CONFIDENCE_THRESHOLD="$CONFIDENCE_THRESHOLD" \
GEMINI_API_KEY="$([[ "$DEFAULT_DECISIONS_MODE" == on ]] && printf configured || true)" \
  node --input-type=module -e \
  "import { validateDecisionConfig } from './workers/recommender/src/decisions.js'; validateDecisionConfig(process.env);"
DA_SECRET="$(gcloud secrets list --project="$PROJECT" \
  --filter='name:arco-gcp-da-token' --format='value(name)')"
if [[ -n "$DA_SECRET" ]]; then
  SECRETS="${SECRETS},DA_TOKEN=arco-gcp-da-token:latest"
else
  printf '%s\n' 'WARNING: Adobe DA credentials are not configured; page publishing will fail explicitly.' >&2
fi

bun install --cwd workers/recommender --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
bun install --cwd services/recommender --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
gcloud builds submit --project="$PROJECT" --region="$REGION" \
  --config=services/recommender/cloudbuild.yaml --substitutions="_IMAGE=$IMAGE" --quiet

gcloud run deploy "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --image="$IMAGE" --service-account="$ACCOUNT" --allow-unauthenticated \
  --min=0 --max=1 --concurrency=4 --cpu=1 --memory=512Mi \
  --cpu-throttling --timeout=600 --execution-environment=gen2 \
  --set-env-vars="CLOUD_PLATFORM=gcp,ENVIRONMENT=production,GOOGLE_CLOUD_PROJECT=$PROJECT,VERTEX_LOCATION=$REGION,GEMINI_LOCATION=$GENERATION_LOCATION,GEMINI_MODEL=$GENERATION_MODEL,GEMINI_JUDGE_MODEL=$JUDGE_MODEL,DECISIONS_CLASSIFICATION_MODE=$CLASSIFICATION_MODE,DECISIONS_LAYOUT_MODE=$LAYOUT_MODE,DECISIONS_JUDGE_MODE=$DECISION_JUDGE_MODE,LAYOUT_DECISION_PROVIDER=$LAYOUT_PROVIDER,DECISIONS_CONFIDENCE_THRESHOLD=$CONFIDENCE_THRESHOLD,DECISIONS_TIMEOUT_MS=$DECISION_TIMEOUT,DECISIONS_JUDGE_TIMEOUT_MS=$DECISION_JUDGE_TIMEOUT,SERVICE_URL=$URL,TASK_SERVICE_ACCOUNT=$ACCOUNT,PAYLOAD_BUCKET=arco-gcp-payloads-$NUMBER,DA_ORG=carlossg,DA_REPO=arco" \
  --set-secrets="$SECRETS" --quiet
DEPLOYED_URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT" \
  --region="$REGION" --format='value(status.url)')"
if [[ "$DEPLOYED_URL" != "$URL" ]]; then
  URL="$DEPLOYED_URL"
  gcloud run services update "$SERVICE" --project="$PROJECT" --region="$REGION" \
    --update-env-vars="SERVICE_URL=$URL" --quiet
fi
gcloud run services add-iam-policy-binding "$SERVICE" --project="$PROJECT" \
  --region="$REGION" --member="serviceAccount:$ACCOUNT" \
  --role=roles/run.invoker --quiet --format=none
gcloud tasks queues update arco-eval-gcp --project="$PROJECT" --location="$REGION" \
  --max-attempts=unlimited --max-retry-duration=0s \
  --max-dispatches-per-second=1 --max-concurrent-dispatches=1 --quiet

if gcloud scheduler jobs describe arco-eval-gcp --project="$PROJECT" \
  --location="$REGION" --format='value(name)' >/dev/null 2>&1; then
  SCHEDULER_ACTION=update
else
  SCHEDULER_ACTION=create
fi
gcloud scheduler jobs "$SCHEDULER_ACTION" http arco-eval-gcp \
  --project="$PROJECT" --location="$REGION" --schedule='*/5 * * * *' \
  --time-zone=UTC --uri="$URL/internal/scheduled" --http-method=POST \
  --oidc-service-account-email="$ACCOUNT" --oidc-token-audience="$URL" \
  --attempt-deadline=600s --quiet
curl --fail --silent --show-error --retry 3 --retry-all-errors "$URL/health"
printf '\n'
printf 'Google backend deployed: %s\n' "$URL"

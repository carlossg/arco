#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
PROJECT="${GOOGLE_CLOUD_PROJECT:-api-project-642841493686}"
REGION="${GOOGLE_CLOUD_REGION:-us-central1}"
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

bun install --cwd workers/recommender --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
bun install --cwd services/recommender --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
gcloud builds submit --project="$PROJECT" --region="$REGION" \
  --config=services/recommender/cloudbuild.yaml --substitutions="_IMAGE=$IMAGE" --quiet

SECRETS="ADMIN_TOKEN=arco-gcp-admin-token:latest"
DA_SECRET="$(gcloud secrets list --project="$PROJECT" \
  --filter='name:arco-gcp-da-token' --format='value(name)')"
if [[ -n "$DA_SECRET" ]]; then
  SECRETS="${SECRETS},DA_TOKEN=arco-gcp-da-token:latest"
else
  printf '%s\n' 'WARNING: Adobe DA credentials are not configured; page publishing will fail explicitly.' >&2
fi

gcloud run deploy "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --image="$IMAGE" --service-account="$ACCOUNT" --allow-unauthenticated \
  --min=0 --max=1 --concurrency=4 --cpu=1 --memory=512Mi \
  --cpu-throttling --timeout=600 --execution-environment=gen2 \
  --set-env-vars="CLOUD_PLATFORM=gcp,ENVIRONMENT=production,GOOGLE_CLOUD_PROJECT=$PROJECT,VERTEX_LOCATION=$REGION,GEMINI_MODEL=gemini-2.5-flash-lite,GEMINI_JUDGE_MODEL=gemini-2.5-flash,SERVICE_URL=$URL,TASK_SERVICE_ACCOUNT=$ACCOUNT,PAYLOAD_BUCKET=arco-gcp-payloads-$NUMBER,DA_ORG=carlossg,DA_REPO=arco" \
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

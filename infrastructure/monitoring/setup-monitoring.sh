#!/usr/bin/env bash
# =============================================================================
# Setup Cloud Monitoring Alerts for Arco Project
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
NOTIFICATION_EMAIL="${NOTIFICATION_EMAIL:-}"

if [ -z "$PROJECT_ID" ]; then
  echo -e "${RED}Error: No GCP project set. Set GCP_PROJECT_ID or run 'gcloud config set project <id>'${NC}"
  exit 1
fi

echo -e "${BLUE}Setting up Cloud Monitoring for project: ${PROJECT_ID}${NC}"
echo ""

# Create notification channel if email is provided
NOTIFICATION_CHANNEL_ID=""
if [ -n "$NOTIFICATION_EMAIL" ]; then
  echo -ne "${YELLOW}Creating email notification channel...${NC} "

  # Check if the channel already exists
  EXISTING_CHANNEL=$(gcloud alpha monitoring channels list \
    --project="$PROJECT_ID" \
    --filter="type='email' AND labels.email_address='${NOTIFICATION_EMAIL}'" \
    --format="value(name)" 2>/dev/null | head -1 || true)

  if [ -n "$EXISTING_CHANNEL" ]; then
    NOTIFICATION_CHANNEL_ID="$EXISTING_CHANNEL"
    echo -e "${GREEN}Already exists${NC}"
  else
    NOTIFICATION_CHANNEL_ID=$(gcloud alpha monitoring channels create \
      --project="$PROJECT_ID" \
      --display-name="Arco Alerts - ${NOTIFICATION_EMAIL}" \
      --type="email" \
      --channel-labels="email_address=${NOTIFICATION_EMAIL}" \
      --format="value(name)" 2>/dev/null || true)

    if [ -n "$NOTIFICATION_CHANNEL_ID" ]; then
      echo -e "${GREEN}Created${NC}"
    else
      echo -e "${YELLOW}Failed to create notification channel${NC}"
    fi
  fi
  echo ""
fi

# Build notification channel args
NOTIFICATION_ARGS=""
if [ -n "$NOTIFICATION_CHANNEL_ID" ]; then
  NOTIFICATION_ARGS="--notification-channels=${NOTIFICATION_CHANNEL_ID}"
fi

# -------------------------------------------------------------------
# Alert Policy: High Error Rate
# -------------------------------------------------------------------
echo -ne "${YELLOW}Creating alert: High Error Rate (arco-recommender)...${NC} "

# Check if alert already exists
EXISTING_ALERT=$(gcloud alpha monitoring policies list \
  --project="$PROJECT_ID" \
  --filter="displayName='Arco Recommender - High Error Rate'" \
  --format="value(name)" 2>/dev/null | head -1 || true)

if [ -n "$EXISTING_ALERT" ]; then
  echo -e "${GREEN}Already exists${NC}"
else
  POLICY_JSON=$(cat <<'POLICY_EOF'
{
  "displayName": "Arco Recommender - High Error Rate",
  "documentation": {
    "content": "The arco-recommender Cloud Run service is experiencing a high error rate (>5% of requests returning 5xx). Investigate the Cloud Run logs for details.",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "Error rate > 5%",
      "conditionThreshold": {
        "filter": "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"arco-recommender\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\"",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_RATE",
            "crossSeriesReducer": "REDUCE_SUM",
            "groupByFields": ["resource.labels.service_name"]
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0.05,
        "duration": "300s",
        "trigger": {
          "count": 1
        }
      }
    }
  ],
  "combiner": "OR",
  "enabled": true,
  "alertStrategy": {
    "autoClose": "1800s"
  }
}
POLICY_EOF
)

  # Add notification channels if available
  if [ -n "$NOTIFICATION_CHANNEL_ID" ]; then
    POLICY_JSON=$(echo "$POLICY_JSON" | python3 -c "
import sys, json
policy = json.load(sys.stdin)
policy['notificationChannels'] = ['$NOTIFICATION_CHANNEL_ID']
print(json.dumps(policy))
" 2>/dev/null || echo "$POLICY_JSON")
  fi

  TEMP_FILE=$(mktemp)
  echo "$POLICY_JSON" > "$TEMP_FILE"

  if gcloud alpha monitoring policies create \
    --project="$PROJECT_ID" \
    --policy-from-file="$TEMP_FILE" 2>/dev/null; then
    echo -e "${GREEN}Created${NC}"
  else
    echo -e "${YELLOW}Failed (may require additional permissions)${NC}"
  fi
  rm -f "$TEMP_FILE"
fi

# -------------------------------------------------------------------
# Alert Policy: High Latency
# -------------------------------------------------------------------
echo -ne "${YELLOW}Creating alert: High Latency (arco-recommender)...${NC} "

EXISTING_ALERT=$(gcloud alpha monitoring policies list \
  --project="$PROJECT_ID" \
  --filter="displayName='Arco Recommender - High Latency'" \
  --format="value(name)" 2>/dev/null | head -1 || true)

if [ -n "$EXISTING_ALERT" ]; then
  echo -e "${GREEN}Already exists${NC}"
else
  POLICY_JSON=$(cat <<'POLICY_EOF'
{
  "displayName": "Arco Recommender - High Latency",
  "documentation": {
    "content": "The arco-recommender Cloud Run service is experiencing high latency (p99 > 30s). This may indicate resource constraints or upstream service issues.",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "p99 latency > 30s",
      "conditionThreshold": {
        "filter": "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"arco-recommender\" AND metric.type = \"run.googleapis.com/request_latencies\"",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_PERCENTILE_99",
            "crossSeriesReducer": "REDUCE_MAX",
            "groupByFields": ["resource.labels.service_name"]
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 30000,
        "duration": "300s",
        "trigger": {
          "count": 1
        }
      }
    }
  ],
  "combiner": "OR",
  "enabled": true,
  "alertStrategy": {
    "autoClose": "1800s"
  }
}
POLICY_EOF
)

  if [ -n "$NOTIFICATION_CHANNEL_ID" ]; then
    POLICY_JSON=$(echo "$POLICY_JSON" | python3 -c "
import sys, json
policy = json.load(sys.stdin)
policy['notificationChannels'] = ['$NOTIFICATION_CHANNEL_ID']
print(json.dumps(policy))
" 2>/dev/null || echo "$POLICY_JSON")
  fi

  TEMP_FILE=$(mktemp)
  echo "$POLICY_JSON" > "$TEMP_FILE"

  if gcloud alpha monitoring policies create \
    --project="$PROJECT_ID" \
    --policy-from-file="$TEMP_FILE" 2>/dev/null; then
    echo -e "${GREEN}Created${NC}"
  else
    echo -e "${YELLOW}Failed (may require additional permissions)${NC}"
  fi
  rm -f "$TEMP_FILE"
fi

# -------------------------------------------------------------------
# Alert Policy: Instance Count High
# -------------------------------------------------------------------
echo -ne "${YELLOW}Creating alert: Instance Count High (arco-recommender)...${NC} "

EXISTING_ALERT=$(gcloud alpha monitoring policies list \
  --project="$PROJECT_ID" \
  --filter="displayName='Arco Recommender - Instance Count High'" \
  --format="value(name)" 2>/dev/null | head -1 || true)

if [ -n "$EXISTING_ALERT" ]; then
  echo -e "${GREEN}Already exists${NC}"
else
  POLICY_JSON=$(cat <<'POLICY_EOF'
{
  "displayName": "Arco Recommender - Instance Count High",
  "documentation": {
    "content": "The arco-recommender Cloud Run service has scaled to a high number of instances (>8 out of max 10). This may indicate an unexpected traffic spike or resource issues.",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "Instance count > 8",
      "conditionThreshold": {
        "filter": "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"arco-recommender\" AND metric.type = \"run.googleapis.com/container/instance_count\"",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_MAX",
            "crossSeriesReducer": "REDUCE_SUM",
            "groupByFields": ["resource.labels.service_name"]
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 8,
        "duration": "300s",
        "trigger": {
          "count": 1
        }
      }
    }
  ],
  "combiner": "OR",
  "enabled": true,
  "alertStrategy": {
    "autoClose": "1800s"
  }
}
POLICY_EOF
)

  if [ -n "$NOTIFICATION_CHANNEL_ID" ]; then
    POLICY_JSON=$(echo "$POLICY_JSON" | python3 -c "
import sys, json
policy = json.load(sys.stdin)
policy['notificationChannels'] = ['$NOTIFICATION_CHANNEL_ID']
print(json.dumps(policy))
" 2>/dev/null || echo "$POLICY_JSON")
  fi

  TEMP_FILE=$(mktemp)
  echo "$POLICY_JSON" > "$TEMP_FILE"

  if gcloud alpha monitoring policies create \
    --project="$PROJECT_ID" \
    --policy-from-file="$TEMP_FILE" 2>/dev/null; then
    echo -e "${GREEN}Created${NC}"
  else
    echo -e "${YELLOW}Failed (may require additional permissions)${NC}"
  fi
  rm -f "$TEMP_FILE"
fi

# -------------------------------------------------------------------
# Alert Policy: Memory Utilization High
# -------------------------------------------------------------------
echo -ne "${YELLOW}Creating alert: Memory Utilization High (arco-recommender)...${NC} "

EXISTING_ALERT=$(gcloud alpha monitoring policies list \
  --project="$PROJECT_ID" \
  --filter="displayName='Arco Recommender - Memory Utilization High'" \
  --format="value(name)" 2>/dev/null | head -1 || true)

if [ -n "$EXISTING_ALERT" ]; then
  echo -e "${GREEN}Already exists${NC}"
else
  POLICY_JSON=$(cat <<'POLICY_EOF'
{
  "displayName": "Arco Recommender - Memory Utilization High",
  "documentation": {
    "content": "The arco-recommender Cloud Run service is using more than 80% of its allocated memory (2Gi). This may lead to OOM kills. Consider increasing the memory limit or optimizing memory usage.",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "Memory utilization > 80%",
      "conditionThreshold": {
        "filter": "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"arco-recommender\" AND metric.type = \"run.googleapis.com/container/memory/utilizations\"",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_PERCENTILE_99",
            "crossSeriesReducer": "REDUCE_MAX",
            "groupByFields": ["resource.labels.service_name"]
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0.8,
        "duration": "300s",
        "trigger": {
          "count": 1
        }
      }
    }
  ],
  "combiner": "OR",
  "enabled": true,
  "alertStrategy": {
    "autoClose": "1800s"
  }
}
POLICY_EOF
)

  if [ -n "$NOTIFICATION_CHANNEL_ID" ]; then
    POLICY_JSON=$(echo "$POLICY_JSON" | python3 -c "
import sys, json
policy = json.load(sys.stdin)
policy['notificationChannels'] = ['$NOTIFICATION_CHANNEL_ID']
print(json.dumps(policy))
" 2>/dev/null || echo "$POLICY_JSON")
  fi

  TEMP_FILE=$(mktemp)
  echo "$POLICY_JSON" > "$TEMP_FILE"

  if gcloud alpha monitoring policies create \
    --project="$PROJECT_ID" \
    --policy-from-file="$TEMP_FILE" 2>/dev/null; then
    echo -e "${GREEN}Created${NC}"
  else
    echo -e "${YELLOW}Failed (may require additional permissions)${NC}"
  fi
  rm -f "$TEMP_FILE"
fi

echo ""
echo -e "${GREEN}Monitoring setup complete.${NC}"
echo ""
echo -e "${BLUE}View alerts at:${NC}"
echo -e "  https://console.cloud.google.com/monitoring/alerting?project=${PROJECT_ID}"
echo ""
echo -e "${BLUE}View Cloud Run metrics at:${NC}"
echo -e "  https://console.cloud.google.com/run/detail/${REGION}/arco-recommender/metrics?project=${PROJECT_ID}"

#!/bin/bash
set -euo pipefail

# Deploy the worker as a new version with a branch-specific preview alias.
# Uses Worker Versions — secrets and bindings are inherited from production.
# No separate worker is created.
#
# Usage: ./deploy-branch.sh [branch-name]
# If no branch name given, uses the current git branch.

BRANCH="${1:-$(git branch --show-current)}"

# Sanitize branch name for Cloudflare (lowercase, alphanumeric + hyphens only)
ALIAS=$(echo "$BRANCH" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/--*/-/g' | sed 's/^-\|-$//g')

if [ "$ALIAS" = "main" ] || [ "$ALIAS" = "production" ]; then
  echo "Error: Use 'npm run deploy' for production deployments."
  exit 1
fi

echo "Uploading worker version with preview alias: $ALIAS"

# Tag has a 25 char limit — truncate if needed
TAG=$(echo "$ALIAS" | cut -c1-25)
npx wrangler versions upload \
  --preview-alias "$ALIAS" \
  --tag "$TAG" \
  --message "Branch: $ALIAS"

WORKER_URL="https://${ALIAS}-arco-recommender.franklin-prod.workers.dev"

echo ""
echo "Branch version deployed successfully."
echo ""
echo "  Worker:   $WORKER_URL"
echo "  Health:   $WORKER_URL/api/health"
echo "  Frontend: https://${BRANCH}--arco--froesef.aem.page/discover"
echo ""
echo "All secrets and bindings are inherited from production. No setup needed."

#!/bin/bash
set -euo pipefail

# Clean up a branch version's preview alias.
# The version itself is garbage-collected by Cloudflare automatically.
#
# Usage: ./cleanup-branch.sh [branch-name]
# If no branch name given, uses the current git branch.

BRANCH="${1:-$(git branch --show-current)}"

# Sanitize branch name (same logic as deploy-branch.sh)
ALIAS=$(echo "$BRANCH" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/--*/-/g' | sed 's/^-\|-$//g')

if [ "$ALIAS" = "main" ] || [ "$ALIAS" = "production" ]; then
  echo "Error: Cannot delete production environment."
  exit 1
fi

echo "Removing preview alias: $ALIAS"

npx wrangler versions upload \
  --preview-alias "$ALIAS" \
  --message "Cleanup: releasing alias $ALIAS"

echo "Done. Alias '$ALIAS' now points to current production code."

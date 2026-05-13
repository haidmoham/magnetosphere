#!/bin/bash
# Merge staging → main and push to trigger production deploy.
# Run from the staging branch.
set -euo pipefail
CURRENT=$(git branch --show-current)
if [ "$CURRENT" != "staging" ]; then
  echo "Run this from the staging branch (currently on $CURRENT)"
  exit 1
fi
git checkout main
git merge staging --no-edit
git push
echo "Promoted to production — watching logs..."
sleep 8
railway logs --lines 25
git checkout staging

#!/bin/bash
# Commit and push to staging branch — Railway auto-deploys to staging env.
# Usage: ./scripts/deploy-staging.sh "commit message"
MSG="${1:-wip}"
git add -A
git commit -m "$MSG"
git push
echo "Pushed to staging — watching logs..."
sleep 8
railway environment staging
railway logs --lines 25
railway environment production

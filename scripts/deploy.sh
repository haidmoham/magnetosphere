#!/bin/bash
# Commit, push to GitHub, and deploy to Railway.
# Usage: ./scripts/deploy.sh "commit message"
# Note: once GitHub auto-deploy is connected in Railway dashboard
#       (Service → Settings → Source → Connect Repo), `railway up` can be dropped.
MSG="${1:-deploy}"
git add -A
git commit -m "$MSG"
git push
railway up --detach
echo "Deploy triggered — watching logs..."
sleep 8
railway logs --lines 25

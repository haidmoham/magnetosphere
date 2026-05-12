#!/bin/bash
# Commit and push — Railway auto-deploys from main on push.
# Usage: ./scripts/deploy.sh "commit message"
MSG="${1:-deploy}"
git add -A
git commit -m "$MSG"
git push
echo "Pushed — watching logs..."
sleep 8
railway logs --lines 25

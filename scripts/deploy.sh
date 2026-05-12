#!/bin/bash
# Commit everything and push to trigger Railway deploy
# Usage: ./scripts/deploy.sh "commit message"
MSG="${1:-deploy}"
git add -A
git commit -m "$MSG"
git push
echo "Pushed — watching logs..."
sleep 8
railway logs --lines 20

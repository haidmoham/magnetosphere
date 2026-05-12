#!/bin/bash
# Checks that all required env vars are set on Railway
REQUIRED=(FLASK_SECRET_KEY APP_VERSION)
echo "=== Railway env vars ==="
railway variables 2>&1
echo ""
echo "=== Missing vars check ==="
for var in "${REQUIRED[@]}"; do
  val=$(railway variables 2>/dev/null | grep "^║ $var" | awk -F'│' '{print $2}' | xargs)
  if [ -z "$val" ]; then
    echo "❌ MISSING: $var"
  else
    echo "✅ $var"
  fi
done

#!/bin/bash
# Usage: ./scripts/logs.sh [lines]
railway logs --lines "${1:-50}"

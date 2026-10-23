#!/usr/bin/env bash
# Universal AI Notifier - Bash / CI-CD Helper (1-liner curl)
# Usage: ./notify.sh "Task Name" "Summary of result"

TASK="${1:-Build completed}"
SUMMARY="${2:-Pipeline finished successfully}"
WORKSPACE="${WORKSPACE:-$(basename "$PWD")}"
USER_NAME="${USER:-$(whoami)}"

curl -s -X POST "${ANTIGRAVITY_TELEGRAM_URL:?Missing ANTIGRAVITY_TELEGRAM_URL}" \
  -H "Content-Type: application/json" \
  ${ANTIGRAVITY_TELEGRAM_SECRET:+-H "Authorization: Bearer $ANTIGRAVITY_TELEGRAM_SECRET"} \
  -d "{\"workspace\":\"$WORKSPACE\",\"prompt\":\"$TASK\",\"summary\":\"$SUMMARY\",\"user\":\"$USER_NAME\"}"

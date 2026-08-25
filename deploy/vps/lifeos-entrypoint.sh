#!/usr/bin/env bash
#
# LifeOS Inbox — sidecar entrypoint for the Hermes VPS (Docker).
#
# One container, three jobs:
#   - foreground : the 5-minute incremental Gmail sync loop (keeps the container alive)
#   - background : every 5 min, regenerate the read-only surfaces as text files the
#                  Hermes agent reads (/opt/hermes/skills/lifeos-inbox/out/*.txt)
#   - background : deliver the morning brief once a day at 07:00 IST (01:30 UTC)
#
# No -e: a single failing command must not kill the loop or the container.
set -uo pipefail

APP=/opt/lifeos-inbox
OUT=/out
cd "$APP" || { echo "FATAL: $APP not mounted"; sleep 30; exit 1; }

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
run() { node --env-file-if-exists=.env apps/worker/src/index.ts "$@"; }

# 1. Dependencies. There is no build step (Node >= 22.18 strips TypeScript natively);
#    we only need the two runtime deps installed once into the bind-mounted checkout.
if [ ! -d node_modules ]; then
  log "installing runtime dependencies (first run)…"
  npm ci --omit=dev --no-fund --no-audit || npm install --no-fund --no-audit
fi

mkdir -p "$OUT"

# 2. Background: surface refresh + daily brief.
(
  while true; do
    for cmd in status money loops radar metrics; do
      if run "$cmd" >"$OUT/$cmd.txt.tmp" 2>&1; then
        mv "$OUT/$cmd.txt.tmp" "$OUT/$cmd.txt"
      else
        rm -f "$OUT/$cmd.txt.tmp"
      fi
    done
    if run brief --dry >"$OUT/brief.txt.tmp" 2>&1; then
      mv "$OUT/brief.txt.tmp" "$OUT/brief.txt"
    else
      rm -f "$OUT/brief.txt.tmp"
    fi
    date -u +%FT%TZ >"$OUT/refreshed-at.txt"

    # Daily brief at 07:00 IST == 01:30 UTC (India has no DST, so a fixed UTC
    # offset is safe and avoids a tzdata dependency in the slim image).
    mins=$((10#$(date -u +%H) * 60 + 10#$(date -u +%M)))   # minutes since 00:00 UTC
    today=$(date -u +%F)
    if [ "$mins" -ge 90 ] && [ "$mins" -lt 95 ] && [ ! -f "$OUT/.brief-$today" ]; then
      log "delivering 07:00 IST brief"
      run brief >>"$OUT/brief-delivery.log" 2>&1 || true
      : >"$OUT/.brief-$today"
    fi

    sleep 300
  done
) &

# 3. Foreground: the incremental sync loop. If the mailbox is not linked yet
#    (no .tokens.json) it records lastSyncOk=false and keeps running rather than
#    crash-looping, so surfaces stay empty until you connect Gmail.
log "starting Gmail poll loop"
exec node --env-file-if-exists=.env apps/worker/src/index.ts poll

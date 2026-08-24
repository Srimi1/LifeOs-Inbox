#!/usr/bin/env bash
#
# Install LifeOS Inbox next to a Hermes agent and register it as a skill.
#
#   ./scripts/deploy-to-hermes.sh                      # local Hermes
#   ./scripts/deploy-to-hermes.sh root@your.vps.ip     # over SSH
#
# Idempotent: safe to re-run. It never touches the mailbox, never writes
# credentials, and never overwrites an existing owner.json or cards.json.
set -euo pipefail

TARGET="${1:-}"
LIFEOS_REPO="${LIFEOS_REPO:-https://github.com/Srimi1/LifeOs-Inbox.git}"
LIFEOS_HOME="${LIFEOS_HOME:-/opt/lifeos-inbox}"
HERMES_HOME="${HERMES_HOME:-\$HOME/.hermes/hermes-agent}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=18

remote() {
  if [ -n "$TARGET" ]; then ssh "$TARGET" "$@"; else bash -c "$@"; fi
}

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

say "1. Checking the target"
remote "
  set -e
  if ! command -v node >/dev/null 2>&1; then
    echo 'FAIL: node is not installed.'
    echo 'Install Node 22.18+ first — LifeOS relies on native TypeScript type'
    echo 'stripping, which older releases do not have. On Debian/Ubuntu:'
    echo '  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs'
    exit 1
  fi
  v=\$(node -p 'process.versions.node')
  maj=\${v%%.*}; rest=\${v#*.}; min=\${rest%%.*}
  if [ \"\$maj\" -lt $MIN_NODE_MAJOR ] || { [ \"\$maj\" -eq $MIN_NODE_MAJOR ] && [ \"\$min\" -lt $MIN_NODE_MINOR ]; }; then
    echo \"FAIL: node \$v is too old. LifeOS needs >= $MIN_NODE_MAJOR.$MIN_NODE_MINOR (it runs TypeScript without a build step).\"
    exit 1
  fi
  echo \"  node \$v — ok\"
  if [ ! -d \"$HERMES_HOME\" ]; then
    echo \"FAIL: no Hermes agent at $HERMES_HOME. Set HERMES_HOME and re-run.\"
    exit 1
  fi
  echo \"  hermes at $HERMES_HOME — ok\"
"

say "2. Installing LifeOS at $LIFEOS_HOME"
remote "
  set -e
  if [ -d '$LIFEOS_HOME/.git' ]; then
    cd '$LIFEOS_HOME' && git pull --ff-only && echo '  updated'
  else
    git clone --depth 50 '$LIFEOS_REPO' '$LIFEOS_HOME' && echo '  cloned'
  fi
  cd '$LIFEOS_HOME' && npm ci --omit=dev --no-fund --no-audit >/dev/null 2>&1 || npm install --no-fund --no-audit >/dev/null
  echo '  dependencies installed'
"

say "3. Registering the Hermes skill"
remote "
  set -e
  dest=\"$HERMES_HOME/skills/productivity/lifeos-inbox\"
  mkdir -p \"\$dest/references\"
  cp '$LIFEOS_HOME/integrations/hermes/SKILL.md' \"\$dest/SKILL.md\"
  cp '$LIFEOS_HOME/integrations/hermes/references/output-shapes.md' \"\$dest/references/\"
  echo \"  skill installed at \$dest\"
"

say "4. Seeding config (never overwrites what is already there)"
remote "
  set -e
  cd '$LIFEOS_HOME'
  for f in owner cards; do
    if [ -f \"\$f.json\" ]; then
      echo \"  \$f.json exists — left alone\"
    else
      cp \"\$f.example.json\" \"\$f.json\" && echo \"  \$f.json seeded from example — EDIT IT\"
    fi
  done
  [ -f .env ] || { cp .env.example .env && echo '  .env seeded from example — EDIT IT'; }
  grep -qxF 'export LIFEOS_HOME=$LIFEOS_HOME' ~/.bashrc 2>/dev/null || echo 'export LIFEOS_HOME=$LIFEOS_HOME' >> ~/.bashrc
"

say "5. Verifying"
remote "cd '$LIFEOS_HOME' && npm run typecheck >/dev/null 2>&1 && echo '  typecheck clean' || echo '  typecheck FAILED'"
remote "cd '$LIFEOS_HOME' && node apps/worker/src/index.ts status 2>&1 | tail -3"

say "Done. Remaining steps, which need a human:"
cat <<'NEXT'
  1. Edit owner.json and cards.json  — your card tails and rules. These are
     gitignored and must never be committed.
  2. Edit .env                        — GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET,
     and optionally ANTHROPIC_API_KEY and RESEND_API_KEY.
  3. Run `npm run auth` ON A MACHINE WITH A BROWSER. The OAuth consent flow
     listens on localhost:8787, so it cannot complete on a headless VPS.
     Afterwards copy .tokens.json to the VPS over scp — never into git.
  4. Then on the VPS: `npm run backfill`, and `npm run poll` under a process
     manager (systemd or pm2) so sync keeps running.

  Until step 3 is done every LifeOS command returns empty, and that emptiness
  means "not connected", not "nothing to do".
NEXT

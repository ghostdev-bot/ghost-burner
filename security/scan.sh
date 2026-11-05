#!/usr/bin/env bash
# Ghost Burner free security scans. Usage: security/scan.sh [--baseline]
# Writes:
#   security/runs/<date>/raw/*.json      raw tool output
#   security/runs/<date>/findings.json   normalized, sorted findings (diffable)
#   security/logs/<date>.log             human log
#   security/latest.json                 copy of the newest findings.json
#   with --baseline also security/baseline.json
# Then prints a diff vs security/baseline.json (new / resolved findings, changed checks).
# Never prints secrets: gitleaks runs with --redact; Helius key is masked in any output.
set -uo pipefail
export TZ=America/New_York
export PATH="$HOME/.local/bin:$PATH"
ROOT=/workspace/ghostburner
APP=$ROOT/app
REPO=${GB_REPO:-/workspace/gh-publish/ghost-burner}
SITE_URL=${GB_SITE_URL:-https://ghostburner.surge.sh}
SEC=$ROOT/security
DATE=$(date +%F)
RUN=$SEC/runs/$DATE; RAW=$RUN/raw
mkdir -p "$RAW" "$SEC/logs"
LOG=$SEC/logs/$DATE.log
exec > >(tee "$LOG") 2>&1
echo "Ghost Burner security scan $(date '+%F %T %Z')"
ver() { "$@" 2>/dev/null | head -1; }
echo "tools: npm $(npm -v) | $(ver osv-scanner --version) | semgrep $(ver semgrep --version) | gitleaks $(ver gitleaks version)"

echo "== 1. npm audit (production deps)"
( cd "$APP" && npm audit --omit=dev --json > "$RAW/npm-audit-prod.json" ); echo "exit $?"
( cd "$APP" && npm audit --json > "$RAW/npm-audit-all.json" ); echo "(all deps incl. dev) exit $?"

echo "== 2. OSV-Scanner (package-lock.json)"
osv-scanner scan source --lockfile "$APP/package-lock.json" --format json --output-file "$RAW/osv.json" >/dev/null 2>&1; echo "exit $? (1 = vulns found)"

echo "== 3. Semgrep (p/javascript p/security-audit p/secrets p/xss)"
SG_TARGETS=$(cd "$APP" && ls -d index.html refer.html how.html security.html vite.config.js sw.template.js src 2>/dev/null)
( cd "$APP" && semgrep scan --metrics=off --quiet --config p/javascript --config p/security-audit --config p/secrets --config p/xss \
    --exclude node_modules --json --output "$RAW/semgrep.json" $SG_TARGETS ); echo "exit $?"

echo "== 4. gitleaks (repo history + working tree, --redact)"
gitleaks git "$REPO" --redact --no-banner --report-format json --report-path "$RAW/gitleaks-git.json" >/dev/null 2>&1; echo "git exit $?"
gitleaks dir "$REPO" --redact --no-banner --report-format json --report-path "$RAW/gitleaks-dir.json" >/dev/null 2>&1; echo "dir exit $?"

echo "== 5. Live site checks ($SITE_URL)"
python3 "$SEC/live_check.py" "$SITE_URL" "$ROOT/site" > "$RAW/live.json"; echo "exit $?"

echo "== Normalize + compare"
python3 "$SEC/normalize.py" "$RAW" "$RUN/findings.json" "$DATE"
cp "$RUN/findings.json" "$SEC/latest.json"
[ "${1:-}" = "--baseline" ] && cp "$RUN/findings.json" "$SEC/baseline.json" && echo "baseline updated"
python3 "$SEC/compare.py" "$SEC/baseline.json" "$RUN/findings.json"

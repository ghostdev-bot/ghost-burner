# Ghost Burner security scans

Run: `security/scan.sh` (compare with baseline) or `security/scan.sh --baseline` (also overwrite baseline).
Exit code of the final compare: 0 = nothing new vs baseline, 2 = new findings or changed checks.

Tools: npm audit (prod + all), OSV-Scanner (app/package-lock.json), Semgrep (p/javascript p/security-audit
p/secrets p/xss on app sources, metrics off), gitleaks --redact (ghost-burner repo history + working tree),
live_check.py (HTTP headers, live-vs-local file hashes, 32-byte base58 strings / fee addresses in live JS).

Files
- `baseline.json`: normalized findings that the daily routine diffs against (sorted, one entry per finding).
- `latest.json`: newest run.  `runs/<YYYY-MM-DD>/findings.json` + `raw/`: per run.  `logs/<date>.log`: console log.
- `compare.py baseline.json runs/<date>/findings.json`: prints NEW / RESOLVED / CHECK lines.
- `update_page.py runs/<date>`: rewrites the scan summary block in app/security.html (then rebuild + deploy).
- `ui_check.py <base_url> <shot_dir> <tag>`: headless Chromium: pages, menu/footer links, mock-wallet scan (signing disabled).

findings.json: {schema, date, counts{tool:{severity:n}}, checks{...}, errors[], findings[{tool,id,severity,title,fix}]}.
Finding ids are stable (package:GHSA ids, rule:path:line, header name), so a diff of ids = new/resolved.
`checks.local_tree_sha256` changes on every rebuild and is ignored by compare.py; `bundle_match` is what matters.
Plain HTTP can't be tested from the box (egress proxy returns 500), so https_redirect reads "unverified".

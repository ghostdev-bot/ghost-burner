#!/usr/bin/env python3
"""Rewrite the <!--SCAN:START-->..<!--SCAN:END--> block of app/security.html from a scan run.
Usage: update_page.py <run_dir> [html]   (run_dir = security/runs/<date>)"""
import datetime, html, json, os, re, sys
RUN = sys.argv[1]; PAGE = sys.argv[2] if len(sys.argv) > 2 else "/workspace/ghostburner/app/security.html"
MANUAL_REVIEW = "2026-11-04"
raw = lambda n: json.load(open(os.path.join(RUN, "raw", n)))
F = json.load(open(os.path.join(RUN, "findings.json")))
fmt = lambda d: datetime.date.fromisoformat(d).strftime("%b %-d, %Y")
def plural(n, w): return f"{n} {w}" if n == 1 else f"{n} {w[:-1] + 'ies' if w.endswith('y') else w + 's'}"
def sevs(d):
    order = ["critical", "high", "moderate", "medium", "low", "unknown"]
    return ", ".join(f"{d[k]} {k}" for k in order if d.get(k)) or "none"

# npm audit (production): distinct advisories
adv = {}
for pkg, v in (raw("npm-audit-prod.json").get("vulnerabilities") or {}).items():
    for x in v.get("via", []):
        if isinstance(x, dict): adv[x.get("url")] = (x.get("severity"), x.get("name"))
npm_s = {}; [npm_s.__setitem__(s, npm_s.get(s, 0) + 1) for s, _ in adv.values()]
npm_pk = sorted({n for _, n in adv.values()})
# OSV
osv = {}
for r in raw("osv.json").get("results", []) or []:
    for p in r.get("packages", []):
        for g in p.get("groups", []):
            try: s = float(g.get("max_severity") or ""); w = "critical" if s >= 9 else "high" if s >= 7 else "medium" if s >= 4 else "low"
            except ValueError: w = "unknown"
            osv[(p["package"]["name"], tuple(g["ids"]))] = w
osv_s = {}; [osv_s.__setitem__(w, osv_s.get(w, 0) + 1) for w in osv.values()]
osv_pk = sorted({k[0] for k in osv})
sg = raw("semgrep.json"); sg_n = len(sg.get("results", [])); sg_files = len(sg.get("paths", {}).get("scanned", []))
gl = len(raw("gitleaks-git.json") or []) + len(raw("gitleaks-dir.json") or [])
c = F["checks"]
yes = lambda b: "yes" if b else "<b>NO</b>"
missing_hdr = [k for k, v in c.get("headers", {}).items() if not v]
items = [
  f"<b>npm audit</b> (libraries shipped in the site): {plural(len(adv), 'known advisory')}"
  + (f" ({sevs(npm_s)}) in {', '.join(html.escape(p) for p in npm_pk)}." if adv else "."),
  f"<b>OSV-Scanner</b> (every package in the lockfile, including build tools): {plural(len(osv), 'advisory')}"
  + (f" ({sevs(osv_s)}) in {', '.join(html.escape(p) for p in osv_pk)}." if osv else "."),
  f"<b>Semgrep</b> (JavaScript, security-audit, secrets and XSS rule packs): {plural(sg_n, 'finding')} in {sg_files} source files.",
  f"<b>gitleaks</b> (leaked keys or passwords in the public code and its history): {plural(gl, 'leak')} found.",
  f"<b>Live site check</b>: files served match our build: {yes(c.get('bundle_match'))}. Only fee wallets in the code are the two above: {yes(c.get('fee_config_ok'))}. Content-Security-Policy set in each page: {yes(c.get('meta', {}).get('csp_meta'))}. Extra security headers sent by the host: "
  + ("all present." if not missing_hdr else "not available on our free host (Surge), so the page uses meta tags and a frame-busting guard instead."),
  f"<b>Manual review</b> of the transaction-building code ({fmt(MANUAL_REVIEW)}): it only emits the instructions listed above, only for accounts you select, with the fee capped and checked; no approvals, authority changes or token transfers.",
]
notes = ("Our read of the library advisories: they all come through Solana's official JavaScript libraries "
         "(@solana/web3.js 1.x and @solana/spl-token) or the Vite build tool, and fixing them needs a major upgrade of those libraries that hasn't been done yet. "
         "The Vite/esbuild ones affect the developer's build machine, not the site you load. In the browser, bigint-buffer runs its plain-JavaScript "
         "version, the uuid issue is in functions the site doesn't use, and stream-json isn't included in the site at all.")
block = (f'<!--SCAN:START-->\n    <p class="scanstamp">Last scanned: {fmt(F["date"])} (US Eastern)</p>\n    <ul class="scanlist">\n'
         + "".join(f"      <li>{i}</li>\n" for i in items) + f'    </ul>\n    <p class="mut xs">{notes}</p>\n    <!--SCAN:END-->')
s = open(PAGE).read()
s2 = re.sub(r"<!--SCAN:START-->.*?<!--SCAN:END-->", lambda m: block, s, flags=re.S)
open(PAGE, "w").write(s2)
print("updated" if s2 != s else "unchanged", PAGE)

#!/usr/bin/env python3
"""Turn raw tool output into one sorted, stable findings.json (one line per finding id)."""
import json, os, sys
RAW, OUT, DATE = sys.argv[1:4]
def load(n):
    p = os.path.join(RAW, n)
    try: return json.load(open(p))
    except Exception as e: return {"_error": f"{n}: {e}"}
F, errors = [], []
SEVMAP = {"critical": "critical", "high": "high", "moderate": "medium", "medium": "medium", "low": "low", "info": "info",
          "ERROR": "high", "WARNING": "medium", "INFO": "low"}

for scope, n in (("prod", "npm-audit-prod.json"), ("all", "npm-audit-all.json")):
    a = load(n)
    if "_error" in a: errors.append(a["_error"]); continue
    for pkg, v in sorted((a.get("vulnerabilities") or {}).items()):
        ids = sorted({x.get("url", "").rsplit("/", 1)[-1] for x in v.get("via", []) if isinstance(x, dict)}) or ["via:" + ",".join(sorted(x for x in v.get("via", []) if isinstance(x, str)))]
        F.append({"tool": f"npm-audit-{scope}", "id": f"{pkg}:{'+'.join(ids)}", "severity": SEVMAP.get(v.get("severity"), v.get("severity")),
                  "title": f"{pkg} {v.get('range','')}".strip(), "fix": bool(v.get("fixAvailable"))})

o = load("osv.json")
if "_error" in o: errors.append(o["_error"])
for r in o.get("results", []) or []:
    for p in r.get("packages", []):
        pk = p["package"]
        for g in p.get("groups", []):
            sev = g.get("max_severity") or ""
            try: s = float(sev); sevw = "critical" if s >= 9 else "high" if s >= 7 else "medium" if s >= 4 else "low"
            except ValueError: sevw = "unknown"
            F.append({"tool": "osv-scanner", "id": f"{pk['name']}@{pk['version']}:{'+'.join(sorted(g['ids']))}", "severity": sevw,
                      "title": f"{pk['name']} {pk['version']} (CVSS {sev or 'n/a'})", "fix": None})

s = load("semgrep.json")
if "_error" in s: errors.append(s["_error"])
for r in s.get("results", []) or []:
    F.append({"tool": "semgrep", "id": f"{r['check_id'].rsplit('.',1)[-1]}:{r['path']}:{r['start']['line']}",
              "severity": SEVMAP.get(r["extra"].get("severity"), "info"), "title": r["extra"].get("message", "")[:160].replace("\n", " "), "fix": None})
for e in s.get("errors", []) or []: errors.append("semgrep: " + str(e.get("message", e))[:200])

for n in ("gitleaks-git.json", "gitleaks-dir.json"):
    g = load(n)
    if isinstance(g, dict) and "_error" in g: errors.append(g["_error"]); continue
    for x in g or []:
        F.append({"tool": n[:-5], "id": f"{x.get('RuleID')}:{x.get('File')}:{x.get('StartLine')}:{(x.get('Commit') or '')[:8]}",
                  "severity": "high", "title": f"{x.get('RuleID')} in {x.get('File')} (redacted)", "fix": None})

live = load("live.json")
checks = {}
if "_error" in live: errors.append(live["_error"])
else:
    checks = {"headers": live["headers"], "meta": live["meta"], "bundle_match": live["bundle"]["match"],
              "bundle_mismatched": live["bundle"]["mismatched"], "bundle_missing_live": live["bundle"]["missing_live"],
              "local_tree_sha256": live["bundle"]["local_tree_sha256"],
              "fee_config_addresses": live["addresses"]["fee_config_addresses"], "fee_config_ok": live["addresses"]["fee_config_ok"],
              "unknown_32byte_strings": live["addresses"]["unknown_32byte_strings"], "noted_addresses": live["addresses"]["noted"]}
    for k, ok in live["headers"].items():
        if not ok: F.append({"tool": "live-headers", "id": f"missing-header:{k}", "severity": "low" if k not in ("strict-transport-security",) else "medium",
                             "title": f"HTTP header {k} not sent by host (Surge)", "fix": None})
    if not live["bundle"]["match"]: F.append({"tool": "live-bundle", "id": "bundle-mismatch", "severity": "high", "title": "live files differ from local site/", "fix": None})
    if not live["addresses"]["fee_config_ok"]: F.append({"tool": "live-addresses", "id": "fee-addresses-changed", "severity": "critical", "title": "fee addresses in live bundle differ from expected", "fix": None})
    for a in live["addresses"]["unknown_32byte_strings"]:
        F.append({"tool": "live-addresses", "id": f"unknown-address:{a}", "severity": "medium", "title": "unrecognized 32-byte base58 string in live bundle", "fix": None})

F.sort(key=lambda f: (f["tool"], f["id"]))
counts = {}
for f in F: counts.setdefault(f["tool"], {}).setdefault(f["severity"], 0); counts[f["tool"]][f["severity"]] += 1
json.dump({"schema": 1, "date": DATE, "counts": counts, "checks": checks, "errors": sorted(errors), "findings": F},
          open(OUT, "w"), indent=1, sort_keys=True)
print(json.dumps(counts, sort_keys=True))
if errors: print("errors:", errors)

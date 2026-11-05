#!/usr/bin/env python3
"""Diff a findings.json against the baseline. Exit 0 = nothing new, 2 = new findings or changed checks."""
import json, sys
try: base = json.load(open(sys.argv[1]))
except FileNotFoundError: print("no baseline yet"); sys.exit(0)
cur = json.load(open(sys.argv[2]))
key = lambda f: f["tool"] + "|" + f["id"]
b, c = {key(f): f for f in base["findings"]}, {key(f): f for f in cur["findings"]}
new = sorted(set(c) - set(b)); gone = sorted(set(b) - set(c))
ignore = {"local_tree_sha256"}
chk = sorted(k for k in set(base["checks"]) | set(cur["checks"]) if k not in ignore and base["checks"].get(k) != cur["checks"].get(k))
print(f"baseline {base['date']} -> {cur['date']}: {len(new)} new, {len(gone)} resolved, {len(chk)} changed checks")
for k in new: print(f"  NEW [{c[k]['severity']}] {k}: {c[k]['title']}")
for k in gone: print(f"  RESOLVED {k}")
for k in chk: print(f"  CHECK {k}: {base['checks'].get(k)} -> {cur['checks'].get(k)}")
sys.exit(2 if new or chk else 0)

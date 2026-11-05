#!/usr/bin/env python3
"""Live checks: security headers, live-vs-local bundle hashes, addresses in the live JS."""
import hashlib, json, os, re, sys, urllib.request

SITE, LOCAL = sys.argv[1].rstrip('/'), sys.argv[2]
EXPECTED_FEE = {"E3MnPuZXY52cisZj5p47x2seZn2kR1JzVs125mvSMkAY": "$GHOSTDEV treasury",
                "AgKx7ZTkRB13j2Ai5g1pLeUVoxdGbKbRVn4HGJrzr4C2": "BOBO buy"}
# Well-known program / sysvar / mint IDs that ship inside @solana/web3.js, spl-token and the app.
KNOWN = set("""11111111111111111111111111111111 TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
So11111111111111111111111111111111111111112 9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP
metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s ComputeBudget111111111111111111111111111111
Vote111111111111111111111111111111111111111 Stake11111111111111111111111111111111111111
StakeConfig11111111111111111111111111111111 Va1idator1nfo111111111111111111111111111111
SysvarStakeHistory1111111111111111111111111 SysvarS1otHistory11111111111111111111111111
SysvarS1otHashes111111111111111111111111111 SysvarRewards111111111111111111111111111111
SysvarRent111111111111111111111111111111111 SysvarRecentB1ockHashes11111111111111111111
SysvarEpochSchedu1e111111111111111111111111 SysvarC1ock11111111111111111111111111111111
Sysvar1nstructions1111111111111111111111111 KeccakSecp256k11111111111111111111111111111
Ed25519SigVerify111111111111111111111111111 BPFLoader2111111111111111111111111111111111
BPFLoader1111111111111111111111111111111111 BPFLoaderUpgradeab1e11111111111111111111111
AddressLookupTab1e1111111111111111111111111 Secp256r1SigVerify1111111111111111111111111""".split())
# Known-wrong legacy constant used only by the read-only referral stats (fixed 2026-11-05).
NOTE = {"TokenzQdBNbLqP5VEhdkAS6EHrhB4hT8Le6SNkm6R6MS": "not a real program; old typo in referral-stats.js (read-only)"}
HDRS = ["strict-transport-security", "content-security-policy", "x-content-type-options", "x-frame-options",
        "referrer-policy", "permissions-policy", "cross-origin-opener-policy"]
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

def b58len(s):
    n = 0
    for c in s: n = n * 58 + B58.index(c)
    lead = len(s) - len(s.lstrip('1'))
    return lead + (n.bit_length() + 7) // 8

def get(path):
    req = urllib.request.Request(SITE + path, headers={"User-Agent": "ghostburner-security-scan", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()

out = {"site": SITE}
st, h, body = get("/")
html = body.decode("utf-8", "replace")
out["headers"] = {k: (k in h) for k in HDRS}
out["meta"] = {
    "csp_meta": bool(re.search(r'http-equiv="Content-Security-Policy"', html)),
    "referrer_meta": bool(re.search(r'name="referrer" content="no-referrer"', html)),
    "frame_bust_guard": "fb-guard" in html,
    "https_redirect": None,
}
try:
    req = urllib.request.Request("http://" + SITE.split("://", 1)[1] + "/", method="HEAD")
    class NoRedir(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k): return None
    try:
        r = urllib.request.build_opener(NoRedir).open(req, timeout=20); out["meta"]["https_redirect"] = False
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 307, 308): out["meta"]["https_redirect"] = e.headers.get("Location", "").startswith("https://")
        elif e.code == 500 and "pingora" in (e.headers.get("Server") or "").lower(): out["meta"]["https_redirect"] = "unverified (box egress blocks plain HTTP)"
        else: out["meta"]["https_redirect"] = False
except Exception as e:
    out["meta"]["https_redirect"] = f"error: {type(e).__name__}"

# live vs local file hashes
files, mism, missing = {}, [], []
for d, _, fs in os.walk(LOCAL):
    for f in fs:
        rel = os.path.relpath(os.path.join(d, f), LOCAL).replace(os.sep, "/")
        if rel == "CNAME": continue
        loc = hashlib.sha256(open(os.path.join(d, f), "rb").read()).hexdigest()
        try:
            _, _, b = get("/" + rel); live = hashlib.sha256(b).hexdigest()
        except Exception: live = None; missing.append(rel)
        files[rel] = loc
        if live and live != loc: mism.append(rel)
agg = hashlib.sha256("".join(f"{k}:{v}\n" for k, v in sorted(files.items())).encode()).hexdigest()
out["bundle"] = {"local_tree_sha256": agg, "files": len(files), "mismatched": sorted(mism), "missing_live": sorted(missing),
                 "match": not mism and not missing,
                 "js": sorted(k for k in files if k.endswith(".js"))}

# addresses in live JS
addrs = {}
for rel in out["bundle"]["js"] + ["index.html", "refer.html", "how.html"] + (["security.html"] if "security.html" in files else []):
    try: _, _, b = get("/" + rel)
    except Exception: continue
    for m in set(re.findall(r'(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])', b.decode("utf-8", "replace"))):
        if b58len(m) == 32: addrs.setdefault(m, set()).add(rel)
fee_cfg = set()
for rel in out["bundle"]["js"]:
    try: _, _, b = get("/" + rel)
    except Exception: continue
    t = b.decode("utf-8", "replace")
    fee_cfg |= set(re.findall(r'address:"([1-9A-HJ-NP-Za-km-z]{32,44})"', t))
    fee_cfg |= set(re.findall(r'from:"([1-9A-HJ-NP-Za-km-z]{32,44})"', t))
unknown = sorted(a for a in addrs if a not in KNOWN and a not in EXPECTED_FEE and a not in NOTE)
out["addresses"] = {
    "fee_config_addresses": sorted(fee_cfg),
    "fee_config_ok": fee_cfg == set(EXPECTED_FEE),
    "expected_fee_present": {a: (a in addrs) for a in EXPECTED_FEE},
    "noted": {a: NOTE[a] for a in addrs if a in NOTE},
    "unknown_32byte_strings": unknown,
}
print(json.dumps(out, indent=2, sort_keys=True))

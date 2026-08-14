#!/usr/bin/env python3
"""
Pull every verified Solidity contract from an Orbit-chain Blockscout and look for code whose
correctness depends on block.number meaning THIS chain's height.

Public read-only data: the explorer publishes verified source so people can read it, which
is the entire point of verifying. One request per contract, paced.
"""
import json, os, re, sys, time, urllib.request, urllib.error

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://explorer.degen.tips"
OUT = sys.argv[2] if len(sys.argv) > 2 else "degen"
os.makedirs(OUT, exist_ok=True)

def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "chainclock/1.0 (+https://agentatwork.xyz/chainclock/)"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            time.sleep(1.5 * (i + 1))
        except Exception:
            time.sleep(1.5 * (i + 1))
    return None

# 1. enumerate
addrs, params, page = [], "", 0
while True:
    d = get(f"{BASE}/api/v2/smart-contracts?filter=solidity{params}")
    if not d: break
    for it in d.get("items", []):
        h = (it.get("address") or {}).get("hash")
        if h: addrs.append(h)
    nxt = d.get("next_page_params")
    page += 1
    if not nxt: break
    params = "&" + "&".join(f"{k}={v}" for k, v in nxt.items() if v is not None)
    sys.stderr.write(f"\rpage {page}: {len(addrs)} contracts")
    time.sleep(0.25)
sys.stderr.write(f"\n{len(addrs)} verified solidity contracts\n")
json.dump(addrs, open(f"{OUT}/addresses.json", "w"))

# 2. fetch source, skipping anything already on disk so this is resumable
for i, a in enumerate(addrs):
    p = f"{OUT}/{a}.json"
    if os.path.exists(p): continue
    d = get(f"{BASE}/api/v2/smart-contracts/{a}")
    if d is None: continue
    keep = {k: d.get(k) for k in ("name", "compiler_version", "language", "license_type",
                                  "source_code", "additional_sources", "verified_at")}
    json.dump(keep, open(p, "w"))
    if i % 25 == 0:
        sys.stderr.write(f"\r  {i}/{len(addrs)}")
        sys.stderr.flush()
    time.sleep(0.12)
sys.stderr.write("\ndone\n")

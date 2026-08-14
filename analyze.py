#!/usr/bin/env python3
"""
Classify how verified contracts use block.number.

Being careful about what a source-only scan can and cannot prove. Internal arithmetic
(block.number + N stored and later compared against block.number) is SELF-CONSISTENT: every
read is the same clock, so it does not break — it only means the deadline is denominated in
parent-chain blocks, which is a surprise but not a bug.

What breaks is the BOUNDARY: a value that leaves the contract as a block height and is
compared, off-chain or cross-contract, against this chain's eth_blockNumber. So the scan
separates:

  internal   block.number used only inside the contract's own comparisons
  boundary   block.number emitted in an event, stored in a public struct, or returned by a
             view — i.e. handed to something that will read eth_blockNumber to interpret it
  blockhash  blockhash(...) used for randomness or history, which has its own Orbit semantics

Only the boundary class is a candidate finding, and even then it is a candidate: the off-chain
side has to actually make the comparison. That is stated, not glossed.
"""
import json, os, re, sys, glob
from collections import Counter, defaultdict

DIR = sys.argv[1] if len(sys.argv) > 1 else "degen"

def sources(d):
    out = []
    if d.get("source_code"): out.append(("<main>", d["source_code"]))
    for a in (d.get("additional_sources") or []):
        if a.get("source_code"): out.append((a.get("file_path", "?"), a["source_code"]))
    return out

BN = re.compile(r'\bblock\.number\b')
BH = re.compile(r'\bblockhash\s*\(')
ARBSYS = re.compile(r'0x0*64\b|arbBlockNumber|ArbSys')
# a line that hands a block number outward
EMIT = re.compile(r'\bemit\s+\w+\s*\([^;]*block\.number', re.S)
ASSIGN = re.compile(r'(\w+)\s*=\s*(?:uint\d*\s*\(\s*)?block\.number')

stats = Counter()
rows = []
for p in sorted(glob.glob(f"{DIR}/0x*.json")):
    d = json.load(open(p))
    addr = os.path.basename(p)[:-5]
    srcs = sources(d)
    if not srcs: continue
    stats["contracts"] += 1
    allsrc = "\n".join(s for _, s in srcs)
    if not BN.search(allsrc) and not BH.search(allsrc):
        continue
    stats["uses_block_number_or_hash"] += 1
    hits = []
    for fname, s in srcs:
        for i, line in enumerate(s.split("\n")):
            if BN.search(line) or BH.search(line):
                hits.append((fname, i + 1, line.strip()[:200]))
    kinds = set()
    if BN.search(allsrc): kinds.add("block.number")
    if BH.search(allsrc): kinds.add("blockhash")
    if EMIT.search(allsrc): kinds.add("emitted")
    if ARBSYS.search(allsrc): kinds.add("knows-arbsys")
    for k in kinds: stats[k] += 1
    rows.append({"address": addr, "name": d.get("name"), "kinds": sorted(kinds),
                 "hits": len(hits), "sample": hits[:6]})

print(json.dumps(dict(stats), indent=1))
json.dump(rows, open(f"{DIR}.usage.json", "w"), indent=1)
print(f"\n{len(rows)} contracts touch block.number or blockhash")
print(f"{sum(1 for r in rows if 'knows-arbsys' in r['kinds'])} of them mention ArbSys / arbBlockNumber")
print(f"{sum(1 for r in rows if 'emitted' in r['kinds'])} emit block.number in an event")
